import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextDraft, createTextWriteQueue } from './text-draft.ts';

test('a slow success acknowledges saved words without replacing newer unsaved input or preview measurements', () => {
  const draft = createTextDraft('#title', 'Initial');
  draft.change('First');
  const first = draft.submit()!;
  draft.change('Second unsaved');
  assert.equal(draft.receive('First'), false);
  draft.finish(first, false);
  assert.equal(draft.written, 'First');
  assert.equal(draft.raw, 'Second unsaved');
  assert.equal(first.isCurrent!(), false);
  assert.equal(draft.receive('First'), false, 'a subsequent parent acknowledgement cannot erase the draft');
  const second = draft.submit()!;
  assert.equal(second.expect, 'First');
  draft.finish(second, false);
  assert.equal(draft.written, 'Second unsaved');
  assert.equal(draft.saving, false);
});

test('a slow refusal preserves newer input, while a refused current submission restores the latest successful words', () => {
  const draft = createTextDraft('#title', 'Initial');
  draft.change('First'); const first = draft.submit()!;
  draft.change('Second'); const second = draft.submit()!;
  draft.finish(first, false);
  assert.equal(draft.saving, true, 'an earlier response does not clear a later save indicator');
  draft.finish(second, true);
  assert.equal(draft.raw, 'First');
  assert.equal(draft.written, 'First');

  draft.change('Third'); const third = draft.submit()!;
  draft.change('Fourth unsaved');
  draft.finish(third, true);
  assert.equal(draft.raw, 'Fourth unsaved');
  assert.equal(draft.written, 'First');
});

test('duplicate blurs are ignored but reverting to the old baseline during an in-flight write is a real new save', () => {
  const draft = createTextDraft('#title', 'Initial');
  draft.change('First'); const first = draft.submit()!;
  assert.equal(draft.submit(), null);
  draft.change('Initial'); const revert = draft.submit()!;
  assert.ok(revert, 'the pending First will otherwise replace the desired Initial');
  draft.finish(first, false);
  assert.equal(draft.raw, 'Initial');
  draft.finish(revert, false);
  assert.equal(draft.raw, 'Initial');
  assert.equal(draft.written, 'Initial');
});

test('Escape discards only the unsent draft and follows a previously submitted save when it completes', () => {
  const draft = createTextDraft('#title', 'Initial');
  draft.change('First'); const first = draft.submit()!;
  draft.change('Second unsaved');
  draft.cancel();
  assert.equal(draft.raw, 'Initial');
  assert.equal(first.isCurrent!(), false);
  draft.finish(first, false);
  assert.equal(draft.raw, 'First');
  assert.equal(draft.written, 'First');
});

test('idle undo/external text is received, including after editing back to the unchanged value', () => {
  const draft = createTextDraft('#title', 'Initial');
  draft.change('Initial'); assert.equal(draft.submit(), null);
  assert.equal(draft.receive('Undo result'), true);
  assert.equal(draft.raw, 'Undo result');
  assert.equal(draft.written, 'Undo result');
});

test('retyping the pending value does not leave a dirty buffer after that value is saved', () => {
  const draft = createTextDraft('#title', 'Initial');
  draft.change('First'); const first = draft.submit()!;
  draft.change('First'); assert.equal(draft.submit(), null);
  draft.finish(first, false);
  assert.equal(draft.receive('External undo'), true);
  assert.equal(draft.raw, 'External undo');
});

test('an old layer completion is inactive and cannot acknowledge the buffer of another selected layer', () => {
  const before = createTextDraft('#title', 'Title');
  before.change('Saved title'); const save = before.submit()!;
  before.dispose();
  const selected = createTextDraft('#subtitle', 'Subtitle'); selected.change('New subtitle draft');
  before.finish(save, true);
  assert.equal(save.isCurrent!(), false);
  assert.equal(selected.raw, 'New subtitle draft');
  assert.equal(selected.written, 'Subtitle');
});

test('text writes retain their captured targets and run in order through deferred geometry and rejected writes', async () => {
  const queue = createTextWriteQueue();
  const calls: string[] = [];
  let release!: () => void;
  const first = queue(async () => { calls.push('title-first'); await new Promise<void>((done) => { release = done; }); return 'first saved'; });
  const second = queue(async () => { calls.push('title-second'); throw new Error('refused'); });
  const third = queue(async () => { calls.push('other-layer'); return 'other saved'; });
  const refusal = assert.rejects(second, /refused/);
  await Promise.resolve();
  assert.deepEqual(calls, ['title-first']);
  release();
  assert.equal(await first, 'first saved');
  await refusal;
  assert.equal(await third, 'other saved');
  assert.deepEqual(calls, ['title-first', 'title-second', 'other-layer']);
});
