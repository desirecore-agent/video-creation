/** PID slots are reusable; a lock belongs to a process birth, never to a PID alone. */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const INVALID = '应用锁记录损坏，请检查数据目录，不会自动覆盖。';
const RUNNING = '此数据目录的视频创作已在运行，请使用已有实例或另选 --home。';
const UNKNOWN = '无法核验此数据目录的应用锁归属，未覆盖锁；请稍后重试或检查系统进程查询权限。';
const CHANGED = '应用锁已被其他实例更新，未覆盖锁；请重试。';
const PID_MAX = 0x7fffffff;
const MAX_LOCK_BYTES = 4096;
// lstart rounds down to seconds; older filesystems can round file timestamps to two seconds.
const LEGACY_TIMESTAMP_MARGIN_MS = 2_000;
const validPid = (pid) => Number.isInteger(pid) && pid > 0 && pid <= PID_MAX;
const validNonce = (nonce) => typeof nonce === 'string' && /^[a-f0-9]{32}$/.test(nonce);
const validBirth = (birth) => typeof birth === 'string' && (/^(?:darwin|win32):[1-9]\d{0,14}$/.test(birth)
  || /^linux:[0-9a-f-]{36}:pid:\[\d+\]:\d+$/.test(birth));
const execute = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
});

function windowsPowerShell(env, inspect) {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (!root || !isAbsolute(root)) throw new Error('SystemRoot unavailable');
  const directories = [root];
  for (const part of ['System32', 'WindowsPowerShell', 'v1.0']) directories.push(join(directories.at(-1), part));
  for (const path of directories) {
    const info = inspect(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe system directory');
  }
  const file = join(directories.at(-1), 'powershell.exe');
  const info = inspect(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe system executable');
  return file;
}

// Same Get-Process / raw WMI fallback as the host; no localized dates or interpolated command text.
const WINDOWS_BIRTH_SCRIPT = [
  '$ErrorActionPreference = "Stop"', '$t = $null',
  'try { $t = (Get-Process -Id ([int]$env:VIDEO_CREATION_PROCESS_PID) -ErrorAction Stop).StartTime } catch {}',
  'if ($null -ne $t) { ([DateTimeOffset]$t.ToUniversalTime()).ToUnixTimeMilliseconds() } else {'
    + " $d = [string](Get-WmiObject Win32_Process -Filter ('ProcessId=' + [int]$env:VIDEO_CREATION_PROCESS_PID) -ErrorAction Stop).CreationDate;"
    + " if ($d -match '^(\\d{14})\\.(\\d{6})([+-]\\d{3})$') {"
    + " $utc = [DateTime]::ParseExact($Matches[1], 'yyyyMMddHHmmss', [Globalization.CultureInfo]::InvariantCulture)"
    + '.AddTicks([long]$Matches[2] * 10).AddMinutes(0 - [int]$Matches[3]);'
    + ' ([DateTimeOffset]::new($utc.Ticks, [TimeSpan]::Zero)).ToUnixTimeMilliseconds() } }',
].join('; ');

/** Read-only, bounded OS query. Failure is unknown; foreign PID results are never cached. */
export async function readProcessBirth(pid, { platform = process.platform, env = process.env,
  run = execute, read = readFile, link = readlink, inspect = lstatSync } = {}) {
  if (!validPid(pid)) return null;
  try {
    const options = { encoding: 'utf8', timeout: 5_000, maxBuffer: 4096, windowsHide: true,
      env: { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } };
    if (platform === 'win32') {
      const value = String(await run(windowsPowerShell(env, inspect),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', WINDOWS_BIRTH_SCRIPT],
        { ...options, env: { ...options.env, VIDEO_CREATION_PROCESS_PID: String(pid) } })).trim();
      if (!/^[1-9]\d{0,14}$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
      return { identity: `win32:${value}`, startedAtMs: Number(value) };
    }
    if (platform === 'darwin' || platform === 'linux') {
      let identity;
      if (platform === 'linux') {
        const [raw, boot, namespace] = await Promise.all([
          read(`/proc/${pid}/stat`, 'utf8'), read('/proc/sys/kernel/random/boot_id', 'utf8'), link(`/proc/${pid}/ns/pid`),
        ]);
        // comm can itself contain spaces, ')' and line breaks.
        const end = raw.lastIndexOf(')');
        const startTicks = end >= 0 ? raw.slice(end + 2).trim().split(/\s+/)[19] : null;
        if (!/^[0-9a-f-]{36}$/.test(boot.trim()) || !/^pid:\[\d+\]$/.test(namespace) || !/^\d+$/.test(startTicks ?? '')) return null;
        identity = `linux:${boot.trim()}:${namespace}:${startTicks}`;
      }
      // ps provides an epoch lower bound for recovering pre-birth-identity locks.
      // A missing ps does not invalidate Linux's exact kernel identity.
      let startedAtMs = null;
      try {
        const value = String(await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], options)).trim();
        if (/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(value)) {
          const epoch = Date.parse(`${value} GMT`);
          if (Number.isFinite(epoch) && epoch > 0) startedAtMs = epoch;
        }
      } catch { /* no epoch proof; exact Linux birth may still be usable */ }
      if (platform === 'darwin' && startedAtMs !== null) identity = `darwin:${startedAtMs}`;
      return identity ? { identity, startedAtMs } : null;
    }
  } catch { /* Never return command output, environment or OS exception text. */ }
  return null;
}

function sameFile(a, b) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].every((field) => a[field] === b[field]);
}

