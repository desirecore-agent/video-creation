import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPresentation, firstLastLayout } from './review-derivatives.mjs';

test('目标宽度是只缩小的观看样本，源上限与maxEdge限制显式分列', () => {
  assert.deepEqual(reviewPresentation({ width: 1280, height: 720 }, { targetWidth: 390, maxEdge: 1280 }, { width: 1920, height: 1080 }), {
    requestedTargetWidth: 390, sourceWidth: 1920, sourceHeight: 1080, captureWidth: 1280, captureHeight: 720, actualWidth: 390, actualHeight: 219, scale: 390 / 1920, maxEdge: 1280, limitedBy: [],
  });
  const capped = reviewPresentation({ width: 1280, height: 720 }, { targetWidth: 2000, maxEdge: 1280 }, { width: 1920, height: 1080 });
  assert.equal(capped.actualWidth, 1280); assert.deepEqual(capped.limitedBy, ['source-no-upscale', 'max-edge']);
  const small = reviewPresentation({ width: 80, height: 45 }, { targetWidth: 390, maxEdge: 1280 });
  assert.equal(small.actualWidth, 80); assert.deepEqual(small.limitedBy, ['source-no-upscale']);
});

test('首尾合成最长边限制整图并记录每格真实尺寸，竖横画幅不拉伸', () => {
  const layout = firstLastLayout({ index: 2, width: 390, height: 219 }, { index: 0, width: 200, height: 400 }, 256);
  assert.ok(layout.width <= 256 && layout.height <= 256);
  assert.equal(layout.cells[0].frameIndex, 2); assert.equal(layout.cells[1].frameIndex, 0);
  assert.equal(layout.cells[1].x, layout.cells[0].width);
  assert.equal(layout.height, Math.max(...layout.cells.map((cell) => cell.height)));
  assert.ok(layout.cells.every((cell) => cell.scale <= 1 && cell.width <= cell.sourceWidth && cell.height <= cell.sourceHeight));
});
