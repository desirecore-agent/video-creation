/** 视频导出的公共参数合同；HTTP、CLI 和 MCP 复用同一校验及帧率语义。 */
import Ajv from 'ajv';

export const videoExportProperties = {
  codec: { enum: ['h264', 'hevc', 'vp9', 'prores422hq', 'prores4444', 'hevc_alpha', 'png'], description: '输出编码及容器档案：h264/hevc 为 MP4，vp9 为 WebM，ProRes/HEVC alpha 为 MOV，png 为透明帧序列 ZIP。' },
  alpha: { type: 'boolean', description: '是否保留透明背景；默认由编码决定，true 仅支持 vp9、prores4444、hevc_alpha、png。' },
  fps: { anyOf: [{ type: 'number', minimum: 1, maximum: 120 }, { enum: ['24000/1001', '30000/1001', '60000/1001'] }], description: '输出帧率，1 到 120。23.976、29.97、59.94 及对应分数写法统一按精确 NTSC 比值取帧。' },
  quality: { enum: ['standard', 'high', 'master'], description: '复用内核的标准、高质量或母版编码档位。' },
  frame: { type: 'string', pattern: '^(native|\\d{1,4}(\\.\\d{1,3})?:\\d{1,4}(\\.\\d{1,3})?)$', description: 'native 保留工程画幅；或宽高比 W:H，范围 1:4 到 4:1。' },
  fill: { enum: ['contain', 'cover'], description: 'contain 保留全画面并补边；cover 填满画幅并裁切。' },
  shortEdge: { type: 'integer', minimum: 64, maximum: 4096, description: '输出短边像素，长边最多 4096；与 width/height、clip 不同时使用。' },
  width: { type: 'integer', minimum: 64, maximum: 4096, multipleOf: 2, description: '输出偶数宽度，必须与 height 一起提供；与 frame/shortEdge/clip/scale 不同时使用。' },
  height: { type: 'integer', minimum: 64, maximum: 4096, multipleOf: 2, description: '输出偶数高度，必须与 width 一起提供；宽高比范围 1:4 到 4:1。' },
  audio: { type: 'boolean', description: '是否混入影片音频；PNG 序列没有音频。' },
  clip: { type: 'string', minLength: 1, maxLength: 200, description: '仅导出这个真实片段 ID，输出从该片段开始；range 此时使用片段本地秒。' },
  scale: { type: 'number', minimum: 0.25, maximum: 4, description: '片段单独输出的像素缩放，仅与 clip 一起使用。' },
  range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 }, description: '输出范围 [起秒,止秒]，止秒必须大于起秒；整片使用工程时间，clip 使用片段本地时间。' },
  samples: { type: 'integer', minimum: 1, maximum: 32, description: '每帧时间采样数；1 不做运动模糊，2 到 32 对快门区间取样平均。' },
  shutter: { type: 'number', minimum: 0, maximum: 1, description: '运动模糊快门占一帧的比例，默认 0.5；必须同时提供 samples。' },
  hardware: { type: 'boolean', description: '是否尝试现有硬件编码器；默认允许，失败沿现有队列回退软件编码。' },
  burnSubtitles: { type: 'boolean', description: '是否将已有字幕烧入画面；不要求影片必须有字幕或口播。' },
  sidecar: { enum: ['srt', 'vtt'], description: '额外导出已有字幕文件。' },
  preset: { type: 'string', maxLength: 60, description: '可选输出用途名称，只影响文件名。' },
  label: { type: 'string', maxLength: 120, description: '这条导出记录的显示名称。' },
};
export const videoExportOptionsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object', additionalProperties: false,
  description: '视频输出参数；参数校验后复用现有固定输入快照与持久导出队列。',
  properties: videoExportProperties,
};
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(videoExportOptionsSchema);
const alphaCodecs = new Set(['vp9', 'prores4444', 'hevc_alpha', 'png']);

/** 将常用 NTSC 简写统一为同一数值，避免用 29.97 求帧、另用 30000/1001 编码。 */
export function videoFps(value) {
  if (value === '24000/1001' || value === 23.976) return 24000 / 1001;
  if (value === '30000/1001' || value === 29.97) return 30000 / 1001;
  if (value === '60000/1001' || value === 59.94) return 60000 / 1001;
  return value;
}

/** 校验且规范单次请求；不安装编码器，不隐式修改工程或重试任务。 */
export function normalizeVideoExportOptions(value = {}) {
  if (!validate(value)) throw new Error(`视频导出参数无效：${ajv.errorsText(validate.errors)}`);
  const ask = { ...value };
  const fail = (message) => { throw new Error(`视频导出参数无效：${message}`); };
  if (ask.range && ask.range[1] <= ask.range[0]) fail('range 的止秒必须大于起秒。');
  if (ask.alpha === true && !alphaCodecs.has(ask.codec ?? 'h264')) fail('alpha=true 需要 vp9、prores4444、hevc_alpha 或 png 编码。');
  if (ask.codec === 'png' && ask.audio === true) fail('PNG 序列没有音频，请关闭 audio 或选择视频编码。');
  if (ask.scale !== undefined && !ask.clip) fail('scale 只用于指定 clip 的输出。');
  if (ask.clip && (ask.frame !== undefined || ask.shortEdge !== undefined || ask.width !== undefined || ask.height !== undefined || ask.fill !== undefined)) fail('clip 输出使用片段原画幅与 scale，不同时接受 frame/fill/shortEdge/width/height。');
  if (ask.shutter !== undefined && ask.samples === undefined) fail('shutter 必须同时提供 samples。');
  if ((ask.width === undefined) !== (ask.height === undefined)) fail('width 和 height 必须一起提供。');
  if (ask.width !== undefined) {
    if (ask.frame !== undefined || ask.shortEdge !== undefined || ask.scale !== undefined) fail('width/height 不与 frame/shortEdge/scale 同时提供。');
    ask.frame = `${ask.width}:${ask.height}`;
    ask.shortEdge = Math.min(ask.width, ask.height);
    delete ask.width; delete ask.height;
  }
  if (ask.frame && ask.frame !== 'native') {
    const [w, h] = ask.frame.split(':').map(Number);
    if (!Number.isFinite(w / h) || w / h < 0.25 || w / h > 4) fail('frame 的宽高比必须在 1:4 到 4:1 之间。');
  }
  if (ask.fps !== undefined) ask.fps = videoFps(ask.fps);
  return ask;
}
