#!/usr/bin/env node
/** 为隔离场景页与工程本地复用构建同一份 MIT 动效运行时。 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareSamples } from '../examples/general-motion/prepare-samples.mjs';

const root = new URL('../', import.meta.url);
const output = new URL('packages/openfilm/studio/ui/dist/', root);
export const motionSourceFiles = ['motion.mjs', 'motion-schema.mjs'].map((file) =>
  fileURLToPath(new URL(`packages/openfilm/src/${file}`, root)));
const common = {
  entryPoints: [fileURLToPath(new URL('packages/openfilm/src/motion.mjs', root))],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  legalComments: 'eof',
  banner: { js: '// 视频创作动效运行时，MIT 许可；打包依赖的声明保留在下方。' },
};
/** Vite 自行输出返回的资源；CLI 也可单独构建 SDK，供定向检查使用。 */
export async function buildMotionSdk({ write = true } = {}) {
  if (write) await mkdir(output, { recursive: true });
  const result = await build({ ...common, write, format: 'esm', outfile: fileURLToPath(new URL('motion.mjs', output)) });
  return result.outputFiles ?? [];
}
export const prepareMotionSamples = prepareSamples;

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await buildMotionSdk();
  await prepareMotionSamples();
  process.stdout.write('Built self-contained motion runtime and prepared project-local sample dependencies.\n');
}
