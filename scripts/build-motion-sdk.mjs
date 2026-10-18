#!/usr/bin/env node
/** 为隔离场景页与工程本地复用构建同一份 MIT 动效运行时。 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareSamples } from '../examples/general-motion/prepare-samples.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const output = new URL('packages/openfilm/studio/ui/dist/', root);
const noticeManifestPath = join(rootPath, 'desirecore/licenses/manifest.json');
export function motionBuildInputs() {
  const manifest = JSON.parse(readFileSync(noticeManifestPath, 'utf8'));
  return [
    ...['motion.mjs', 'motion-schema.mjs'].map((file) => join(rootPath, 'packages/openfilm/src', file)),
    join(rootPath, 'LICENSE'), noticeManifestPath,
    ...manifest.packages.flatMap((pkg) => pkg.notices.map((notice) => join(rootPath, notice.path))),
  ];
}
const common = {
  entryPoints: [fileURLToPath(new URL('packages/openfilm/src/motion.mjs', root))],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  legalComments: 'eof',
  banner: { js: '// 视频创作动效运行时，MIT 许可；打包依赖的声明保留在下方。' },
};

/** 按实际输出中的第三方模块查找包身份，不把构建工具或被消除的代码混入许可清单。 */
async function licenseFooter(metafile) {
  const packages = new Map();
  const locations = new Set();
  const noticeManifest = JSON.parse(await readFile(noticeManifestPath, 'utf8'));
  for (const generated of Object.values(metafile.outputs)) for (const [input, detail] of Object.entries(generated.inputs)) {
    if (!detail.bytesInOutput || !input.replaceAll('\\', '/').includes('node_modules/')) continue;
    let directory = dirname(resolve(input));
    while (!existsSync(join(directory, 'package.json')) && dirname(directory) !== directory) directory = dirname(directory);
    if (locations.has(directory)) continue;
    locations.add(directory);
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const record = noticeManifest.packages.find((pkg) => pkg.name === metadata.name && pkg.version === metadata.version && pkg.license === metadata.license);
    if (!record?.notices?.length) throw new Error(`动效 SDK 缺少实际依赖的完整许可：${metadata.name}@${metadata.version}；请重新生成依赖许可。`);
    packages.set(`${record.name}@${record.version}`, record);
  }
  let text = '\n/*!\n视频创作动效 SDK 的完整许可；保存或复制单个模块时须保留以下原文。\n\n';
  text += await readFile(join(rootPath, 'LICENSE'), 'utf8');
  for (const [identity, record] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    text += `\n依赖：${identity}（${record.license}）\n`;
    for (const notice of record.notices) {
      const bytes = await readFile(join(rootPath, notice.path));
      if (bytes.length !== notice.size || createHash('sha256').update(bytes).digest('hex') !== notice.sha256)
        throw new Error(`动效 SDK 许可全文缺失或已变化：${notice.path}`);
      text += bytes.toString('utf8') + '\n';
    }
  }
  // 不修改许可正文来转义注释；遇到不适合块注释的原文时显式停止构建。
  if (text.includes('*/')) throw new Error('许可正文包含块注释结束符，须先调整许可携带方式。');
  return text + '*/\n';
}

/** Vite 自行输出返回的资源；CLI 也可单独构建 SDK，供定向检查使用。 */
export async function buildMotionSdk({ write = true } = {}) {
  if (write) await mkdir(output, { recursive: true });
  const result = await build({ ...common, write: false, metafile: true, format: 'esm', outfile: fileURLToPath(new URL('motion.mjs', output)) });
  const footer = Buffer.from(await licenseFooter(result.metafile));
  const files = result.outputFiles.map((file) => ({ path: file.path, contents: Buffer.concat([file.contents, footer]) }));
  if (write) for (const file of files) await writeFile(file.path, file.contents);
  return files;
}
export const prepareMotionSamples = prepareSamples;

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await buildMotionSdk();
  await prepareMotionSamples();
  process.stdout.write('Built self-contained motion runtime and prepared project-local sample dependencies.\n');
}
