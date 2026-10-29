/** 工程审片沿同一字幕投影/HTML合成；只在本次浏览器副本绘制，不改作品或人工锁。 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { subtitlesForExport, SUBTITLE_STYLE_FILE } from './captions.mjs';
import { filmSubtitleAt, filmSubtitleShown, filmSubtitleFrameHtml } from './film-subtitle.mjs';
import { reviewFacts } from './review-facts.mjs';
import { reviewFinding, reviewCoverage } from '../../src/review-findings.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const limitations = ['同次工程seek、DOM测量与PNG捕获不是原子快照，不证明编码成片、声音或全区间每帧。', '完整边界采用DOM行盒/元素盒与保守描边和三倍模糊半径阴影，不是逐像素字形或审美判断。'];

/** 在浏览器中调用，测量显式选中的信息对象，包含越出stage的部分而不先裁切。 */
export function measureInformationTargets(selectors) {
  const out = []; let elements = 0;
  const finite = (v) => Number.isFinite(v);
  for (const selector of selectors) {
    let targets;
    try { targets = document.querySelectorAll(selector); } catch { out.push({ selector, status: 'unknown', reason: 'invalid-selector' }); continue; }
    if (!targets.length) { out.push({ selector, status: 'unknown', reason: 'selector-not-found' }); continue; }
    if (targets.length > 64) { out.push({ selector, status: 'unknown', reason: 'selector-match-budget' }); continue; }
    for (const target of targets) {
      if (out.length >= 64 || elements >= 2048) { out.push({ selector, status: 'unknown', reason: 'frame-target-budget' }); return out; }
      const descendants = [target], walker = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT);
      let next; while (descendants.length <= 512 && (next = walker.nextNode())) descendants.push(next);
      elements += descendants.length;
      if (descendants.length > 512 || elements > 2048) { out.push({ selector, status: 'unknown', reason: 'element-budget' }); continue; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, unknown = null, visible = false;
      const include = (r, e = { l: 0, t: 0, r: 0, b: 0 }) => {
        if (![r.left, r.top, r.right, r.bottom].every(finite) || !(r.width > 0 && r.height > 0)) return;
        x0 = Math.min(x0, r.left - e.l); y0 = Math.min(y0, r.top - e.t); x1 = Math.max(x1, r.right + e.r); y1 = Math.max(y1, r.bottom + e.b);
      };
      for (const el of descendants) {
        const cs = getComputedStyle(el); let shown = true, sx = 1, sy = 1;
        for (let node = el; node; node = node.parentElement) {
          const s = getComputedStyle(node);
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) <= 0.001) shown = false;
          if (s.perspective !== 'none' || (s.rotate && s.rotate !== 'none') || (s.scale && s.scale !== 'none') || (s.zoom && Number(s.zoom) !== 1) || (s.filter && s.filter !== 'none')) unknown ??= 'complex-transform-or-filter';
          if (s.transform && s.transform !== 'none') {
            const m = new DOMMatrixReadOnly(s.transform);
            if (!m.is2D || Math.abs(m.b) > 1e-8 || Math.abs(m.c) > 1e-8 || !(m.a > 0 && m.d > 0)) unknown ??= 'complex-transform-or-filter';
            else { sx *= m.a; sy *= m.d; }
          }
        }
        if (!shown) continue;
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) {
          // 水平/垂直SVG线条的几何盒可为零，但描边仍然绘制，不能忽略后宣称容器完整安全。
          if (el instanceof SVGElement && cs.stroke !== 'none' && Number.parseFloat(cs.strokeWidth) > 0) unknown ??= 'degenerate-svg-stroke';
          continue;
        }
        visible = true;
        for (const pseudo of ['::before', '::after']) {
          const content = getComputedStyle(el, pseudo).content;
          if (content && !['none', 'normal', '""', "''"].includes(content)) unknown ??= 'pseudo-element';
        }
        if (el instanceof HTMLCanvasElement) unknown ??= 'canvas-content';
        if (el instanceof SVGElement && cs.stroke !== 'none' && Number.parseFloat(cs.strokeWidth) > 0) {
          const m = el.getScreenCTM?.();
          if (!m || Math.abs(m.b) > 1e-8 || Math.abs(m.c) > 1e-8) unknown ??= 'svg-stroke-transform';
          else { sx = Math.abs(m.a); sy = Math.abs(m.d); }
        }
        if (el instanceof SVGElement && ['markerStart', 'markerMid', 'markerEnd'].some((k) => cs[k] && cs[k] !== 'none')) unknown ??= 'svg-markers';
        if (el instanceof SVGElement && cs.stroke !== 'none' && cs.strokeLinejoin === 'miter' && ['path', 'polyline', 'polygon'].includes(el.localName)) unknown ??= 'svg-miter-join';
        const stroke = Math.max(Number.parseFloat(cs.webkitTextStrokeWidth) / 2 || 0, cs.stroke !== 'none' && el instanceof SVGElement ? Number.parseFloat(cs.strokeWidth) / 2 || 0 : 0, cs.outlineStyle !== 'none' ? Math.max(0, (Number.parseFloat(cs.outlineWidth) || 0) + (Number.parseFloat(cs.outlineOffset) || 0)) : 0);
        const effect = { l: stroke * sx, r: stroke * sx, t: stroke * sy, b: stroke * sy };
        for (const shadow of [cs.textShadow, cs.boxShadow]) {
          for (const item of shadow.replace(/rgba?\([^)]*\)/g, '').split(',')) {
            const nums = [...item.matchAll(/(-?(?:\d+\.?\d*|\.\d+))px/g)].map((m) => Number(m[1]));
            if (nums.length < 2) continue;
            const [dx, dy, blur = 0, spread = 0] = nums, extent = Math.max(0, 3 * blur + spread);
            effect.l = Math.max(effect.l, (extent - dx) * sx); effect.r = Math.max(effect.r, (extent + dx) * sx);
            effect.t = Math.max(effect.t, (extent - dy) * sy); effect.b = Math.max(effect.b, (extent + dy) * sy);
          }
        }
        include(r, effect);
        // Range包含实际文本行；节点盒同时保留行高、背景和padding。
        for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          const range = document.createRange(); range.selectNodeContents(node);
          for (const rect of range.getClientRects()) include(rect, effect);
        }
      }
      out.push({ selector, status: unknown ? 'unknown' : visible ? 'observed' : 'not-visible', reason: unknown,
        bounds: visible ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null });
    }
  }
  return out;
}

