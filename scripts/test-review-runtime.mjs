/** 在既有 Linux runtime 依赖准备后显式运行真实审片测试；不改变 runner 或超时。 */
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'packages/openfilm/src/review-frames.runtime.test.mjs', 'packages/openfilm/src/review-refinement.runtime.test.mjs'], { stdio: 'inherit', env: { ...process.env, VIDEO_CREATION_REVIEW_RUNTIME: '1' } });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
