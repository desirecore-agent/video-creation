import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

// Deterministic hook-level harness, not a browser/visual acceptance test.
const source = await readFile(new URL('../packages/openfilm/studio/ui/src/lib/use-subtitle-style.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function harness() {
  const slots = [], effects = [], timers = new Map(), reads = [], writes = [];
  let cursor = 0, dirty = true, result, id = 0, project = 'A';
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; dirty = true; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(fn, deps) {
      const i = cursor++, old = slots[i];
      if (!old || deps.some((d, n) => d !== old.deps[n])) {
        effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  const api = {
    SUBTITLE_DEFAULT: { pos: { x: .5, y: .8 } }, readLastSubtitleStyle: () => null, writeLastSubtitleStyle() {},
    fetchSubtitleStyle(p) { const d = deferred(); reads.push({ project: p, ...d }); return d.promise; },
    saveSubtitleStyle(p, style, from) { const d = deferred(); writes.push({ project: p, style, from, ...d }); return d.promise; },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'setTimeout', 'clearTimeout', code)(
    (name) => name === 'react' ? react : api, module,
    (fn) => { timers.set(++id, fn); return id; }, (key) => timers.delete(key),
  );
  const flush = async () => {
    for (let i = 0; i < 10; ++i) {
      await Promise.resolve();
      if (dirty) { dirty = false; cursor = 0; result = module.exports.useSubtitleStyle(project); effects.splice(0).forEach((f) => f()); }
    }
  };
  await flush();
  return {
    reads, writes, flush, get result() { return result; },
    async tick() { for (const [key, fn] of [...timers]) { timers.delete(key); fn(); } await flush(); },
    async change(y) { result[1]((s) => ({ ...s, pos: { ...s.pos, y } })); await flush(); },
    async project(p) { project = p; dirty = true; await flush(); },
  };
}
const version = (c) => ({ filmRevision: 'a'.repeat(16), styleSha256: c.repeat(64) });
const snapshot = (c) => ({ style: { pos: { x: .5, y: .8 } }, from: version(c) });

test('UI serializes inflight edits and uses only acknowledged version, never a fresh GET during save', async () => {
  const h = await harness();
  h.reads[0].resolve(snapshot('b')); await h.flush();
  await h.change(.795); await h.tick();
  assert.equal(h.writes.length, 1);
  await h.change(.79); await h.tick();
  assert.equal(h.writes.length, 1, 'second waits for first acknowledgement');
  h.writes[0].resolve({ style: h.writes[0].style, from: version('c') }); await h.flush();
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[1].from, version('c'));
  assert.equal(h.reads.length, 1);
});

test('UI saves a return to the original style after an inflight change succeeds', async () => {
  const h = await harness();
  h.reads[0].resolve(snapshot('b')); await h.flush();
  await h.change(.795); await h.tick();
  assert.equal(h.writes.length, 1);
  await h.change(.8); await h.tick();
  assert.equal(h.writes.length, 1, 'return to A waits for B acknowledgement');
  h.writes[0].resolve({ style: h.writes[0].style, from: version('c') }); await h.flush();
  assert.equal(h.writes.length, 2, 'return to A must not be discarded against the old saved A');
  assert.equal(h.writes[1].style.pos.y, .8);
  assert.deepEqual(h.writes[1].from, version('c'));
  h.writes[1].resolve({ style: h.writes[1].style, from: version('d') }); await h.flush();
  await h.tick();
  assert.equal(h.result[0].pos.y, .8);
  assert.equal(h.result[2], null);
  assert.equal(h.writes.length, 2);
  assert.equal(h.reads.length, 1, 'no fresh GET to rebase the draft');
});

test('UI conflict keeps latest draft, shows error and cancels queued/next writes without rebasing', async () => {
  const h = await harness();
  const original = { ...snapshot('b'), style: { ...snapshot('b').style, font: { color: '#ffffff' } } };
  h.reads[0].resolve(original); await h.flush();
  await h.change(.795); await h.tick();
  await h.change(.79); await h.tick();
  // Another writer has changed an unrelated field. Even a supplied current token
  // must not authorize replaying this editor's complete old-style draft.
  const current = { from: version('c'), style: { ...original.style, font: { color: '#ff0000' } } };
  assert.deepEqual(h.writes[0].from, original.from);
  assert.equal(h.writes[0].style.font.color, '#ffffff');
  h.writes[0].reject(Object.assign(new Error('409 stale'), { status: 409, current })); await h.flush();
  assert.equal(h.result[0].pos.y, .79);
  assert.equal(h.result[0].font.color, '#ffffff', 'retain the unsaved draft, not a silent conflict resolution');
  assert.match(h.result[2], /409/);
  assert.equal(h.writes.length, 1);
  await h.change(.78); await h.tick();
  await h.tick();
  assert.equal(h.result[0].pos.y, .78, 'further edits stay in the draft');
  assert.match(h.result[2], /409/);
  assert.equal(h.writes.length, 1, 'no queued or later write can overwrite the other writer font field');
  assert.equal(h.reads.length, 1, 'no GET to acquire a fresh hash for the old whole-style draft');
});

test('UI missing/read-failed version never writes; old project responses cannot contaminate next project', async () => {
  const h = await harness();
  h.reads[0].reject(new Error('offline')); await h.flush();
  await h.change(.795); await h.tick();
  assert.equal(h.writes.length, 0);
  assert.ok(h.result[2]);
  await h.project('B');
  h.reads[1].resolve(snapshot('d')); await h.flush();
  await h.change(.79); await h.tick();
  assert.equal(h.writes[0].project, 'B');
  await h.project('C');
  h.writes[0].resolve({ style: h.writes[0].style, from: version('e') }); await h.flush();
  h.reads[2].resolve({ style: null, from: null }); await h.flush();
  await h.change(.77); await h.tick();
  assert.equal(h.writes.length, 1);
  assert.ok(h.result[2]);
});
