/** 复用上游固定哈希的 FFmpeg 引导，浏览器由已锁定的 Playwright 版本准备。 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { runtimeEnvironment } from './config.mjs';
import { ffmpegOnPath, ffmpegDownloadable, ffmpegDir, ffmpegIn, fetchFfmpeg } from './ffmpeg-runtime.mjs';

export async function setupRuntime(config) {
  let env = runtimeEnvironment(config);
  const ownedMedia = ffmpegDir(config.home);
  if (!ffmpegOnPath(env.PATH)) {
    if (!ffmpegDownloadable()) throw new Error('当前平台请先安装支持混音滤镜及 H.264/AAC 编码的 FFmpeg 和 ffprobe，再重新运行 setup-runtime。');
    // 下载与源码来源、LICENSE一起保存；不会将这些二进制放入 Git 材料。
    await fetchFfmpeg(ownedMedia, { license: true });
    env = runtimeEnvironment(config);
    if (!ffmpegOnPath(env.PATH)) throw new Error('应用数据目录的 FFmpeg/ffprobe 未通过混音与 H.264/AAC 能力预检；运行时未就绪。');
  }
  const require = createRequire(new URL('../packages/openfilm/package.json', import.meta.url));
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, 'install', '--only-shell', 'chromium'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let error = '';
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-8192); });
    child.once('error', fail);
    child.once('exit', (code) => code === 0 ? done() : fail(new Error(`Chromium 准备失败：${error || code}`)));
  });
  return { app: 'video-creation', media: ffmpegIn(ownedMedia) ? ownedMedia : 'system-path',
    chromium: 'playwright-core/1.61.1', home: config.home };
}
