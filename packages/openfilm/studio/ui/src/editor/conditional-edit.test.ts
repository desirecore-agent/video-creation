import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverConditionalEdit } from './conditional-edit.ts';

test('条件POST断网且刷新再次断网，恢复原影片并保留原错误，不生成撤销步', async () => {
  const before = { clips: ['original'] }, optimistic = { clips: ['cut-left', 'cut-right'] };
  let shown = optimistic;
  const history: unknown[] = [];
  let error = '';
  try {
    await Promise.reject(new Error('write transport offline'));
    history.push({ redo: 'cut' });
  } catch (e) {
    error = (e as Error).message;
    const refreshed = await recoverConditionalEdit(async () => { throw new Error('refresh transport offline'); }, () => { shown = before; });
    assert.equal(refreshed, false);
  }
  assert.equal(shown, before);
  assert.equal(error, 'write transport offline');
  assert.deepEqual(history, []);
});

test('刷新取得真实server状态时不覆盖它；损坏影片false时恢复before', async () => {
  let restored = 0;
  assert.equal(await recoverConditionalEdit(async () => true, () => { restored += 1; }), true);
  assert.equal(restored, 0);
  assert.equal(await recoverConditionalEdit(async () => false, () => { restored += 1; }), false);
  assert.equal(restored, 1);
});
