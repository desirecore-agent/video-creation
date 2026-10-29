// @ts-check
/** 只读投影现有字幕样式的实际计算值；不保存样式、不测DOM，也不创建另一套布局。 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILM_FILE, readFilmFile } from '../../src/film-doc.mjs';
import { filmSubtitleFontSizePx, filmSubtitleStyleFor, parseFilmSubtitleStyle } from './film-subtitle.mjs';
import { HttpError } from './http.mjs';
import { TOOL_DIR } from './projects.mjs';

export const SUBTITLE_STYLE_FILE = `${TOOL_DIR}/subtitles.json`;

const nullableNumber = (/** @type {string} */ description) => ({ type: ['number', 'null'], description });
const digestSchema = { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$', description: '同次实际读取的原始文件字节SHA-256；缺失为null。' };
const fileSchema = {
  type: 'object', additionalProperties: false, required: ['path', 'status', 'bytes', 'sha256'],
  properties: {
    path: { type: 'string', description: '项目内的固定来源相对路径，不是额外读取权限。' },
    status: { enum: ['present', 'absent', 'invalid'], description: '文件存在、缺失或内容不符合原读取合同；invalid仍保留原字节摘要。' },
    bytes: { type: ['integer', 'null'], minimum: 0, description: '本次原始文件字节数；文件缺失为null。' },
    sha256: digestSchema,
    revision: { type: ['string', 'null'], pattern: '^[a-f0-9]{16}$', description: '有效UTF-8影片原文的版本前缀；缺失或不可解码为null。' },
    usingDefault: { type: 'boolean', description: '样式缺失或非有效JSON对象时，服务端沿既有默认值渲染，不回写文件。' },
  },
};
export const SUBTITLE_LAYOUT_RESPONSE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, required: ['style', 'layout'],
  description: 'GET subtitles的兼容只读响应。style保持原有规范化保存样式或null，layout是服务端导出/工程审片的计算投影，不是浏览器草稿或像素测量。',
  properties: {
    style: { type: ['object', 'null'], additionalProperties: true, description: '原GET已有字段：按既有parseFilmSubtitleStyle读取的保存样式；缺失或非JSON对象仍为null。' },
    layout: {
      type: 'object', additionalProperties: false,
      required: ['status', 'stage', 'effectiveStyle', 'fontSizePx', 'positionPolicy', 'source', 'limitations'],
      description: '由本次同源film舞台和字幕样式计算；前后文件不同返回409而不混用版本。',
      properties: {
        status: { enum: ['computed', 'unknown'], description: 'computed只表示原渲染辅助函数的计算结果，不表示字幕已绘制或安全区通过。' },
        reason: { type: 'string', description: '无法计算舞台时的明确原因；不猜默认影片尺寸。' },
        stage: { type: ['object', 'null'], additionalProperties: false, required: ['w', 'h'], description: '本次有效film.html的舞台像素尺寸；未知为null。', properties: { w: { type: 'number', exclusiveMinimum: 0, description: '舞台宽。' }, h: { type: 'number', exclusiveMinimum: 0, description: '舞台高。' } } },
        effectiveStyle: { type: ['object', 'null'], additionalProperties: true, description: '复用filmSubtitleStyleFor得到的完整有效样式。默认锚点在竖屏映射至(.5,.72)，显式移动位置保留；未知舞台时为null。', properties: {
          on: { type: 'boolean', description: '沿原样式的字幕开关；false不表示舞台或配置未知。' },
          pos: { type: 'object', required: ['x', 'y'], additionalProperties: false, description: '有效锚点，按舞台宽/高的0..1比例，不是完整文字边界。', properties: { x: { type: 'number', minimum: 0, maximum: 1, description: '有效水平锚点。' }, y: { type: 'number', minimum: 0, maximum: 1, description: '应用既有竖屏默认映射后的垂直锚点。' } } },
          font: { type: 'object', additionalProperties: true, description: '原样式的字体输入，具体像素字号另见fontSizePx；不证明该字体已在浏览器加载。', properties: { family: { type: 'string', description: '声明的字体族。' }, sizePct: { type: 'number', description: '舞台短边的百分数。' } } },
          maxWidthPct: { type: 'number', description: '沿原样式的最大字幕行宽占舞台宽百分比，不是实际文字宽。' },
        } },
        fontSizePx: nullableNumber('复用filmSubtitleFontSizePx按舞台短边与sizePct取整的计算字号，不是实际字体、字形边界或小屏可读性。'),
        positionPolicy: { enum: ['portrait-default', 'preserved', 'unknown'], description: 'portrait-default表示原默认锚点发生既有竖屏映射；preserved表示原值保留，非平台自动搬移。' },
        source: { type: 'object', additionalProperties: false, required: ['film', 'style'], description: '同一次观察窗口读到的原字节来源；前后检查不等于原子文件系统快照。', properties: { film: fileSchema, style: fileSchema } },
        limitations: { type: 'array', items: { type: 'string' }, description: '字体/DOM/样式草稿及观察一致性的边界，真实边界需使用同源review。' },
      },
    },
  },
};

