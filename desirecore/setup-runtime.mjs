/** 复用上游固定哈希的 FFmpeg 引导，浏览器由已锁定的 Playwright 版本准备。 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { applyRuntimeEnvironment } from './config.mjs';
import { ffmpegOnPath, ffmpegDownloadable, ffmpegDir, fetchFfmpeg } from './ffmpeg-runtime.mjs';

export async function setupRuntime(config) {
  applyRuntimeEnvironment(config);
  let media = 'system-path';
  if (!ffmpegOnPath(process.env.PATH)) {
    if (!ffmpegDownloadable()) throw new Error('当前平台请先安装 FFmpeg 和 ffprobe，再重新运行 setup-runtime。');
    media = ffmpegDir(config.home);
    // 下载与源码来源、LICENSE一起保存；不会将这些二进制放入 Git 材料。
    await fetchFfmpeg(media, { license: true });
    applyRuntimeEnvironment(config);
  }
  const require = createRequire(new URL('../packages/openfilm/package.json', import.meta.url));
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, 'install', '--only-shell', 'chromium'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let error = '';
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-8192); });
    child.once('error', fail);
    child.once('exit', (code) => code === 0 ? done() : fail(new Error(`Chromium 准备失败：${error || code}`)));
  });
  return { app: 'video-creation', media, chromium: 'playwright-core/1.61.1', home: config.home };
}
