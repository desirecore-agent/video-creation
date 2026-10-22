import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import Ajv from 'ajv';
import { cutText } from './shared.mjs';
import { collectFrameFindings, MAX_REVIEW_FINDINGS, reviewCoverageSchema, reviewFindingSchema, textSampleFindings } from './review-findings.mjs';

const time = { requestedTime: 2, actualTime: 2, actualPTS: null, timeBasis: 'project-seek' };
const source = { kind: 'current-project', page: 'scene.html', clipId: 'one', inputSha256: null, consistency: 'sample-window-not-atomic' };
const sample = { sel: '#title', text: '人工标题', bounds: { x: -3, y: 4, width: 120, height: 20 }, clipped: 'edge',
  clipBounds: { x: 0, y: 0, width: 320, height: 180 }, fontSizeCssPx: 8, localScaleY: 1, projection: 'axis-aligned-css' };

test('小尺寸字号是定量 info，与裁切独立；复杂变换不补造目标字号', () => {
  const findings = textSampleFindings(sample, { time, source, viewport: { width: 320, height: 180 }, stageWidth: 320, targetWidth: 96, outerScaleY: 1 });
  assert.deepEqual(findings.map((item) => item.code), ['dom-text-size', 'dom-text-clipping']);
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].measurement.targetFontSizePx, 2.4);
  assert.equal(findings[0].measurement.aestheticThreshold, null);
  assert.equal(findings[1].measurement.boundary, 'page-viewport');
  assert.equal(findings[1].measurement.toleranceCssPx, 2);
  assert.equal(findings[0].bounds.coordinateSpace, 'page-css-pixels');
  const unknown = textSampleFindings({ ...sample, projection: 'unknown-complex-transform', localScaleY: null, clipped: null },
    { time, source, viewport: { width: 320, height: 180 }, stageWidth: 320, targetWidth: 96, outerScaleY: 1 });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].measurement.fontSizeCssPx, 8);
  assert.equal(unknown[0].measurement.targetFontSizePx, null);
  assert.ok(unknown[0].limitations.some((item) => item.includes('null')));
});

function mockFilm({ samples = [sample], count = 1, failed = false, sourceURL = 'http://film.test/scene%20one.html#fragment' } = {}) {
  let disposed = 0;
  const main = { url: () => 'http://film.test/film.html', evaluate: async () => ({ isPage: true, isTimeline: true, viewport: { width: 320, height: 180 } }) };
  const frames = Array.from({ length: count }, (_, i) => ({
    url: () => sourceURL, parentFrame: () => main,
    frameElement: async () => ({ evaluate: async () => ({ visible: true, simple: true, clipId: `clip-${i}`, nativeWidth: 320, nativeHeight: 180,
      shown: true, drawn: true, rect: { width: 320, height: 180 }, parentViewportWidth: 320, hasBorder: false }), dispose: async () => { disposed += 1; } }),
    evaluate: async (fn) => {
      if (failed) throw new Error('page navigated');
      return fn === cutText ? { samples, clipped: [], viewport: { width: 320, height: 180 }, visitedTextNodes: samples.length,
        partial: false, sampleLimit: 50, textNodeLimit: 10_000, canvasCount: 1, failedFonts: [] }
        : { isPage: true, isTimeline: false, viewport: { width: 320, height: 180 } };
    },
  }));
  return { film: { origin: 'http://film.test', meta: { width: 320, height: 180 }, page: { url: main.url, mainFrame: () => main, frames: () => [main, ...frames] } }, disposed: () => disposed };
}

test('共享 collector 保留实际 clip 身份、时间、本地坐标和未知覆盖，不从同源 URL 合并实例', async () => {
  const { film, disposed } = mockFilm({ count: 2 });
  const result = await collectFrameFindings(film, { time, stage: { w: 320, h: 180 }, targetWidth: 96, source: { kind: 'current-project', consistency: 'sample-window-not-atomic' } });
  assert.equal(disposed(), 2);
  const text = result.findings.filter((item) => item.code === 'dom-text-size');
  assert.deepEqual(text.map((item) => item.source.clipId), ['clip-0', 'clip-1']);
  assert.ok(text.every((item) => item.source.page === 'scene one.html' && item.time.actualTime === 2 && item.measurement.targetFontSizePx === 2.4));
  assert.ok(result.coverage.some((item) => item.code === 'canvas-webgl-and-contrast' && item.status === 'unknown' && item.details.canvasElements === 1));
  assert.ok(result.coverage.some((item) => item.code === 'text-target-projection' && item.status === 'observed' && item.details.projectedSamples === 1));
  const ajv = new Ajv({ allErrors: true });
  const validateFinding = ajv.compile(reviewFindingSchema), validateCoverage = ajv.compile(reviewCoverageSchema);
  for (const item of result.findings) assert.equal(validateFinding(item), true, JSON.stringify(validateFinding.errors));
  for (const item of result.coverage) assert.equal(validateCoverage(item), true, JSON.stringify(validateCoverage.errors));
  assert.equal(validateFinding({ ...text[0], status: 'passed' }), false);
  assert.equal(validateCoverage({ ...result.coverage[0], status: 'passed' }), false);
});

