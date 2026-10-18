#!/usr/bin/env node
/** 只复制正式构建的同源 SDK；未构建时明确失败，不以另一个动画实现冒充。 */
import { copyFile, access } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const sampleNames = Object.freeze(['product-demo', 'data-story', 'optional-caption', 'alpha-title']);
export async function prepareSamples() {
  const source = fileURLToPath(new URL('../../packages/openfilm/studio/ui/dist/motion.mjs', import.meta.url));
  try { await access(source); }
  catch { throw new Error('通用动效 SDK 尚未构建。请先在仓库根目录运行 pnpm build，再运行 node examples/general-motion/prepare-samples.mjs。'); }
  for (const name of sampleNames) await copyFile(source, fileURLToPath(new URL(`${name}/motion.mjs`, import.meta.url)));
  return sampleNames;
}
// 目录链接按真实文件比较；stdin 与普通导入不应触发样片写入。
const entry = process.argv[1];
let directEntry = false;
if (entry && entry !== '-' && existsSync(entry)) {
  try { directEntry = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry)); }
  catch { /* 无法解析入口时保持为普通模块。 */ }
}
if (directEntry) {
  prepareSamples().then((names) => process.stdout.write(`已准备 ${names.length} 个通用动效工程。\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
