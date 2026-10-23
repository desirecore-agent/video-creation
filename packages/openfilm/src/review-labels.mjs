/** 审片元数据标签的自包含像素字形；不依赖操作系统字体，不绘制影片内容。 */
import { deflateSync } from 'node:zlib';

export const LABEL_STYLE = {
  description: '只用于制品的独立标签带；不作为作品字号或质量阈值。',
  padding: 2, foreground: [240, 242, 247, 255], background: [24, 27, 34, 255],
};
const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00100', '00100'],
  's': ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  'p': ['00000', '00000', '11110', '10001', '11110', '10000', '10000'],
  'x': ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
  '>': ['10000', '01000', '00100', '00010', '00100', '01000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

export const labelBandHeight = (maxEdge) => maxEdge >= 512 ? 18 : 9;

/** 完整标签放不下时只显示完整编号/实际宽度，不裁成可能误读的半个时间数字。 */
export function cellLabel(text, fallback, x, y, width, height) {
  const fits = (s, scale) => s.length * 6 * scale - scale + LABEL_STYLE.padding * 2 <= width && 7 * scale + LABEL_STYLE.padding <= height;
  const scale = fits(text, 2) ? 2 : 1;
  const renderedText = fits(text, scale) ? text : fits(fallback, 1) ? fallback : '';
  return { text, renderedText, fullLabelRendered: renderedText === text, rendered: Boolean(renderedText),
    fontScale: renderedText === text ? scale : 1, x, y, width, height,
    ...(!fits(text, scale) ? { limitedBy: 'label-space', limitation: '标签带不足；完整时点/宽度仍在metadata，不从简化编号猜时间。' } : {}) };
}

/** 简单RGBA PNG仅承载固定元数据标签，透明区域不覆盖原画面。 */
export function reviewLabelsPNG(layout) {
  const { width, height } = layout;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 1920 || height > 1920) throw new Error('审片标签尺寸超出整图预算。');
  const stride = width * 4 + 1, raw = Buffer.alloc(stride * height);
  const pixel = (x, y, color) => {
    if (x >= 0 && y >= 0 && x < width && y < height) raw.set(color, y * stride + 1 + x * 4);
  };
  for (const cell of layout.cells) {
    const label = cell.label;
    if (!label) continue;
    for (let y = label.y; y < label.y + label.height; y++) for (let x = label.x; x < label.x + label.width; x++) pixel(x, y, LABEL_STYLE.background);
    for (const [i, char] of [...label.renderedText].entries()) {
      const glyph = FONT[char]; if (!glyph) throw new Error('审片标签含未声明字形。');
      for (const [row, bits] of glyph.entries()) for (let col = 0; col < 5; col++) if (bits[col] === '1') {
        for (let sy = 0; sy < label.fontScale; sy++) for (let sx = 0; sx < label.fontScale; sx++) pixel(
          label.x + LABEL_STYLE.padding + (i * 6 + col) * label.fontScale + sx,
          label.y + 1 + row * label.fontScale + sy, LABEL_STYLE.foreground);
      }
    }
  }
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const b of body) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
