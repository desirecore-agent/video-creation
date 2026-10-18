import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:http';
import { projectClient } from './client.mjs';

const nativeNavigation = (url, headers) => new Promise((done, fail) => {
  get(url, { headers }, (response) => { response.resume(); response.once('end', () => done({ status: response.statusCode, headers: response.headers })); }).on('error', fail);
});

test('真实受管服务隔离数据、签入、导演上下文与HTTP编辑共用同一影片版本', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'video-service-'));
  const project = join(home, 'projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'film.html'), '<meta name="viewport" content="width=640, height=360"><section><iframe id="intro" src="scene.html#t=0,1"></iframe></section>');
  writeFileSync(join(project, 'scene.html'), '<div id="title">样例</div><script>window.film={duration:1,frame(t){}}</script>');
  writeFileSync(join(home, 'runtime-config.json'), '{"directorAgentId":"installed-director-test"}');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'start', '--home', join(home, 'ignored-candidate'), '--project', project, '--no-browser'], {
    env: { ...process.env, APP_DATA_DIR: home, PORT: '0', DESIRECORE_APP_RUNTIME_PROOF: 'test-only-process-proof', DESIRECORE_APP_RELEASE_DIGEST: 'a'.repeat(64), DESIRECORE_APP_SCOPE_ID: 'test-installation', DESIRECORE_APP_RUNTIME_GENERATION: 'test-generation' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    const lines = createInterface({ input: child.stdout });
    const descriptor = await Promise.race([
      once(lines, 'line').then(([line]) => JSON.parse(line)),
      exited.then(([code]) => { throw new Error(`服务启动失败 ${code}: ${errors}`); }),
    ]);
    lines.close();
    assert.equal(descriptor.home, home);
    const identity = await fetch(`${descriptor.origin}/api/desirecore/runtime-identity`);
    assert.equal(identity.headers.get('cache-control'), 'no-store');
    assert.equal((await identity.json()).runtimeGeneration, 'test-generation');
    const anonymous = await fetch(`${descriptor.origin}/api/desirecore/context`);
    assert.equal(anonymous.status, 401);
    const framed = await nativeNavigation(descriptor.origin, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' });
    assert.equal(framed.status, 200);
    assert.equal(framed.headers['set-cookie'], undefined);
    const bootstrap = await nativeNavigation(descriptor.origin, { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' });
    assert.equal(bootstrap.status, 302);
    assert.equal(bootstrap.headers['cache-control'], 'no-store');
    const run = JSON.parse(readFileSync(join(home, 'run.json'), 'utf8'));
    const context = await fetch(`${descriptor.origin}/api/desirecore/context`, { headers: { 'x-studio-key': run.key } });
    assert.equal((await context.json()).directorAgentId, 'installed-director-test');
    const client = await projectClient({ home }, project);
    const original = await client.inspect();
    const manual = await client.patch(original.rev, [{ op: 'set', clip: 'intro', field: 'overrides', value: [{ at: '#title', text: '人工修改' }] }]);
    await assert.rejects(client.patch(original.rev, [{ op: 'set', clip: 'intro', field: 'overrides', value: [] }]), (error) => error.status === 409);
    assert.equal((await client.inspect()).rev, manual.rev);
  } finally {
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
});

test('真实服务拒绝同一存活实例，强制结束残留锁后可自动重新启动', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'video-service-restart-'));
  const project = join(home, 'projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'film.html'), '<meta name="viewport" content="width=640, height=360"><section><iframe id="intro" src="scene.html#t=0,1"></iframe></section>');
  writeFileSync(join(project, 'scene.html'), '<script>window.film={duration:1,frame(t){}}</script>');
  const children = [];
  const launch = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'start', '--home', home, '--project', project, '--port', '0', '--no-browser'], {
      env: { ...process.env, APP_DATA_DIR: home, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const lines = createInterface({ input: child.stdout });
    const started = Promise.race([
      once(lines, 'line').then(([line]) => JSON.parse(line)),
      exited.then(([code]) => { throw new Error(`服务启动失败 ${code}: ${errors}`); }),
    ]).finally(() => lines.close());
    const entry = { child, exited, started };
    children.push(entry);
    return entry;
  };
  try {
    const first = launch();
    const descriptor = await first.started;
    const firstLock = JSON.parse(readFileSync(join(home, 'application.lock'), 'utf8'));
    assert.equal(firstLock.pid, descriptor.pid);
    assert.match(firstLock.birth, /^(darwin|win32|linux):/);
    const duplicate = launch();
    await assert.rejects(duplicate.started, /已在运行/);
    assert.equal(readFileSync(join(home, 'application.lock'), 'utf8'), JSON.stringify(firstLock));
    first.child.kill('SIGKILL');
    await first.exited;
    assert.equal(readFileSync(join(home, 'application.lock'), 'utf8'), JSON.stringify(firstLock));
    const restarted = launch();
    const nextDescriptor = await restarted.started;
    const nextLock = JSON.parse(readFileSync(join(home, 'application.lock'), 'utf8'));
    assert.equal(nextLock.pid, nextDescriptor.pid);
    assert.notEqual(nextLock.nonce, firstLock.nonce);
    assert.equal((await fetch(`${nextDescriptor.origin}/api/health`)).ok, true);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(({ exited }) => exited));
    rmSync(home, { recursive: true, force: true });
  }
});
