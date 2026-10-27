import test from 'node:test';
import assert from 'node:assert/strict';
import { filmHtml } from '../../src/film-doc.mjs';
import { reviewFacts, compareReviewFacts } from './review-facts.mjs';
import { Ajv } from 'ajv';
import { reviewSourceFactsSchema } from './review-contract.mjs';
const film = (intent) => filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ locked: true, clips: [{ id: 'scene', src: 'scene.html', at: 0, time: [0, 2], overrides: [{ at: '#human', text: '人工定稿', lock: true }], ...(intent === undefined ? {} : { attrs: { 'data-review-intent': intent } }) }] }] });
test('可选审片意图沿已有attrs保存，读取不改画面、原文件或另一套锁', () => {
  const raw = film(JSON.stringify({ targetWidths: [180, 360], text: [{ role: 'essential', selector: '#title', description: '传达片名' }] }));
  const value = reviewFacts(raw);
  assert.equal(value.status, 'observed'); assert.equal(value.intents[0].value.text[0].role, 'essential');
  assert.equal('locks' in value.intents[0].value, false); assert.match(value.clips[0].overridesSha256, /^[a-f0-9]{64}$/);
  assert.equal(raw, film(JSON.stringify(value.intents[0].value)));
});
test('旧作品不标注，坏JSON/未声明字段保留invalid而不编造角色', () => {
  assert.deepEqual(reviewFacts(film()).intents, []);
  assert.equal(reviewFacts(film('{')).intents[0].status, 'invalid');
  assert.equal(reviewFacts(film('{"minimumFontSize":16}')).intents[0].status, 'invalid');
});
test('对照只用两份捕获事实，数据缺失保持unknown，输入移出不冒称删除文件', () => {
  const wrap = (facts, files) => ({ filmRevision: facts?.filmSha256?.slice(0, 16), sourceFacts: facts, source: { inputs: { files } } });
  const f = reviewFacts(film());
  const r = compareReviewFacts(wrap(f, [{ path: 'old.html', sha256: 'a'.repeat(64) }]), wrap(f, [{ path: 'new.html', sha256: 'b'.repeat(64) }]));
  assert.equal(r.files.totalChanges, 2); assert.ok(r.files.changes.some((c) => c.kind === 'input-removed'));
  assert.equal(r.preservedData.totalChanges, 0);
  assert.equal(compareReviewFacts({}, wrap(f, [])).preservedData.status, 'unknown');
});

const motionFilm = (locked) => filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{
  id: 'motion-scene', src: 'scene.html', at: 0, time: [0, 2],
  motion: { version: 1, params: { title: '人工片名' }, ...(locked === undefined ? {} : { locked }) },
}] }] });
const captured = (sourceFacts) => ({ filmRevision: sourceFacts.filmSha256.slice(0, 16), sourceFacts });

test('真实 motion.locked 的增加、删除和字段变更只归因人工锁，不混入布局摘要', () => {
  const states = [undefined, ['params.title'], ['params.title', 'data.series'], []].map((locked) => reviewFacts(motionFilm(locked)));
  for (const facts of states) {
    assert.equal(facts.status, 'observed');
    assert.ok(new Ajv().compile(reviewSourceFactsSchema)(facts));
  }
  for (let i = 1; i < states.length; i++) {
    assert.notEqual(states[i - 1].clips[0].locksSha256, states[i].clips[0].locksSha256);
    assert.equal(states[i - 1].clips[0].visualFieldsSha256, states[i].clips[0].visualFieldsSha256);
    const result = compareReviewFacts(captured(states[i - 1]), captured(states[i]));
    assert.equal(result.preservedData.status, 'observed');
    assert.deepEqual(result.preservedData.changes.map((v) => v.field), ['clip:motion-scene:locksSha256']);
  }
});

test('历史锁摘要回执仍可读，但不能与当前投影拼接成锁未变化的证明', () => {
  const current = reviewFacts(motionFilm(['params.title']));
  const legacy = structuredClone(current); legacy.version = 1;
  legacy.clips[0].locksSha256 = 'a'.repeat(64);
  assert.ok(new Ajv().compile(reviewSourceFactsSchema)(legacy));
  for (const [a, b] of [[legacy, current], [current, legacy], [legacy, legacy]]) {
    const result = compareReviewFacts(captured(a), captured(b));
    assert.equal(result.preservedData.status, 'unknown');
    assert.equal(result.preservedData.reason, 'legacy-lock-projection');
  }
  const unchanged = compareReviewFacts(captured(current), captured(current));
  assert.equal(unchanged.preservedData.status, 'observed');
  assert.equal(unchanged.preservedData.totalChanges, 0);
});
