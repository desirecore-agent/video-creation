/** 只读静态场景声明，供项目发现和依赖闭包复用；不执行页面。 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { validateMotionManifest } from '../../src/motion-schema.mjs';
const MAX_SCENE = 4 * 1024 * 1024;
const rawTags = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const decodeAttribute = (text) => text.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, digits) => {
  const code = digits[0].toLowerCase() === 'x' ? parseInt(digits.slice(1), 16) : Number(digits);
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
});

/** 只跳过元素外的注释和原始文本；JSON 内的注释样式文字按原字节保留。 */
function reservedNodes(html) {
  const nodes = [];
  let pos = 0, templateDepth = 0;
  while (pos < html.length) {
    const start = html.indexOf('<', pos);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = /--!?>/g; end.lastIndex = start + 4;
      const close = end.exec(html); pos = close ? end.lastIndex : html.length; continue;
    }
    if (html.startsWith('<!', start) || html.startsWith('<?', start)) { const end = html.indexOf('>', start + 2); pos = end < 0 ? html.length : end + 1; continue; }
    const closeTemplate = /^<\/template\s*>/i.exec(html.slice(start));
    if (closeTemplate) { templateDepth = Math.max(0, templateDepth - 1); pos = start + closeTemplate[0].length; continue; }
    const tag = /^<([a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(html.slice(start));
    if (!tag) { pos = start + 1; continue; }
    pos = start + tag[0].length;
    const name = tag[1].toLowerCase(), attrs = {};
    for (const field of tag[2].matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const key = field[1].toLowerCase();
      // HTML 重复属性保留首项；后项不能改变保留 ID 或类型。
      if (!Object.hasOwn(attrs, key)) attrs[key] = decodeAttribute(field[2] ?? field[3] ?? field[4] ?? '');
    }
    const reserved = templateDepth === 0 && attrs.id === 'film-motion';
    const node = { name, attrs, text: '' };
    if (reserved) nodes.push(node);
    if (name === 'template') { templateDepth++; continue; }
    if (name === 'plaintext') break;
    if (rawTags.has(name)) {
      const end = new RegExp(`</${name}\\s*>`, 'gi'); end.lastIndex = pos;
      const close = end.exec(html);
      if (reserved) node.text = html.slice(pos, close?.index ?? html.length);
      pos = close ? end.lastIndex : html.length;
    }
  }
  return nodes;
}

/** 与浏览器共用保留 ID/type/唯一性约束；坏声明不能静默退回自由场景。 */
export function motionManifestFromHtml(html) {
  if (Buffer.byteLength(html) > MAX_SCENE) throw new Error('动效场景超过 4 MiB，不能读取构件声明。');
  const nodes = reservedNodes(html);
  if (!nodes.length) return null;
  if (nodes.length !== 1) throw new Error('场景只能声明一个 film-motion。');
  if (nodes[0].name !== 'script' || nodes[0].attrs.type !== 'application/json') throw new Error('film-motion 必须是 application/json 的 script。');
  let manifest;
  try { manifest = JSON.parse(nodes[0].text); } catch { throw new Error('film-motion 不符合 JSON 格式。'); }
  const checked = validateMotionManifest(manifest);
  if (!checked.value) throw new Error(checked.problems.join('\n'));
  return manifest;
}

/** 文件读取放在静态声明层，不让影片编辑依赖项目服务和收藏，避免启动环。 */
export async function readSceneMotion(root, src) {
  // 沿用统一路径边界；调用发生在模块初始化后，避免 files → film → projects 的静态依赖环。
  const { readable } = await import('./files.mjs');
  const path = readable(root, src);
  const size = (await lstat(path)).size;
  if (size > MAX_SCENE) throw new Error(`${src}: 动效场景超过 4 MiB。`);
  const html = await readFile(path, 'utf8');
  return { manifest: motionManifestFromHtml(html), sourceDigest: createHash('sha256').update(html).digest('hex') };
}
