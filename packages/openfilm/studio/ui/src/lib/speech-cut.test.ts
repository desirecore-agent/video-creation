import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSpeechPreview } from './speech-cut.ts';

test('取消/换选择/seek清本次试听停止点，关闭后不会继续跳区或旧点停播', () => {
  const state = { preview: { stop: 5600 }, stopAt: 5600 as number | null, playing: true };
  const released = releaseSpeechPreview(state.preview.stop, state.stopAt);
  state.stopAt = released.stopAt;
  if (released.pause) state.playing = false;
  assert.equal(state.stopAt, null);
  assert.equal(state.playing, false);
});

test('用户后来的一般播放拥有新停止点，旧面板关闭不能清它或暂停', () => {
  assert.deepEqual(releaseSpeechPreview(5600, 9000), { stopAt: 9000, pause: false });
  assert.deepEqual(releaseSpeechPreview(null, 9000), { stopAt: 9000, pause: false });
  assert.deepEqual(releaseSpeechPreview(null, null), { stopAt: null, pause: false });
});
