// @ts-check
/** 字幕强调只引用纯文本的 UTF-16 半开区间，不携带 HTML、类名或 CSS。
 * @typedef {{ from: number, to: number }} SubtitleEmphasis */

/** 索引不得落在一个 Unicode 码点的代理对中间。 @param {string} text @param {number} index */
export function subtitleTextBoundary(text, index) {
  return index === 0 || index === text.length || !(/[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]));
}

/** 渲染和派生数据共用的范围归一化；写入入口另行严格校验，不用此函数放宽输入。
 * @param {string} text @param {readonly SubtitleEmphasis[] | undefined} ranges @returns {SubtitleEmphasis[]} */
export function normalizeEmphasis(text, ranges) {
  const sorted = (Array.isArray(ranges) ? ranges : []).filter((r) => r && Number.isInteger(r.from) && Number.isInteger(r.to)
    && r.from >= 0 && r.to > r.from && r.to <= text.length && subtitleTextBoundary(text, r.from) && subtitleTextBoundary(text, r.to))
    .map(({ from, to }) => ({ from, to })).sort((a, b) => a.from - b.from || a.to - b.to);
  /** @type {SubtitleEmphasis[]} */
  const out = [];
  for (const range of sorted) {
    const previous = out.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else out.push(range);
  }
  return out;
}

/** 裁剪后的范围相对于新文本起点；from/to 由调用方的真实文本切片决定。
 * @param {readonly SubtitleEmphasis[] | undefined} ranges @param {number} from @param {number} to @returns {SubtitleEmphasis[]} */
export function sliceEmphasis(ranges, from, to) {
  return (ranges ?? []).flatMap((r) => {
    const a = Math.max(from, r.from), b = Math.min(to, r.to);
    return b > a ? [{ from: a - from, to: b - from }] : [];
  });
}

/** 空白归一化使用原文位置映射，避免重复词或 emoji 让强调错套到另一处。
 * @param {string} raw @param {readonly SubtitleEmphasis[]} [ranges]
 * @returns {{ text: string, emphasis?: SubtitleEmphasis[] }} */
export function normalizeSubtitleText(raw, ranges) {
  const text = raw.replace(/\s+/g, ' ').trim();
  const at = new Array(raw.length + 1).fill(0);
  let j = 0, previousSpace = true;
  for (let i = 0; i < raw.length; i += 1) {
    at[i] = Math.min(j, text.length);
    const space = /\s/.test(raw[i]);
    if (space && previousSpace) continue;
    j += 1;
    previousSpace = space;
  }
  at[raw.length] = text.length;
  const emphasis = normalizeEmphasis(text, normalizeEmphasis(raw, ranges).map((r) => ({ from: at[r.from], to: at[r.to] })));
  return { text, ...(emphasis.length ? { emphasis } : {}) };
}

/** 只输出纯文本片段；消费方分别决定外观与 karaoke 状态，不解析任意标签。
 * @param {string} text @param {readonly SubtitleEmphasis[]} [ranges]
 * @returns {{ text: string, from: number, to: number, emphasis: boolean }[]} */
export function emphasisParts(text, ranges) {
  /** @type {{ text: string, from: number, to: number, emphasis: boolean }[]} */
  const out = [];
  let from = 0;
  for (const range of normalizeEmphasis(text, ranges)) {
    if (range.from > from) out.push({ text: text.slice(from, range.from), from, to: range.from, emphasis: false });
    out.push({ text: text.slice(range.from, range.to), ...range, emphasis: true });
    from = range.to;
  }
  if (from < text.length) out.push({ text: text.slice(from), from, to: text.length, emphasis: false });
  return out;
}