test('旧编码来源绝不访问当前 DOM；无采样、错误、跨源路径和上界都不伪称完整通过', async () => {
  const encoded = await collectFrameFindings({}, { time: { ...time, actualPTS: 2.75, timeBasis: 'encoded-pts' }, source: { kind: 'export-job', jobId: 'old-job' } });
  assert.deepEqual(encoded.findings, []);
  assert.equal(encoded.coverage[0].status, 'unknown');
  const unavailable = mockFilm({ failed: true });
  const failure = await collectFrameFindings(unavailable.film, { time, source: { kind: 'current-project' } });
  assert.equal(unavailable.disposed(), 1);
  assert.ok(failure.coverage.some((item) => item.details.reason === 'measurement-unavailable' && item.status === 'unknown'));
  const cross = mockFilm({ sourceURL: 'https://remote.example/scene.html' });
  const remote = await collectFrameFindings(cross.film, { time, stage: { w: 320 }, targetWidth: 96, source: { kind: 'live-check' } });
  assert.ok(remote.findings.every((item) => item.source.page === null));
  const transformed = mockFilm({ samples: [{ ...sample, localScaleY: null, projection: 'unknown-complex-transform' }] });
  const unknown = await collectFrameFindings(transformed.film, { time, stage: { w: 320 }, targetWidth: 96, source });
  assert.ok(unknown.coverage.some((item) => item.code === 'text-target-projection' && item.status === 'unknown' && item.details.projectedSamples === 0));
  const capped = mockFilm({ count: 4, samples: Array.from({ length: 50 }, (_, i) => ({ ...sample, sel: `#text-${i}` })) });
  const bounded = await collectFrameFindings(capped.film, { time, stage: { w: 320 }, targetWidth: 96, source });
  assert.equal(bounded.findings.length, MAX_REVIEW_FINDINGS);
  assert.ok(bounded.coverage.some((item) => item.code === 'dom-findings-limit' && item.status === 'partial' && item.details.droppedFindings === 144));
});

function measuredTextDom(count, svgMode = null) {
  const body = { tagName: 'BODY', parentElement: null };
  const svg = { tagName: 'svg', namespaceURI: 'http://www.w3.org/2000/svg', parentElement: body };
  const foreignObject = { tagName: 'foreignObject', namespaceURI: 'http://www.w3.org/2000/svg', parentElement: svg };
  const nodes = Array.from({ length: count }, (_, i) => ({ textContent: `标题 ${i}`, parentElement: { id: `title-${i}`, tagName: svgMode === 'text' ? 'text' : 'P',
    namespaceURI: svgMode === 'text' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', classList: [],
    parentElement: svgMode === 'text' ? svg : svgMode === 'foreignObject' ? foreignObject : body, checkVisibility: () => true } }));
  const document = { body, documentElement: {}, fonts: [], querySelectorAll: () => [null],
    createTreeWalker() { let i = 0; return { nextNode: () => nodes[i++] ?? null }; },
    createRange() { return { selectNodeContents() {}, getBoundingClientRect: () => ({ x: -4, y: 0, left: -4, top: 0, right: 16, bottom: 20, width: 20, height: 20 }) }; } };
  return { document, NodeFilter: { SHOW_TEXT: 4 }, innerWidth: 320, innerHeight: 180,
    getComputedStyle: () => ({ opacity: '1', overflowX: 'visible', overflowY: 'visible', perspective: 'none', zoom: '1', rotate: 'none', scale: 'none', writingMode: 'horizontal-tb', transform: 'none', fontSize: '8px' }) };
}

test('cutText 默认旧数组不变，扩展模式记录真实 bounds/font 并明确截断', () => {
  const old = JSON.parse(JSON.stringify(runInNewContext(`(${cutText.toString()})()`, measuredTextDom(1))));
  assert.deepEqual(old, [{ sel: '#title-0', why: 'edge', text: '标题 0' }]);
  const actual = runInNewContext(`(${cutText.toString()})({measure:true})`, measuredTextDom(51));
  assert.equal(actual.samples.length, 50);
  assert.equal(actual.partial, true);
  assert.equal(actual.samples[0].fontSizeCssPx, 8);
  assert.equal(actual.samples[0].bounds.x, -4);
  assert.equal(actual.samples[0].clipped, 'edge');
  assert.equal(actual.canvasCount, 1);
});

test('SVG text 和 foreignObject 保留实际 CSS 与 bounds，未核用户坐标映射时目标投影未知', () => {
  for (const svgMode of ['text', 'foreignObject']) {
    const measured = runInNewContext(`(${cutText.toString()})({measure:true})`, measuredTextDom(1, svgMode));
    const actual = measured.samples[0];
    assert.equal(actual.fontSizeCssPx, 8, svgMode);
    assert.equal(actual.bounds.x, -4, svgMode);
    assert.equal(actual.clipped, 'edge', svgMode);
    assert.equal(actual.projection, 'unknown-complex-transform', svgMode);
    assert.equal(actual.localScaleY, null, svgMode);
    const findings = textSampleFindings(actual, { time, source, viewport: measured.viewport, stageWidth: 320, targetWidth: 96, outerScaleY: 1 });
    assert.equal(findings[0].measurement.targetFontSizePx, null, svgMode);
    assert.equal(findings[0].measurement.fontSizeCssPx, 8, svgMode);
    assert.equal(findings[1].code, 'dom-text-clipping', svgMode);
  }
});