function snapshot(path) {
  let fd;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOCK_BYTES) throw new Error(INVALID);
    fd = openSync(path, 'r');
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_LOCK_BYTES || !sameFile(before, info)) throw new Error(CHANGED);
    // One overflow byte detects growth without allowing a raced file to cause an unbounded read.
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_LOCK_BYTES || !sameFile(info, fstatSync(fd)) || !sameFile(info, lstatSync(path))) throw new Error(CHANGED);
    const bytes = buffer.toString('utf8', 0, length);
    let record;
    try { record = JSON.parse(bytes); } catch { throw new Error(INVALID); }
    if (!record || typeof record !== 'object' || !validPid(record.pid) || !validNonce(record.nonce)
      || (record.birth !== undefined && !validBirth(record.birth))) throw new Error(INVALID);
    return { record, bytes, info };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if ([INVALID, CHANGED].includes(error.message)) throw error;
    throw new Error(UNKNOWN);
  } finally { if (fd !== undefined) closeSync(fd); }
}

function matches(path, expected) {
  const actual = snapshot(path);
  return actual !== null && actual.record.nonce === expected.record.nonce
    && actual.bytes === expected.bytes && sameFile(actual.info, expected.info);
}

async function assess(old, { readBirth = readProcessBirth, probePid = (pid) => process.kill(pid, 0) } = {}) {
  try { probePid(old.record.pid); }
  catch (error) {
    if (error.code === 'ESRCH') return { state: 'stale', reason: 'process-exited' };
    if (error.code !== 'EPERM') return { state: 'unknown', reason: 'process-query-failed' };
  }
  let current;
  try { current = await readBirth(old.record.pid); } catch { /* unknown */ }
  if (!current || !validBirth(current.identity)) return { state: 'unknown', reason: 'birth-unavailable' };
  if (old.record.birth !== undefined) {
    if (old.record.birth.split(':')[0] !== current.identity.split(':')[0]) return { state: 'unknown', reason: 'birth-platform-mismatch' };
    return current.identity === old.record.birth ? { state: 'running', reason: 'same-process-birth' }
      : { state: 'stale', reason: 'different-process-birth' };
  }
  const writtenAt = old.info.mtimeMs;
  return Number.isFinite(current.startedAtMs) && current.startedAtMs > writtenAt + LEGACY_TIMESTAMP_MARGIN_MS
    ? { state: 'stale', reason: 'legacy-pid-reused' } : { state: 'unknown', reason: 'legacy-birth-unproven' };
}

/** Inspect an existing lock without changing it or signalling its PID. */
export async function inspectApplicationLock(path, options = {}) {
  const old = snapshot(path);
  return old ? { ...await assess(old, options), pid: old.record.pid } : { state: 'missing' };
}

/** Retain wx exclusion, and reread both nonce/content and file identity before reclaim or release. */
export async function acquireApplicationLock(home, { pid = process.pid, nonce = randomBytes(16).toString('hex'),
  readBirth = readProcessBirth, probePid } = {}) {
  const path = join(home, 'application.lock');
  let ownBirth;
  try { ownBirth = await readBirth(pid); } catch { /* unknown */ }
  if (!validPid(pid) || !validNonce(nonce) || !validBirth(ownBirth?.identity)) throw new Error(UNKNOWN);
  const old = snapshot(path);
  if (old) {
    const result = await assess(old, { readBirth, probePid });
    if (result.state === 'running') throw new Error(RUNNING);
    if (result.state !== 'stale') throw new Error(UNKNOWN);
    // No asynchronous work between this final ownership check, unlink and exclusive creation.
    if (!matches(path, old)) throw new Error(CHANGED);
    unlinkSync(path);
  }
  try { writeFileSync(path, JSON.stringify({ pid, nonce, birth: ownBirth.identity }), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error(CHANGED); }
  const owned = snapshot(path);
  if (!owned || owned.record.nonce !== nonce || owned.record.pid !== pid) throw new Error(CHANGED);
  return () => {
    try { if (matches(path, owned)) unlinkSync(path); } catch { /* Never remove a successor's lock. */ }
  };
}
