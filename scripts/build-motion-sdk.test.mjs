import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { buildMotionSdk, buildTimelinePlan } from './build-motion-sdk.mjs';

test('自包含 SDK 及单文件副本保留实际五项依赖的完整许可，声明不改变可执行代码', async () => {
  const [file] = await buildMotionSdk({ write: false });
  const text = file.contents.toString('utf8');
  const manifest = JSON.parse(await readFile(new URL('../desirecore/licenses/manifest.json', import.meta.url), 'utf8'));
  const names = ['ajv', 'ajv-formats', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse'];
  assert.ok(text.includes(await readFile(new URL('../LICENSE', import.meta.url), 'utf8')));
  for (const name of names) {
    const record = manifest.packages.find((pkg) => pkg.name === name);
    assert.ok(text.includes(`依赖：${name}@${record.version}（${record.license}）`));
    for (const notice of record.notices) assert.ok(text.includes(await readFile(new URL(`../${notice.path}`, import.meta.url), 'utf8')), `${name} 的许可原文须完整保留`);
  }
  assert.ok(!text.includes('依赖：require-from-string@'), '未进入浏览器输出的包不冒称实际依赖');
  const mark = text.indexOf('/*!\n视频创作动效 SDK 的完整许可');
  assert.ok(mark > 0);
  const executable = async (source) => (await transform(source, { loader: 'js', format: 'esm', legalComments: 'none' })).code;
  assert.equal(await executable(text), await executable(text.slice(0, mark)));
  const dir = await mkdtemp(join(tmpdir(), 'motion-sdk-license-'));
  try {
    await writeFile(join(dir, 'motion.mjs'), file.contents);
    await copyFile(join(dir, 'motion.mjs'), join(dir, 'saved-copy.mjs'));
    assert.equal(await readFile(join(dir, 'saved-copy.mjs'), 'utf8'), text);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('服务端精剪bundle无React/DOM依赖，单文件加载后沿同源波纹规则计划', async () => {
  const [file] = await buildTimelinePlan({ write: false });
  const text = file.contents.toString('utf8');
  assert.ok(!/from ["'](?:react|[^.][^"']*)["']/.test(text));
  assert.ok(!text.includes('document.') && !text.includes('useSyncExternalStore'));
  const { planCutRange } = await import(`data:text/javascript;base64,${file.contents.toString('base64')}`);
  const plan = planCutRange([{ index: 0, clips: [{ id: 'voice', startMs: 0, endMs: 10000, inMs: 0, speed: 1, sourceMs: 10000 }] }], 'voice', 2000, 3000, { sync: true });
  assert.equal(plan.shortMs, 0);
  assert.equal(plan.ops[0].op, 'split');
});
