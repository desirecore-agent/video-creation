import test from 'node:test';
import assert from 'node:assert/strict';
import { filmHtml } from '../../src/film-doc.mjs';
import { reviewFacts, compareReviewFacts } from './review-facts.mjs';
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
