// @ts-check
/** MiMo preset TTS, using the person's own key and the existing media landing contract.
 * API: https://mimo.mi.com/docs/zh-CN/api/audio/tts
 * Token Plan and ordinary API credentials have separate endpoints; never retry on another endpoint.
 */
import { billedBy, call, landing, modelOf, needed, text, wavSeconds } from './common.mjs';

const NAME = 'MiMo';
export const MIMO_API_BASE_URL = 'https://api.xiaomimimo.com/v1';
export const MIMO_TOKEN_PLAN_CN_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
/** Preset metadata from MiMo's speech-synthesis guide. The default varies by deployment cluster. */
export const MIMO_VOICE_PRESETS = [
  { voiceId: 'mimo_default', name: 'MiMo-默认', language: null, gender: null, description: 'Default varies by cluster: 冰糖 in China, Mia in other clusters' },
  { voiceId: '冰糖', name: '冰糖', language: 'zh', gender: 'f', description: 'MiMo official Chinese preset' },
  { voiceId: '茉莉', name: '茉莉', language: 'zh', gender: 'f', description: 'MiMo official Chinese preset' },
  { voiceId: '苏打', name: '苏打', language: 'zh', gender: 'm', description: 'MiMo official Chinese preset' },
  { voiceId: '白桦', name: '白桦', language: 'zh', gender: 'm', description: 'MiMo official Chinese preset' },
  { voiceId: 'Mia', name: 'Mia', language: 'en', gender: 'f', description: 'MiMo official English preset' },
  { voiceId: 'Chloe', name: 'Chloe', language: 'en', gender: 'f', description: 'MiMo official English preset' },
  { voiceId: 'Milo', name: 'Milo', language: 'en', gender: 'm', description: 'MiMo official English preset' },
  { voiceId: 'Dean', name: 'Dean', language: 'en', gender: 'm', description: 'MiMo official English preset' },
];
export const MIMO_VOICES = MIMO_VOICE_PRESETS.map((v) => v.voiceId);
export const MIMO_STYLE = '用温暖、从容、自然的普通话，像与创业者面对面交流。数字和专业词语读清楚，适度停顿，避免夸张播音腔，不念出风格指令。';
const MODELS = { tts: [{ id: 'mimo-v2.5-tts', name: 'MiMo V2.5 TTS' }] };

/** Self-describing provider configuration. The base URL is process configuration, never project metadata. */
export const mimoConfigSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'MiMo preset speech configuration', type: 'object', additionalProperties: false,
  properties: {
    baseUrl: { type: 'string', format: 'uri', default: MIMO_API_BASE_URL, description: 'MiMo service base URL, from MIMO_API_BASE_URL in the running Studio process. Ordinary API is the default. Token Plan CN requires its explicit separate endpoint; a request never falls back to another endpoint.' },
    model: { type: 'string', enum: ['mimo-v2.5-tts'], default: 'mimo-v2.5-tts', description: 'Preset speech synthesis model. This adapter does not clone or design a real person’s voice.' },
    voice: { type: 'string', enum: MIMO_VOICES, default: '白桦', description: 'Official preset voice ID; get voice lists these IDs without an audio generation request.' },
    style: { type: 'string', minLength: 1, maxLength: 4000, default: MIMO_STYLE, description: 'Delivery instructions sent as a user message. Spoken text is sent separately as the assistant message and is never automatically rewritten.' },
  },
};

