import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { acquireApplicationLock, inspectApplicationLock, readProcessBirth } from './application-lock.mjs';

const roots = [];
const nonce = 'a'.repeat(32), successorNonce = 'b'.repeat(32);
const birth = { identity: 'win32:1792298809118', startedAtMs: 1792298809118 };
const priorBirth = 'win32:1792298200000';
const pid = 10692;
const probePid = () => {};
function fixture(record = { pid, nonce, birth: priorBirth }) {
  const home = mkdtempSync(join(tmpdir(), 'video-lock-')); roots.push(home);
  const path = join(home, 'application.lock');
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record));
  return { home, path };
}
const readBirth = async () => birth;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('different birth at the same live PID reclaims only the old lock and records the new birth', async () => {
  const { home, path } = fixture();
  const release = await acquireApplicationLock(home, { pid, nonce: successorNonce, readBirth, probePid });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { pid, nonce: successorNonce, birth: birth.identity });
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  release();
  assert.equal((await inspectApplicationLock(path)).state, 'missing');
});

test('same live process birth refuses a second launch and leaves the owner lock unchanged', async () => {
  const { home, path } = fixture({ pid, nonce, birth: birth.identity });
  const before = readFileSync(path, 'utf8');
  await assert.rejects(acquireApplicationLock(home, { pid, readBirth, probePid }), /已在运行/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('legacy Windows PID-reuse evidence recovers the exact old lock chronology without signalling its new owner', async () => {
  // Recorded win-test regression: Node lock 04:37:07.177Z, PID 10692 later belongs to conhost.exe,
  // whose kernel StartTime is 04:46:49.118Z (after TaskHost stop and platform exit).
  const { home, path } = fixture({ pid, nonce });
  const oldWrite = new Date('2026-10-18T04:37:07.177Z');
  const currentBirth = { identity: `win32:${Date.parse('2026-10-18T04:46:49.118Z')}`, startedAtMs: Date.parse('2026-10-18T04:46:49.118Z') };
  utimesSync(path, oldWrite, oldWrite);
  const before = readFileSync(path, 'utf8');
  let probes = 0;
  const options = { readBirth: async () => currentBirth, probePid: (actual) => { assert.equal(actual, pid); probes += 1; } };
  assert.deepEqual(await inspectApplicationLock(path, options), { state: 'stale', reason: 'legacy-pid-reused', pid });
  assert.equal(readFileSync(path, 'utf8'), before);
  const release = await acquireApplicationLock(home, { ...options, pid, nonce: successorNonce });
  assert.equal(probes, 2);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).birth, currentBirth.identity);
  release();
});

test('legacy timestamp precision and an older live birth cannot prove PID reuse', async () => {
  const { home, path } = fixture({ pid, nonce });
  const mtime = statSync(path).mtimeMs;
  for (const startedAtMs of [mtime - 10_000, mtime, mtime + 1_999]) {
    await assert.rejects(acquireApplicationLock(home, { pid, probePid, readBirth: async () => ({ ...birth, startedAtMs }) }), /无法核验/);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { pid, nonce });
  }
});

test('ESRCH reclaims an exited owner; EPERM needs birth proof and never implies death', async () => {
  const { home, path } = fixture();
  const denied = () => { throw Object.assign(new Error('private command output'), { code: 'EPERM' }); };
  await assert.rejects(acquireApplicationLock(home, { pid, probePid: denied, readBirth: async () => null }), /无法核验/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).nonce, nonce);
  const release = await acquireApplicationLock(home, { pid, nonce: successorNonce, readBirth,
    probePid: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); } });
  release();
});

