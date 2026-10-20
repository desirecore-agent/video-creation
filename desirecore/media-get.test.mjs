import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectClient } from './client.mjs';
import { argumentsOf } from './cli.mjs';

async function fixture(t, response) {
  const home = mkdtempSync(join(tmpdir(), 'video-media-client-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'run.json'), JSON.stringify({ origin: 'http://127.0.0.1:12345', key: 'a'.repeat(48) }));
  const calls = [];
  const request = async (url, options) => {
    if (url.pathname === '/api/health') return Response.json({ product: 'video-creation-studio', home: createHash('sha256').update(resolve(home)).digest('hex') });
    if (url.pathname === '/api/projects') return Response.json({ project: { id: 'film', path: '/project actual' } });
    calls.push({ url, options, body: options.body && JSON.parse(options.body) });
    return response(url, options);
  };
  return { client: await projectClient({ home }, '/original', { request }), calls };
}

test('get CLI原样保留JSON参数路径与明确provider/model，不接受密钥开关', () => {
  const result = argumentsOf(['get', '工程 有空格', 'tts', '--args', '语音 参数.json', '--via', 'mimo', '--model', 'mimo-v2.5-tts', '--home', 'app data']);
  assert.deepEqual(result.positionals, ['get', '工程 有空格', 'tts']);
  assert.equal(result.values.args, '语音 参数.json');
  assert.equal(result.values.via, 'mimo');
  assert.equal(result.values.model, 'mimo-v2.5-tts');
  assert.throws(() => argumentsOf(['get', '/project', 'tts', '--api-key', 'not-a-key']), /Unknown option/);
});

test('受管媒体client只转发已有get合同，使用注册后真实工程路径和回执', async (t) => {
  const receipt = { ok: true, text: '{"provider":"mimo","src":"assets/audio/vo/intro.wav","dur":1.01}' };
  const { client, calls } = await fixture(t, () => Response.json(receipt));
  const args = { out: 'intro', text: '为什么成立公司？', voice: '白桦', style: '自然从容。' };
  assert.deepEqual(await client.getMedia('tts', args, { via: 'mimo', model: 'mimo-v2.5-tts' }), receipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/get');
  assert.deepEqual(calls[0].body, { folder: '/project actual', verb: 'tts', args, via: 'mimo', model: 'mimo-v2.5-tts' });
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
});

test('能力目录只读，领域失败保留退出信息且不重复付费调用', async (t) => {
  const failure = { ok: false, code: 2, text: 'tts has no --unknown' };
  const { client, calls } = await fixture(t, (url) => Response.json(url.search ? { verbs: [] } : failure));
  assert.deepEqual(await client.mediaCatalog('tts'), { verbs: [] });
  assert.equal(calls[0].url.search, '?verb=tts');
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(await client.getMedia('tts', { unknown: true }), failure);
  assert.equal(calls.length, 2);
});

test('媒体提交传输失败说明回执未知，保持一次调用', async (t) => {
  const { client, calls } = await fixture(t, () => { throw new Error('socket closed'); });
  await assert.rejects(client.getMedia('tts', { text: 'hello' }), /结果未知.*勿直接重复付费调用/);
  assert.equal(calls.length, 1);
});

test('正式CLI get跨HTTP传输JSON并保留成功/领域失败退出码，不另外启动服务', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'video-media-cli-'));
  const calls = [];
  let answer = { ok: true, text: '{"src":"assets/audio/vo/intro.wav","dur":1.01}' };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const path = new URL(req.url, 'http://local').pathname;
    let body;
    if (path === '/api/health') body = { product: 'video-creation-studio', home: createHash('sha256').update(resolve(home)).digest('hex') };
    else if (path === '/api/projects') body = { project: { id: 'film', path: '/registered project' } };
    else {
      calls.push({ method: req.method, path, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
      body = path === '/api/get' && req.method === 'GET' ? { verbs: ['tts'] } : answer;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(join(home, 'run.json'), JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, key: 'a'.repeat(48) }));
  const parameters = { out: 'intro', text: '为什么成立公司？', voice: '白桦', style: '温暖自然。' };
  const parametersPath = join(home, '语音 参数.json'); writeFileSync(parametersPath, JSON.stringify(parameters));
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const run = (args) => new Promise((done) => execFile(process.execPath, [cli, 'get', '/initial project', ...args, '--home', home], { encoding: 'utf8' }, (error, stdout, stderr) => done({ status: error?.code ?? 0, stdout, stderr })));
  const options = ['tts', '--args', parametersPath, '--via', 'mimo', '--model', 'mimo-v2.5-tts'];
  const success = await run(options);
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout), answer);
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/get', body: { folder: '/registered project', verb: 'tts', args: parameters, via: 'mimo', model: 'mimo-v2.5-tts' } });
  answer = { ok: false, code: 2, text: 'invalid option' };
  const failure = await run(options);
  assert.equal(failure.status, 2);
  assert.deepEqual(JSON.parse(failure.stdout), answer);
  const catalog = await run([]);
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.deepEqual(JSON.parse(catalog.stdout), { verbs: ['tts'] });
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'POST', 'GET']);
});