const filmBounds = (b, map) => ({ x: map.x + b.x * map.sx, y: map.y + b.y * map.sy, width: b.width * map.sx, height: b.height * map.sy });
const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
function informationFinding(sample, { time, source, map, stage, safeArea }) {
  const bounds = sample.bounds && filmBounds(sample.bounds, map);
  const safeY = safeArea ? [stage.h * safeArea.top, stage.h * (1 - safeArea.bottom)] : null;
  return reviewFinding('information-bounds', { severity: sample.status === 'observed' && safeY && (bounds.y < safeY[0] || bounds.y + bounds.height > safeY[1]) ? 'warning' : 'info',
    status: sample.status === 'observed' ? 'observed' : 'unknown', time, source, selector: sample.selector,
    bounds: bounds ? { coordinateSpace: 'film-pixels', ...bounds } : null,
    measurement: { method: 'axis-aligned-full-element-linebox-and-conservative-effects', safeY, reason: sample.reason ?? (sample.status === 'not-visible' ? 'not-visible-at-sample' : null),
      safeAreaRelation: sample.status !== 'observed' ? 'unknown' : !safeY ? 'not-requested' : bounds.y >= safeY[0] && bounds.y + bounds.height <= safeY[1] ? 'inside' : 'outside', effects: 'stroke-and-3x-shadow-blur-envelope' },
    evidence: [{ kind: 'same-seek-dom', coordinateMapping: map }], limitations });
}