const sha256 = (/** @type {Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const decode = (/** @type {Buffer} */ bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const same = (/** @type {Buffer | null} */ before, /** @type {Buffer | null} */ after) => before === null ? after === null : after !== null && before.equals(after);
const meta = (/** @type {string} */ path, /** @type {Buffer | null} */ bytes) => ({ path, status: bytes === null ? 'absent' : 'present', bytes: bytes?.length ?? null, sha256: bytes === null ? null : sha256(bytes) });

/**
 * 两个小文件前后读回的观察窗口，不复制媒体、不触及锁或写样式。
 * read仅作为文件读取依赖便于定向并发回归，不通过HTTP/配置暴露。
 * @param {string} root
 * @param {{ read?: (path: string) => Promise<Buffer> }} [options]
 */
export async function readSubtitleStyleInfo(root, { read = readFile } = {}) {
  const optional = async (/** @type {string} */ path) => {
    try { return await read(join(root, path)); }
    catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null; throw e; }
  };
  const [filmBytes, styleBytes] = await Promise.all([optional(FILM_FILE), optional(SUBTITLE_STYLE_FILE)]);
  const filmSource = { ...meta(FILM_FILE, filmBytes), revision: /** @type {string | null} */ (null) };
  const styleSource = { ...meta(SUBTITLE_STYLE_FILE, styleBytes), usingDefault: true };
  /** @type {import('./film-subtitle.mjs').FilmSubtitleStyle | null} */
  let style = null;
  if (styleBytes !== null) {
    try {
      // 保留原readSubtitleStyle的UTF-8/JSON读取语义，原始摘要仍取Buffer。
      const raw = JSON.parse(styleBytes.toString('utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) { style = parseFilmSubtitleStyle(raw); styleSource.usingDefault = false; }
      else styleSource.status = 'invalid';
    } catch { styleSource.status = 'invalid'; }
  }
  let stage = null, reason = 'film-missing';
  if (filmBytes !== null) {
    try {
      const text = decode(filmBytes);
      filmSource.revision = sha256(filmBytes).slice(0, 16);
      // 与readProjectFilm一致：空影片不是采用格式默认舞台的有效工程。
      if (!text.trim()) { reason = 'film-empty'; filmSource.status = 'invalid'; }
      else {
        const { doc } = readFilmFile(text);
        stage = doc?.stage ?? null;
        if (!stage) { reason = 'film-invalid'; filmSource.status = 'invalid'; }
      }
    } catch { reason = 'film-invalid-utf8'; filmSource.status = 'invalid'; }
  }
  const [filmAfter, styleAfter] = await Promise.all([optional(FILM_FILE), optional(SUBTITLE_STYLE_FILE)]);
  if (!same(filmBytes, filmAfter) || !same(styleBytes, styleAfter)) throw new HttpError(409, '字幕布局来源在读取期间变化，请重新读取。', { code: 'subtitle-layout-stale' });
  const base = style ?? parseFilmSubtitleStyle(null);
  let effectiveStyle = stage ? filmSubtitleStyleFor(base, stage) : null;
  let fontSizePx = stage && effectiveStyle ? filmSubtitleFontSizePx(effectiveStyle, stage) : null;
  // 原解析器的未知旧值不在此修写；无法表示的计算结果保持unknown，不把NaN序列化成成功的null。
  if (effectiveStyle && !Number.isFinite(fontSizePx)) {
    reason = 'subtitle-layout-non-finite'; styleSource.status = 'invalid'; effectiveStyle = null; fontSizePx = null;
  }
  const computed = Boolean(stage && effectiveStyle);
  return { style, layout: {
    status: computed ? 'computed' : 'unknown', ...(!computed ? { reason } : {}), stage, effectiveStyle, fontSizePx,
    positionPolicy: effectiveStyle ? (effectiveStyle === base ? 'preserved' : 'portrait-default') : 'unknown',
    source: { film: filmSource, style: styleSource },
    limitations: ['仅为服务端导出和current-project审片的计算值，不包含浏览器记忆样式或未保存草稿。', '未测量实际字体、字形边界、描边/阴影包络、碰撞或安全区；应读取对应版本review的实际测量和图片。', '前后原字节检查是观察窗口，不是原子文件系统快照；之后修改需重新读取。'],
  } };
}
