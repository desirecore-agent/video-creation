#!/usr/bin/env node
/** 只复制正式构建的同源 SDK；未构建时明确失败，不以另一个动画实现冒充。 */
import { copyFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const sampleNames = Object.freeze(['product-demo', 'data-story', 'optional-caption', 'alpha-title']);
export async function prepareSamples() {
  const source = fileURLToPath(new URL('../../packages/openfilm/studio/ui/dist/motion.mjs', import.meta.url));
  try { await access(source); }
  catch { throw new Error('通用动效 SDK 尚未构建。请先在仓库根目录运行 pnpm build，再运行 node examples/general-motion/prepare-samples.mjs。'); }
  for (const name of sampleNames) await copyFile(source, fileURLToPath(new URL(`${name}/motion.mjs`, import.meta.url)));
  return sampleNames;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareSamples().then((names) => process.stdout.write(`已准备 ${names.length} 个通用动效工程。\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
