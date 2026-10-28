import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { localJsonRequest, MAX_LOCAL_JSON_BYTES } from './local-json-request.mjs';
import { projectClient } from './client.mjs';

/** 私有回环HTTP夹具只验证传输，不执行媒体、不冒充真实原片。 */
async function localServer(t, handler) {
  const sockets = new Set();
  const server = createServer(handler);
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  });
  return { origin, url: (path) => new URL(path, origin) };
}

test('本地长JSON请求等待迟到的响应头并保持HTTP状态、正文和鉴权', async (t) => {
  const server = await localServer(t, (req, res) => {
    assert.equal(req.headers['x-studio-key'], 'fixture-only');
    setTimeout(() => { res.writeHead(422, { 'content-type': 'application/json' }); res.end('{"error":"素材不可处理"}'); }, 60);
  });
  const start = Date.now();
  const response = await localJsonRequest(server.url('/prepare'), { method: 'POST', headers: { 'x-studio-key': 'fixture-only' }, body: '{}' });
  assert.ok(Date.now() - start >= 50);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: '素材不可处理' });
});

test('本地长请求拒绝重定向，不向其目标转交鉴权', async (t) => {
  let destination = 0;
  const server = await localServer(t, (req, res) => {
    if (req.url === '/target') { destination += 1; res.end('{}'); }
    else { res.writeHead(302, { location: '/target' }); res.end(); }
  });
  await assert.rejects(localJsonRequest(server.url('/redirect'), { headers: { 'x-studio-key': 'fixture-only' } }), /拒绝重定向/);
  assert.equal(destination, 0);
});

test('本地长请求拒绝声明或实际超预算的响应', async (t) => {
  const server = await localServer(t, (req, res) => {
    if (req.url === '/declared') { res.writeHead(200, { 'content-length': MAX_LOCAL_JSON_BYTES + 1 }); res.end('x'); }
    else { res.writeHead(200); res.end(Buffer.alloc(MAX_LOCAL_JSON_BYTES + 1, 120)); }
  });
  await assert.rejects(localJsonRequest(server.url('/declared')), /超出回执预算/);
  await assert.rejects(localJsonRequest(server.url('/actual')), /超出回执预算/);
});

test('响应头前取消只关闭该请求，其他本地请求仍可完成', async (t) => {
  let closed;
  const closedPromise = new Promise((done) => { closed = done; });
  const server = await localServer(t, (req, res) => {
    if (req.url === '/hang') res.once('close', closed);
    else res.end('{"ok":true}');
  });
  const controller = new AbortController();
  const pending = localJsonRequest(server.url('/hang'), { signal: controller.signal });
  const other = localJsonRequest(server.url('/other'));
  const timer = setTimeout(() => controller.abort(new DOMException('取消此请求', 'AbortError')), 30);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, { name: 'AbortError' });
  await closedPromise;
  assert.deepEqual(await (await other).json(), { ok: true });
});

test('响应体读取期间取消不返回半份JSON', async (t) => {
  const controller = new AbortController();
  const server = await localServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"pending":');
    setTimeout(() => controller.abort(new DOMException('取消读取', 'AbortError')), 20);
  });
  await assert.rejects(localJsonRequest(server.url('/body'), { signal: controller.signal }), { name: 'AbortError' });
});

test('服务中途断开明确拒绝，空204仍是合法Response', async (t) => {
  const server = await localServer(t, (req, res) => {
    if (req.url === '/empty') { res.writeHead(204); res.end(); }
    else { res.writeHead(200); res.write('{'); res.destroy(); }
  });
  await assert.rejects(localJsonRequest(server.url('/broken')));
  const empty = await localJsonRequest(server.url('/empty'));
  assert.equal(empty.status, 204); assert.equal(await empty.text(), '');
});

test('非回环、带身份或片段的地址及未序列化正文在出站前拒绝', async () => {
  for (const value of ['https://127.0.0.1:1234/api/x', 'http://localhost:1234/api/x', 'http://127.0.0.1/api/x', 'http://name:secret@127.0.0.1:1234/api/x', 'http://127.0.0.1:1234/api/x#fragment'])
    await assert.rejects(localJsonRequest(new URL(value)), /回环 HTTP/);
  await assert.rejects(localJsonRequest(new URL('http://127.0.0.1:1234/api/x'), { body: new Uint8Array() }), /序列化/);
  const cancelled = new AbortController(); cancelled.abort(new DOMException('已取消', 'AbortError'));
  await assert.rejects(localJsonRequest(new URL('http://127.0.0.1:1234/api/x'), { signal: cancelled.signal }), { name: 'AbortError' });
});

test('prepareMedia保持现有自定义request注入及HTTP错误合同', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'local-long-injected-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'run.json'), JSON.stringify({ origin: 'http://127.0.0.1:1234/', key: 'a'.repeat(48) }));
  const calls = [];
  const request = async (url, init) => {
    calls.push({ path: url.pathname, method: init.method, signal: init.signal });
    if (url.pathname === '/api/health') return Response.json({ product: 'video-creation-studio', home: createHash('sha256').update(resolve(home)).digest('hex') });
    if (url.pathname === '/api/projects') return Response.json({ project: { id: 'fixture', path: home } });
    return Response.json({ error: '源已改变', code: 'fixture-conflict' }, { status: 409 });
  };
  const client = await projectClient({ home }, home, { request });
  await assert.rejects(client.prepareMedia({ src: 'assets/test.mp4' }), (error) => error.status === 409 && error.details.code === 'fixture-conflict');
  assert.deepEqual(calls.map((x) => x.path), ['/api/health', '/api/projects', '/api/projects/fixture/media/prepare']);
  assert.ok(calls.every((x) => x.signal instanceof AbortSignal));
});