/** 只读冻结输入；字幕投影摘要与原始文件SHA均由本次review回执绑定。 */
export async function prepareReviewComposition(root, stage) {
  const [{ cues, style }, film] = await Promise.all([subtitlesForExport(root), readFile(join(root, 'film.html'))]);
  let raw;
  try { raw = await readFile(join(root, SUBTITLE_STYLE_FILE)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const subtitleSource = { kind: 'studio-external-subtitles', cueCount: cues.length, enabled: style.on,
    projectionSha256: hash(JSON.stringify(cues)), styleInput: raw ? { path: SUBTITLE_STYLE_FILE, bytes: raw.length, sha256: hash(raw) } : { path: SUBTITLE_STYLE_FILE, status: 'absent-using-default' },
    sources: [...new Map(cues.map((c) => [c.src, { src: c.src, sourceRevision: c.sourceRevision }])).values()],
    rendering: 'same-filmSubtitleFrameHtml-as-export', limitations: ['同源样式和字幕投影不证明系统字体或浏览器环境跨机器一致；未转写音轨不自动识别。'] };
  const intents = reviewFacts(film).intents ?? [];
  return {
    subtitleSource,
    async draw(film, time, { safeArea, targetWidth } = {}) {
      const findings = [], coverage = [], source = { kind: 'current-project', layer: 'studio-subtitles', consistency: 'same-seek-capture-window-not-atomic' };
      const info = []; let targetCount = 0, targetLimited = intents.length > 32;
      // 场景只测显式标注的信息对象，不把装饰、未标注内容或Canvas猜成必要文字。
      for (const intent of intents.slice(0, 32)) {
        if (targetCount >= 64) { targetLimited = true; break; }
        const declaredTargets = intent.value?.text?.filter((t) => t.role !== 'decorative') ?? [];
        const targets = declaredTargets.slice(0, 64 - targetCount);
        if (declaredTargets.length > targets.length) targetLimited = true;
        if (intent.status !== 'observed' || !targets.length) continue;
        // clip与iframe的关系由时间线真实stage给出，不按URL猜来源。
        const owner = await film.page.evaluateHandle((id) => window.__filmEditor?.stage?.clips?.().find((c) => c.id === id)?.el ?? null, intent.clipId);
        try {
          const el = owner.asElement(), child = await el?.contentFrame();
          if (!el || !child) { coverage.push(reviewCoverage('information-targets', { time, source: { kind: 'current-project', clipId: intent.clipId }, details: { measured: false, reason: 'clip-frame-unavailable' }, limitations })); continue; }
          const placement = await el.evaluate((node) => {
            const r = node.getBoundingClientRect(), w = node.contentWindow;
            let simple = true, visible = true;
            for (let n = node; n; n = n.parentElement) {
              const s = getComputedStyle(n);
              if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) <= 0.001) visible = false;
              if (s.perspective !== 'none' || (s.rotate && s.rotate !== 'none') || (s.scale && s.scale !== 'none') || (s.zoom && Number(s.zoom) !== 1) || (s.filter && s.filter !== 'none')) simple = false;
              if (s.transform && s.transform !== 'none') { const m = new DOMMatrixReadOnly(s.transform); if (!m.is2D || Math.abs(m.b) > 1e-8 || Math.abs(m.c) > 1e-8 || !(m.a > 0 && m.d > 0)) simple = false; }
            }
            const s = getComputedStyle(node);
            if (['borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom'].some((k) => Number.parseFloat(s[k]) !== 0)) simple = false;
            return { simple, visible, map: { x: r.x, y: r.y, sx: r.width / w.innerWidth, sy: r.height / w.innerHeight } };
          });
          if (!placement.visible) continue;
          const samples = await child.evaluate(measureInformationTargets, targets.flatMap((t) => t.selector ? [t.selector] : []));
          for (const target of targets.filter((t) => !t.selector)) samples.push({ selector: null, status: 'unknown', reason: 'semantic-intent-without-selector' });
          if (samples.length > 64 - targetCount) targetLimited = true;
          for (const sample of samples.slice(0, 64 - targetCount)) {
            targetCount++;
            if (!placement.simple) { sample.status = 'unknown'; sample.reason = 'complex-parent-placement'; }
            const finding = informationFinding(sample, { time, source: { kind: 'current-project', clipId: intent.clipId, layer: 'scene-information' }, map: placement.map, stage, safeArea });
            findings.push(finding); if (finding.status === 'observed' && finding.bounds) info.push(finding);
          }
        } catch (e) { coverage.push(reviewCoverage('information-targets', { time, source: { kind: 'current-project', clipId: intent.clipId }, details: { measured: false, reason: 'measurement-unavailable' }, limitations })); }
        finally { await owner.dispose(); }
      }
      coverage.push(reviewCoverage('information-targets', { status: intents.length ? 'partial' : 'unknown', time, source: { kind: 'current-project' }, details: { declaredClips: intents.length, sampledTargets: targetCount, measuredTargets: info.length, targetLimit: 64, clippedByBudget: targetLimited, scope: 'explicit-essential-or-supporting-selectors-only' }, limitations: [...limitations, '未标注对象、视频内文字/人脸和Canvas/WebGL语义不由DOM目标覆盖。'] }));
      const html = filmSubtitleFrameHtml(cues, style, stage, time.actualTime * 1000);
      if (!html) {
        coverage.push(reviewCoverage('studio-subtitle-layer', { status: 'observed', time, source, details: { rendered: false, reason: !style.on ? 'subtitles-off' : !cues.length ? 'no-cues' : 'no-active-cue', projectionSha256: subtitleSource.projectionSha256 }, limitations }));
        return { findings, coverage, cleanup: async () => {} };
      }
      // 先取真实FilmPage画面，再在同一浏览器的独立合成页叠字幕；影片根CSS也不能污染外置字幕。
      const picture = await film.capture({ format: 'png' });
      const page = await film.context.newPage();
      const cleanup = async () => { await page.close().catch(() => {}); };
      try {
        await page.setViewportSize({ width: stage.w, height: stage.h });
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}img{position:absolute;left:0;top:0;width:${stage.w}px;height:${stage.h}px}</style></head><body><img src="data:image/png;base64,${picture.toString('base64')}" alt="">${html}</body></html>`);
        await page.evaluate(async () => { await Promise.all([...document.images].map((i) => i.decode())); await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
        const cdp = await film.context.newCDPSession(page);
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        const capture = () => film.capture.call({ meta: { width: stage.w, height: stage.h }, scale: film.scale, cdp }, { format: 'png' });
        const samples = await page.evaluate(measureInformationTargets, ['[data-timing-origin]']);
        const cue = filmSubtitleAt(filmSubtitleShown(cues, style), time.actualTime * 1000);
        for (const sample of samples) {
          const finding = informationFinding(sample, { time, source: { ...source, clipId: cue?.clip, subtitleSourceRevision: cue?.sourceRevision }, map: { x: 0, y: 0, sx: 1, sy: 1 }, stage, safeArea });
          finding.code = 'subtitle-information-bounds';
          finding.measurement = { ...finding.measurement, text: cue?.text, targetWidthPx: targetWidth ?? null };
          findings.push(finding);
          if (finding.status === 'observed' && finding.bounds) for (const other of info) if (intersects(finding.bounds, other.bounds)) findings.push(reviewFinding('subtitle-information-overlap', { severity: 'warning', time, source, selector: other.selector, bounds: finding.bounds, measurement: { otherSource: other.source, otherBounds: other.bounds, method: 'same-time-full-information-box-intersection' }, evidence: [], limitations: [...limitations, '包围盒相交不等于文字像素实际互相遮挡；修订仍由导演判断。'] }));
        }
        coverage.push(reviewCoverage('studio-subtitle-layer', { status: samples.every((s) => s.status === 'observed') ? 'observed' : 'partial', time, source,
          details: { rendered: true, renderer: 'filmSubtitleFrameHtml', sourceRevision: cue?.sourceRevision ?? null, projectionSha256: subtitleSource.projectionSha256 }, limitations }));
        return { findings, coverage, cleanup, capture };
      } catch (e) { await cleanup(); throw e; }
    },
  };
}
