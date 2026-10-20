import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mimo, { mimoConfigSchema, MIMO_API_BASE_URL, MIMO_TOKEN_PLAN_CN_BASE_URL, MIMO_STYLE, MIMO_VOICES } from './mimo.mjs';
import { wav } from './common.mjs';
import { runGet } from '../get.mjs';
import { changeSettings } from '../keys.mjs';

const KEY = 'mimo-test-key-no-real-credential';
const samples = Buffer.alloc(48_002); // 24001 samples: duration deliberately not an exact millisecond.
const AUDIO = Buffer.from(wav(samples, 24_000));
const good = () => ({ choices: [{ finish_reason: 'stop', message: { audio: { data: AUDIO.toString('base64') } } }] });
let server, local, reply;
const calls = [];
const context = (key = KEY) => ({ key, root: '/project', signal: new AbortController().signal, say: () => {}, read: async () => new Uint8Array() });
const args = { out: 'intro', text: '一个人，为什么还要成立公司？', voice: '白桦' };

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const received = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    calls.push(received);
    const [status, body] = reply(received);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  local = `http://127.0.0.1:${server.address().port}/v1`;
});
beforeEach(() => { process.env.MIMO_API_BASE_URL = local; calls.length = 0; reply = () => [200, good()]; });
after(() => { delete process.env.MIMO_API_BASE_URL; server.close(); });

test('MiMo配置Schema可验证，关键字段自描述且不含密钥', () => {
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  const validate = ajv.compile(mimoConfigSchema);
  assert(validate({ baseUrl: MIMO_API_BASE_URL, model: 'mimo-v2.5-tts', voice: '白桦', style: MIMO_STYLE }));
  assert(!validate({ voice: 'not-a-preset' }));
  assert(!validate({ baseUrl: 'invalid', apiKey: KEY }));
  for (const field of Object.values(mimoConfigSchema.properties)) assert(field.description);
});

test('MiMo TTS分开风格与正文，返回严格WAV与精确真实长度，不编造字幕时间戳', async () => {
  const result = await mimo.run('tts', args, context());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v1/chat/completions');
  assert.equal(calls[0].headers['api-key'], KEY);
  assert.deepEqual(calls[0].body, {
    model: 'mimo-v2.5-tts', messages: [{ role: 'user', content: MIMO_STYLE }, { role: 'assistant', content: args.text }],
    audio: { format: 'wav', voice: '白桦' }, stream: false,
  });
  assert.deepEqual(Buffer.from(result.files[0].bytes), AUDIO);
  assert.equal(result.files[0].path, 'assets/audio/vo/intro.wav');
  assert.equal(result.index[0].dur, 24_001 / 24_000);
  assert.equal(result.index[0].words, undefined);
  assert.equal(result.receipt.words, 0);
  assert.match(result.receipt.note, /does not return word timestamps/);
  assert(!JSON.stringify(result).includes(KEY));
});

test('自定义交付风格不进入播报正文，不请求正文润色或真人克隆', async () => {
  await mimo.run('tts', { ...args, style: '像与朋友讲解，数字清晰。' }, context());
  const body = calls[0].body;
  assert.equal(body.messages[0].content, '像与朋友讲解，数字清晰。');
  assert.equal(body.messages[1].content, args.text);
  assert.equal(body.audio.optimize_text_preview, undefined);
  await assert.rejects(mimo.run('tts', { ...args, voice: 'base64-recorded-person' }, context()), /official preset/);
  assert.equal(calls.length, 1);
});

test('列出官方预置音色不触发生成或网络，语言筛选精确', async () => {
  const all = await mimo.run('voice', { limit: 100 }, context());
  assert.deepEqual(all.receipt.voices.map((v) => v.voiceId), MIMO_VOICES);
  assert.deepEqual((await mimo.run('voice', { language: 'en', limit: 100 }, context())).receipt.voices.map((v) => v.voiceId), ['Mia', 'Chloe', 'Milo', 'Dean']);
  assert.deepEqual((await mimo.run('voice', { language: 'zh', gender: 'm', limit: 100 }, context())).receipt.voices.map((v) => v.voiceId), ['苏打', '白桦']);
  assert.equal(calls.length, 0);
});