test('unknown birth, failed query and unsupported birth platform leave the lock intact with sanitized errors', async () => {
  for (const query of [async () => null, async () => { throw new Error('PRIVATE_TOKEN'); }, async () => ({ identity: 'darwin:1792298809118' })]) {
    const { home, path } = fixture();
    let calls = 0;
    const before = readFileSync(path, 'utf8');
    await assert.rejects(acquireApplicationLock(home, { pid, probePid, readBirth: async () => ++calls === 1 ? birth : query() }),
      (error) => /无法核验/.test(error.message) && !error.message.includes('PRIVATE_TOKEN'));
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test('malformed records are never silently replaced', async () => {
  for (const record of ['{', { pid: -1, nonce }, { pid, nonce: '' }, { pid, nonce: [nonce] }, { pid, nonce, birth: 'win32:garbage' }]) {
    const { home, path } = fixture(record);
    const before = readFileSync(path, 'utf8');
    await assert.rejects(acquireApplicationLock(home, { pid, readBirth, probePid }), /记录损坏/);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test('nonce replacement during birth corroboration survives stale reclaim and release', async () => {
  const { home, path } = fixture();
  let calls = 0;
  const successor = { pid, nonce: successorNonce, birth: birth.identity };
  await assert.rejects(acquireApplicationLock(home, { pid, probePid, readBirth: async () => {
    if (++calls === 2) writeFileSync(path, JSON.stringify(successor));
    return birth;
  } }), /其他实例更新/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), successor);
  rmSync(path);
  const ownRelease = await acquireApplicationLock(home, { pid, readBirth });
  writeFileSync(path, JSON.stringify(successor));
  ownRelease();
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), successor);
});

test('a replacement file with identical bytes and nonce is not unlinked', async () => {
  const { home, path } = fixture();
  const before = readFileSync(path, 'utf8');
  let calls = 0;
  await assert.rejects(acquireApplicationLock(home, { pid, probePid, readBirth: async () => {
    if (++calls === 2) { renameSync(path, `${path}.old`); writeFileSync(path, before); }
    return birth;
  } }), /其他实例更新/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('growth between stat and open is rejected before reading; growth during reading stays bounded', async (t) => {
  const { path } = fixture();
  const initial = readFileSync(path, 'utf8');
  const grown = initial + ' '.repeat(8192);
  const originalOpen = fs.openSync, originalRead = fs.readSync;
  let reads = 0;
  try {
    t.mock.method(fs, 'openSync', (...args) => {
      const fd = originalOpen(...args);
      if (args[0] === path && args[1] === 'r') writeFileSync(path, grown);
      return fd;
    });
    t.mock.method(fs, 'readSync', (...args) => { reads += 1; return originalRead(...args); });
    syncBuiltinESMExports();
    await assert.rejects(inspectApplicationLock(path, { readBirth, probePid }), /其他实例更新/);
    assert.equal(reads, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  writeFileSync(path, initial);
  let bytesRead = 0;
  try {
    t.mock.method(fs, 'readSync', (...args) => {
      assert.ok(args[3] <= 4097);
      writeFileSync(path, grown);
      const count = originalRead(...args);
      bytesRead += count;
      return count;
    });
    syncBuiltinESMExports();
    await assert.rejects(inspectApplicationLock(path, { readBirth, probePid }), /其他实例更新/);
    assert.equal(bytesRead, 4097);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(path, 'utf8'), grown);
});

test('the actual local OS birth corroborates this running process and refuses a live lock', async () => {
  const actual = await readProcessBirth(process.pid);
  assert.ok(actual, `supported runner ${process.platform} must expose its process birth`);
  const { home, path } = fixture({ pid: process.pid, nonce, birth: actual.identity });
  assert.equal((await inspectApplicationLock(path)).state, 'running');
  await assert.rejects(acquireApplicationLock(home), /已在运行/);
});

const systemEntry = { isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false };
test('Windows query uses a fixed trusted system path, numeric PID environment and bounded no-profile argv', async () => {
  let call;
  const systemRoot = join(tmpdir(), 'system-windows');
  const result = await readProcessBirth(pid, { platform: 'win32', env: { SystemRoot: systemRoot }, inspect: () => systemEntry,
    run: async (...args) => { call = args; return '1792298809118\r\n'; } });
  assert.deepEqual(result, birth);
  assert.equal(call[0], join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.equal(call[2].timeout, 5000);
  assert.equal(call[2].maxBuffer, 4096);
  assert.equal(call[2].env.VIDEO_CREATION_PROCESS_PID, String(pid));
  assert.ok(call[1].includes('-NoProfile'));
  assert.ok(call[1].includes('-NonInteractive'));
  assert.ok(call[1].at(-1).includes('Get-WmiObject Win32_Process'));
  assert.ok(!call[1].at(-1).includes(String(pid)));
  assert.equal(await readProcessBirth('1;evil', { platform: 'win32', run: async () => assert.fail('invalid PID executed') }), null);
});

test('OS failures, malformed output, absent proc and unsafe Windows tool paths remain unknown', async () => {
  for (const output of ['', 'not-a-date', '0', '1792298809118\nextra']) {
    assert.equal(await readProcessBirth(pid, { platform: 'win32', env: { SystemRoot: '/system/windows' }, inspect: () => systemEntry, run: async () => output }), null);
  }
  assert.equal(await readProcessBirth(pid, { platform: 'darwin', run: async () => { throw Object.assign(new Error('PRIVATE'), { code: 'ETIMEDOUT' }); } }), null);
  assert.equal(await readProcessBirth(pid, { platform: 'linux', read: async () => { throw new Error('no proc'); } }), null);
  assert.equal(await readProcessBirth(pid, { platform: 'win32', env: { SystemRoot: '/system/windows' }, inspect: () => ({ ...systemEntry, isSymbolicLink: () => true }), run: async () => assert.fail('unsafe path executed') }), null);
});

test('Linux birth includes kernel boot and PID namespace; command parentheses cannot shift start ticks', async () => {
  const fields = Array(30).fill('0'); fields[0] = 'S'; fields[19] = '123456';
  const bootId = '12345678-1234-1234-1234-123456789abc';
  const result = await readProcessBirth(pid, { platform: 'linux',
    read: async (path) => path.endsWith('/stat') ? `${pid} (a ) b\n) ${fields.join(' ')}` : bootId,
    link: async () => 'pid:[1234]', run: async () => 'Sun Oct 18 04:46:49 2026\n' });
  assert.deepEqual(result, { identity: `linux:${bootId}:pid:[1234]:123456`, startedAtMs: Date.parse('2026-10-18T04:46:49Z') });
  const withoutPs = await readProcessBirth(pid, { platform: 'linux',
    read: async (path) => path.endsWith('/stat') ? `${pid} (node) ${fields.join(' ')}` : bootId,
    link: async () => 'pid:[1234]', run: async () => { throw Object.assign(new Error('no ps'), { code: 'ENOENT' }); } });
  assert.deepEqual(withoutPs, { identity: result.identity, startedAtMs: null });
});
