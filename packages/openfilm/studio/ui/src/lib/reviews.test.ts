import test from 'node:test';
import assert from 'node:assert/strict';
import { pointsOf, maySeekEngineering, reviewImage, type ReviewRecord, type ReviewTarget } from './reviews.ts';
test('旧帧、序列格与版本对照点分别引用准确材料，不把组合图当单时点', () => {
  const frame = { index: 0, actualTime: 5, width: 320, height: 180, sha256: 'a'.repeat(64) };
  const r = { version: 4, reviewId: 'a'.repeat(24), sourceKind: 'review-pair', filmRevision: null, createdAt: '', frames: [], artifacts: [{ artifactId: 'revision-comparison', kind: 'revision-comparison', width: 640, height: 198, sha256: 'b'.repeat(64), layout: { cells: [{ x: 0, y: 18, width: 320, height: 180 }, { x: 320, y: 18, width: 320, height: 180 }] }, derivedFrom: [{ reviewId: 'c'.repeat(24), frameIndex: 0, actualTime: 5 }, { reviewId: 'd'.repeat(24), frameIndex: 1, actualTime: 6 }] }] } satisfies ReviewRecord;
  const p = pointsOf(r); assert.equal(p[0].reviewId, 'c'.repeat(24)); assert.equal(p[1].time, 6); assert.equal(p[1].index, 1);
  assert.ok(reviewImage('project', r.reviewId, p[0].image).includes('/artifacts/revision-comparison?expected_sha256='));
  assert.equal(pointsOf({ ...r, frames: [frame], artifacts: [] })[0].kind, 'frame');
});
test('未保存、过期版本、未知映射及错误状态都不能定位工程', () => {
  const target: ReviewTarget = { reviewId: '', sourceKind: 'current-project', filmRevision: 'old', point: { actualTime: 5 }, playback: null, engineering: { status: 'verified-at-check', filmRevision: 'old', timeMs: 5000 } };
  assert.equal(maySeekEngineering(target, 'old', true, null), true);
  assert.equal(maySeekEngineering(target, 'new', true, null), false);
  assert.equal(maySeekEngineering(target, 'old', false, null), false);
  assert.equal(maySeekEngineering(target, 'old', true, 'failed'), false);
  assert.equal(maySeekEngineering({ ...target, engineering: { status: 'unavailable' } }, 'old', true, null), false);
});