test('正式get领域路径落盘WAV且保留精确长度，不伪造VTT或把Key写进工程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mimo-get-project-'));
  const home = mkdtempSync(join(tmpdir(), 'mimo-get-settings-'));
  process.env.OPENFILM_HOME = home;
  try {
    await changeSettings((settings) => { settings.keys.mimo = KEY; });
    const receipt = JSON.parse(await runGet(root, 'tts', { ...args, style: '像面向创业者交流。' }, { via: 'mimo', model: 'mimo-v2.5-tts' }));
    assert.equal(receipt.src, 'assets/audio/vo/intro.wav');
    assert.equal(receipt.dur, 24_001 / 24_000);
    assert.match(receipt.transcript, /^none:/);
    assert.deepEqual(readFileSync(join(root, receipt.src)), AUDIO);
    assert.equal(existsSync(join(root, 'assets/audio/vo/intro.vtt')), false);
    assert(!JSON.stringify(receipt).includes(KEY));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.messages[0].content, '像面向创业者交流。');
  } finally {
    delete process.env.OPENFILM_HOME;
    rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test('只接受自然结束，拒绝length/content_filter/缺失finish_reason和HTTP200错误', async () => {
  for (const reason of ['length', 'content_filter', undefined]) {
    reply = () => [200, { choices: [{ finish_reason: reason, message: { audio: { data: AUDIO.toString('base64') } } }] }];
    await assert.rejects(mimo.run('tts', args, context()), /finish_reason=stop/);
  }
  reply = () => [200, { error: { message: `invalid ${KEY}` } }];
  await assert.rejects(mimo.run('tts', args, context()), (e) => !e.message.includes(KEY) && /Nothing landed/.test(e.message));
});

test('拒绝缺失、非法或非canonical base64，不能把错误正文当成音频', async () => {
  for (const data of [undefined, '', 'not audio!', AUDIO.toString('base64').slice(0, -1), 'YR==', Buffer.from('error: invalid key').toString('base64')]) {
    reply = () => [200, { choices: [{ finish_reason: 'stop', message: { audio: { data } } }] }];
    await assert.rejects(mimo.run('tts', args, context()), /Nothing landed/);
  }
});

test('RIFF声明长度/数据块/fmt不完整均拒绝，不能按残留字节计算成成功音频', async () => {
  const badHeader = Buffer.from(AUDIO); badHeader.write('NOPE', 8);
  const badData = Buffer.from(AUDIO); badData.writeUInt32LE(48_000_000, 40);
  const badRate = Buffer.from(AUDIO); badRate.writeUInt32LE(1, 28);
  const badBlock = Buffer.from(AUDIO); badBlock.writeUInt16LE(3, 32);
  for (const bytes of [AUDIO.subarray(0, -2), badHeader, badData, badRate, badBlock, Buffer.concat([AUDIO, Buffer.from('oops')])]) {
    reply = () => [200, { choices: [{ finish_reason: 'stop', message: { audio: { data: bytes.toString('base64') } } }] }];
    await assert.rejects(mimo.run('tts', args, context()), /invalid or truncated PCM WAV/);
  }
});

test('鉴权/余额/配额失败不重试，错误回显去密', async () => {
  for (const [status, body, expected] of [
    [401, { error: { message: `invalid ${KEY}` } }, /did not accept your key/],
    [403, { error: { message: `forbidden ${KEY}` } }, /did not accept your key/],
    [402, {}, /enough balance/],
    [429, { error: { message: `insufficient_quota ${KEY}` } }, /enough balance/],
    [422, { error: { message: `bad request ${KEY}` } }, /bad request •••/],
  ]) {
    const count = calls.length; reply = () => [status, body];
    await assert.rejects(mimo.run('tts', args, context()), (e) => expected.test(e.message) && !e.message.includes(KEY));
    assert.equal(calls.length, count + 1);
  }
});

test('普通API为默认；Token Plan只能显式选择其端点；不会按Key或错误静默换端点', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init) => { urls.push(String(url)); assert.equal(init.redirect, 'error'); return Response.json(good()); };
  try {
    delete process.env.MIMO_API_BASE_URL;
    await mimo.run('tts', args, context());
    assert.deepEqual(urls, [`${MIMO_API_BASE_URL}/chat/completions`]);
    await assert.rejects(mimo.run('tts', args, context('tp-test-no-real-credential')), /explicit matching/);
    process.env.MIMO_API_BASE_URL = MIMO_API_BASE_URL;
    await assert.rejects(mimo.run('tts', args, context('tp-test-no-real-credential')), /cannot use the ordinary/);
    assert.equal(urls.length, 1);
    process.env.MIMO_API_BASE_URL = `${MIMO_TOKEN_PLAN_CN_BASE_URL}/`;
    await assert.rejects(mimo.run('tts', args, context()), /requires its matching Token Plan key/);
    assert.equal(urls.length, 1);
    await mimo.run('tts', args, context('tp-test-no-real-credential'));
    assert.equal(urls.at(-1), `${MIMO_TOKEN_PLAN_CN_BASE_URL}/chat/completions`);
  } finally { globalThis.fetch = originalFetch; }
});

test('不合法服务URL和包含秘密的传输错误不会产生原始凭据日志', async () => {
  for (const url of ['http://example.com/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret']) {
    process.env.MIMO_API_BASE_URL = url;
    await assert.rejects(mimo.run('tts', args, context()), (e) => /MIMO_API_BASE_URL/.test(e.message) && !e.message.includes('secret'));
  }
  process.env.MIMO_API_BASE_URL = local;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error(`transport echoed ${KEY}`); };
  try { await assert.rejects(mimo.run('tts', args, context()), (e) => e.message.includes('•••') && !e.message.includes(KEY)); }
  finally { globalThis.fetch = originalFetch; }
});