/** @param {string} key */
function baseUrl(key) {
  const configured = process.env.MIMO_API_BASE_URL?.trim();
  let url;
  try { url = new URL(configured || MIMO_API_BASE_URL); } catch { throw new Error('MiMo MIMO_API_BASE_URL is not a valid service URL.'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('MiMo MIMO_API_BASE_URL requires HTTPS (or local HTTP for tests), without credentials, query or fragment.');
  }
  if (key.startsWith('tp-') && !configured) throw new Error('MiMo Token Plan requires an explicit matching MIMO_API_BASE_URL; the ordinary API endpoint was not called.');
  if (key.startsWith('tp-') && url.origin === new URL(MIMO_API_BASE_URL).origin) throw new Error('MiMo Token Plan keys cannot use the ordinary API endpoint. Configure the matching Token Plan endpoint.');
  if (url.origin === new URL(MIMO_TOKEN_PLAN_CN_BASE_URL).origin && !key.startsWith('tp-')) throw new Error('MiMo Token Plan endpoint requires its matching Token Plan key; the ordinary API key was not sent.');
  return url.href.replace(/\/+$/, '');
}

/** Decode only canonical base64; Buffer.from alone silently accepts malformed/truncated input.
 * @param {unknown} raw
 */
function audioBytes(raw) {
  if (typeof raw !== 'string' || !raw.length || raw.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    throw new Error('MiMo answered without valid base64 WAV audio. Nothing landed.');
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.toString('base64') !== raw) throw new Error('MiMo answered with malformed base64 audio. Nothing landed.');
  return bytes;
}

/** Check complete RIFF chunks before using the shared WAV duration reader, which is intentionally lenient.
 * Keep exact PCM source duration; rounding it up could put an out point beyond the decoded file.
 * @param {Buffer} bytes
 */
function audioDuration(bytes) {
  const invalid = () => new Error('MiMo answered with an invalid or truncated PCM WAV. Nothing landed.');
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
  let rate = 0, block = 0, data = 0, formats = 0, samples = 0;
  for (let at = 12; at < bytes.length;) {
    if (at + 8 > bytes.length) throw invalid();
    const id = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4);
    const end = at + 8 + size, next = end + (size & 1);
    if (end > bytes.length || next > bytes.length) throw invalid();
    if (id === 'fmt ') {
      if (++formats !== 1 || size < 16) throw invalid();
      const format = bytes.readUInt16LE(at + 8), channels = bytes.readUInt16LE(at + 10), hz = bytes.readUInt32LE(at + 12), bits = bytes.readUInt16LE(at + 22);
      rate = bytes.readUInt32LE(at + 16); block = bytes.readUInt16LE(at + 20);
      if (![1, 3].includes(format) || !(format === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits) || !channels || !hz || block !== channels * bits / 8 || rate !== hz * block) throw invalid();
    }
    if (id === 'data') { if (++samples !== 1 || !size) throw invalid(); data = size; }
    at = next;
  }
  if (!rate || !data || data % block || wavSeconds(bytes) === null) throw invalid();
  return data / rate;
}

/** @type {import('./contract.mjs').Provider} */
export default {
  id: 'mimo', name: NAME, env: 'MIMO_API_KEY',
  keysUrl: 'https://platform.xiaomimimo.com/', billingUrl: 'https://platform.xiaomimimo.com/',
  verbs: ['voice', 'tts'], models: MODELS,
  async run(verb, args, ctx) {
    if (verb === 'voice') {
      const prompt = text(args.prompt).toLowerCase(), language = text(args.language).toLowerCase(), gender = text(args.gender);
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 5));
      const voices = MIMO_VOICE_PRESETS.filter((v) => (!prompt || `${v.name} ${v.voiceId}`.toLowerCase().includes(prompt))
        && (!language || v.language?.startsWith(language)) && (!gender || v.gender === gender));
      return { files: [], index: [], receipt: { provider: 'mimo', voices: voices.slice(0, limit) } };
    }
    if (verb !== 'tts') throw new Error(`MiMo does not do ${verb}.`);
    const said = needed(args, 'text'), voice = text(args.voice) || '白桦', style = text(args.style) || MIMO_STYLE;
    if (!MIMO_VOICES.includes(voice)) throw new Error('MiMo --voice must be an official preset from get voice.');
    if (style.length > 4000) throw new Error('MiMo --style must be at most 4000 characters.');
    const path = landing('audio/vo', args.out, 'wav'), model = modelOf(MODELS, 'tts', ctx);
    const base = baseUrl(ctx.key);
    try {
      const response = await call(NAME, `${base}/chat/completions`, {
        method: 'POST', redirect: 'error', headers: { 'api-key': ctx.key, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: style }, { role: 'assistant', content: said }], audio: { format: 'wav', voice }, stream: false }),
      }, ctx);
      let body;
      try { body = await response.json(); } catch { throw new Error('MiMo answered without a valid JSON audio response. Nothing landed.'); }
      const choice = body?.choices?.[0];
      if (choice?.finish_reason !== 'stop') throw new Error('MiMo did not finish speech normally (expected finish_reason=stop). Nothing landed; do not treat partial speech as complete.');
      const bytes = audioBytes(choice?.message?.audio?.data), dur = audioDuration(bytes);
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', dur, text: said, voice, from: { mode: 'synth', text: said, voice, style, provider: 'mimo', model } }],
        receipt: { provider: 'mimo', model, src: path, dur, voice, bytes: bytes.length, words: 0, note: 'MiMo does not return word timestamps. Align subtitles against the generated audio; text timing is not measured speech alignment.' },
        cost: billedBy(NAME),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MiMo speech request failed.';
      const safe = new Error(ctx.key ? message.split(ctx.key).join('•••') : message);
      if (error && typeof error === 'object' && 'code' in error) Object.assign(safe, { code: error.code });
      throw safe;
    }
  },
};
