import { cutText } from './shared.mjs';

export const MAX_REVIEW_FINDINGS = 256;
const nullableNumber = { type: ['number', 'null'] };
const timeSchema = {
  type: ['object', 'null'], description: '实际采样时钟；null 表示此事实不属于一个已采样画面。',
  required: ['requestedTime', 'actualTime', 'actualPTS', 'timeBasis'], additionalProperties: true,
  properties: {
    requestedTime: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }], description: '调用者请求时间或 last；与实际时间分开。' },
    actualTime: { ...nullableNumber, description: '实际采样相对时间，单位秒；未测时为 null。' },
    actualPTS: { ...nullableNumber, description: '实际编码时间戳，单位秒；DOM 预览为 null。' },
    timeBasis: { type: 'string', description: '采样时钟来源，例如 project-seek 或 encoded-pts；不将预览时钟冒充编码 PTS。' },
  },
};
const sourceSchema = {
  type: 'object', description: '实际测量的来源；回执可补充版本与输入摘要，不从 URL 猜测 clip 身份。',
  required: ['kind'], additionalProperties: true,
  properties: {
    kind: { type: 'string', description: 'current-project 为冻结工程采样，live-check 为无版本 fence 的直接检查，export-job 为旧编码输出。' },
    page: { type: ['string', 'null'], description: '同源页面实际 URL 的工程相对路径，不包含 fragment；未知或跨源时为 null。' },
    clipId: { type: ['string', 'null'], description: '仅来自 stage.clips() 对实际 iframe 元素的匹配；未能确认时为 null。' },
    inputSha256: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$', description: '回执精确匹配静态输入文件时附加的摘要；未知时不补造。' },
    consistency: { type: 'string', description: 'DOM 与画面只属于同次采样窗口，不是跨 DOM/像素原子快照；live-check 不提供源版本 fence。' },
  },
};
const boundsSchema = {
  type: ['object', 'null'], description: 'DOM Range 的轴对齐包围盒；不是逐像素字形，也不证明没有遮挡。',
  required: ['coordinateSpace', 'x', 'y', 'width', 'height'], additionalProperties: false,
  properties: {
    coordinateSpace: { const: 'page-css-pixels', description: '当前 page/iframe 本地 CSS 像素；不能直接当作整部影片像素。' },
    x: { type: 'number', description: '本地视口横坐标。' }, y: { type: 'number', description: '本地视口纵坐标。' },
    width: { type: 'number', minimum: 0, description: '轴对齐包围盒宽度。' }, height: { type: 'number', minimum: 0, description: '轴对齐包围盒高度。' },
  },
};

export const reviewFindingSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
  description: '一次实际测量的事实或明确未知项；不是审美评分、完成判定或自动导出门禁。',
  required: ['code', 'severity', 'status', 'time', 'source', 'selector', 'bounds', 'measurement', 'evidence', 'limitations'],
  properties: {
    code: { type: 'string', minLength: 1, description: '稳定事实类别；文字尺寸与裁切使用不同 code。' },
    severity: { enum: ['info', 'warning', 'error'], description: '技术事实的提示级别；info 字号没有全局最小字号合格线。' },
    status: { enum: ['observed', 'unknown'], description: 'observed 仅表示已测此事实；unknown、无 finding 和未执行都不等于通过。' },
    time: timeSchema, source: sourceSchema,
    selector: { type: ['string', 'null'], description: '实际 DOM 采样元素的定位提示；可能不唯一，不据此宣称覆盖全部匹配元素。' },
    bounds: boundsSchema,
    measurement: { type: 'object', description: '在实际测量点记录的数值、单位与方法；无法可靠推算的值为 null。', additionalProperties: true },
    evidence: { type: 'array', description: '测量方法或明确绑定的证据引用；未绑摘要不冒称已验证 PNG 内容。', items: { type: 'object', additionalProperties: true } },
    limitations: { type: 'array', description: '采样、坐标、动态资源与未测能力边界。', items: { type: 'string' } },
  },
};
export const findingSchema = reviewFindingSchema;
export const reviewCoverageSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
  description: '检查实际覆盖范围；observed 不是质量通过，partial 和 unknown 不可当作完整验收。',
  required: ['code', 'status', 'time', 'source', 'details', 'limitations'],
  properties: {
    code: { type: 'string', description: '所描述的采样能力或范围。' },
    status: { enum: ['observed', 'unknown', 'partial'], description: '实际执行、不能测量或上界截断。' },
    time: timeSchema, source: sourceSchema,
    details: { type: 'object', description: '实际数量、上界、坐标及测量口径。', additionalProperties: true },
    limitations: { type: 'array', description: '不由此覆盖证明的能力。', items: { type: 'string' } },
  },
};

export function reviewFinding(code, { severity = 'info', status = 'observed', time = null, source, selector = null, bounds = null, measurement = {}, evidence = [], limitations = [] }) {
  return { code, severity, status, time, source, selector, bounds, measurement, evidence, limitations };
}
export function reviewCoverage(code, { status = 'unknown', time = null, source, details = {}, limitations = [] }) {
  return { code, status, time, source, details, limitations };
}

const finitePositive = (value) => Number.isFinite(value) && value > 0;
const samplingLimitations = ['DOM 与 PNG 为同一次 seek/capture 的采样窗口，不保证跨 DOM/像素原子一致。', '包围盒不识别字形、遮挡、背景对比度或人工修改的语义正确性。'];

/** 纯数值映射；不设审美字号阈值，不把复杂几何的包围盒当作实际字形。 */
export function textSampleFindings(sample, { time, source, viewport, stageWidth, targetWidth, outerScaleY = null }) {
  const canProject = sample.projection === 'axis-aligned-css' && finitePositive(sample.localScaleY)
    && finitePositive(outerScaleY) && finitePositive(stageWidth) && finitePositive(targetWidth) && finitePositive(sample.fontSizeCssPx);
  const targetScale = finitePositive(stageWidth) && finitePositive(targetWidth) ? targetWidth / stageWidth : null;
  const bounds = { coordinateSpace: 'page-css-pixels', ...sample.bounds };
  const limitations = [...samplingLimitations];
  if (!canProject) limitations.push('未可靠确认字号到目标图像的完整轴对齐变换，targetFontSizePx 为 null。');
  const findings = [reviewFinding('dom-text-size', { time, source, selector: sample.sel, bounds,
    measurement: { text: sample.text, fontSizeCssPx: sample.fontSizeCssPx, localScaleY: sample.localScaleY,
      outerScaleY, stageWidthCssPx: stageWidth, targetWidthPx: targetWidth ?? null,
      targetScale, targetFontSizePx: canProject ? sample.fontSizeCssPx * sample.localScaleY * outerScaleY * targetScale : null,
      viewport, method: 'computed-font-size-and-axis-aligned-transform', unit: 'pixels', aestheticThreshold: null },
    evidence: [{ kind: 'dom-range', sample: 'same-seek-capture-window' }], limitations })];
  if (sample.clipped) findings.push(reviewFinding('dom-text-clipping', { severity: 'warning', time, source, selector: sample.sel, bounds,
    measurement: { boundary: sample.clipped === 'edge' ? 'page-viewport' : 'overflow-box', clipBounds: sample.clipBounds,
      toleranceCssPx: 2, method: 'partially-overlapping-dom-range-bounds', unit: 'css-pixels' },
    evidence: [{ kind: 'dom-range', sample: 'same-seek-capture-window' }], limitations: [...samplingLimitations, '只记录部分相交且超过边界 2 CSS 像素的包围盒；未检测到不表示可读或无裁切。'] }));
  return findings;
}

function pagePath(frame, film) {
  try {
    const actual = new URL(frame.url()), origin = new URL(film.origin ?? film.page.url()).origin;
    return actual.origin === origin && /^https?:$/.test(actual.protocol) ? decodeURIComponent(actual.pathname).replace(/^\/+/, '') : null;
  } catch { return null; }
}

/** 同一 FilmPage 已 seek/capture 后读取 DOM；不新建浏览器、不重绘，不把旧编码帧送入当前 DOM。 */
export async function collectFrameFindings(film, { time = null, stage = {}, targetWidth = null, source = { kind: 'current-project' } } = {}) {
  const findings = [], coverage = [];
  const originSource = { ...source, page: null, clipId: null, inputSha256: null };
  if (!['current-project', 'live-check'].includes(source.kind)) {
    return { findings, coverage: [reviewCoverage('dom-text', { time, source: originSource, details: { measured: false }, limitations: ['编码输出没有当前 DOM、字体或 override 的测量证明。'] })] };
  }
  const main = film.page.mainFrame(), frames = film.page.frames();
  const width = stage.w ?? stage.width ?? film.meta?.width;
  let dropped = 0;
  for (const frame of frames.slice(0, 32)) {
    const currentSource = { ...originSource, page: pagePath(frame, film) };
    let owner = null, placement = null, context;
    try {
      if (frame !== main) {
        owner = await frame.frameElement();
        placement = await owner.evaluate((el) => {
          const doc = el.ownerDocument, win = doc.defaultView;
          const clip = win.__filmEditor?.stage?.clips?.().find((candidate) => candidate.el === el);
          const r = el.getBoundingClientRect();
          let visible = r.width > 0 && r.height > 0, simple = true;
          for (let node = el; node; node = node.parentElement) {
            const cs = win.getComputedStyle(node);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05) visible = false;
            if (cs.perspective !== 'none' || (cs.rotate && cs.rotate !== 'none') || (cs.scale && cs.scale !== 'none')
              || (cs.zoom && Number(cs.zoom) !== 1) || (cs.clipPath && cs.clipPath !== 'none') || (cs.filter && cs.filter !== 'none')) simple = false;
            if (cs.transform && cs.transform !== 'none') {
              try { const m = new win.DOMMatrixReadOnly(cs.transform); if (!m.is2D || Math.abs(m.b) > 1e-8 || Math.abs(m.c) > 1e-8 || !(m.a > 0 && m.d > 0)) simple = false; }
              catch { simple = false; }
            }
          }
          return { visible, simple, clipId: typeof clip?.id === 'string' ? clip.id : null, nativeWidth: clip?.nw ?? null,
            nativeHeight: clip?.nh ?? null, shown: clip?.shown ?? null, drawn: clip?.drawn ?? null,
            rect: { width: r.width, height: r.height }, parentViewportWidth: win.innerWidth,
            hasBorder: ['borderTopWidth', 'borderBottomWidth', 'paddingTop', 'paddingBottom'].some((key) => Number.parseFloat(win.getComputedStyle(el)[key]) !== 0) };
        });
        currentSource.clipId = placement.clipId;
        if (!placement.visible || placement.shown === false || placement.drawn === false) {
          coverage.push(reviewCoverage('dom-page', { time, source: currentSource, details: { sampled: false, reason: 'not-visible-or-not-drawn' }, limitations: ['隐藏或未绘制页面没有文字可读性结论。'] }));
          continue;
        }
      }
      context = await frame.evaluate(() => ({ isPage: Boolean(window.film && typeof window.film.frame === 'function'),
        isTimeline: Boolean(window.__filmEditor?.stage?.clips), viewport: { width: innerWidth, height: innerHeight } }));
      if (!context.isPage || context.isTimeline) {
        if (!context.isTimeline) coverage.push(reviewCoverage('dom-page', { time, source: currentSource, details: { sampled: false, reason: 'no-film-frame' }, limitations: ['只对真实 FilmPage 的可见页面测量；未声明 frame 的嵌入内容未知。'] }));
        continue;
      }
      const measured = await frame.evaluate(cutText, { measure: true });
      let outerScaleY = null;
      if (frame === main && Math.abs(context.viewport.width - width) < 1) outerScaleY = 1;
      else if (placement?.simple && !placement.hasBorder && frame.parentFrame() === main && placement.clipId
        && Math.abs(placement.nativeWidth - context.viewport.width) < 1 && Math.abs(placement.nativeHeight - context.viewport.height) < 1
        && Math.abs(placement.parentViewportWidth - width) < 1) outerScaleY = placement.rect.height / context.viewport.height;
      let projectedSamples = 0;
      for (const sample of measured.samples) {
        const facts = textSampleFindings(sample, { time, source: currentSource, viewport: measured.viewport, stageWidth: width, targetWidth, outerScaleY });
        if (facts[0].measurement.targetFontSizePx !== null) projectedSamples += 1;
        for (const item of facts) {
          if (findings.length < MAX_REVIEW_FINDINGS) findings.push(item); else dropped += 1;
        }
      }
      for (const family of new Set(measured.failedFonts)) {
        const item = reviewFinding('font-load-error', { severity: 'error', time, source: currentSource, measurement: { family, status: 'error' },
          evidence: [{ kind: 'document-fonts-status' }], limitations: ['仅为采样时此文档 FontFaceSet 中的 error，不证明所有所需字形或后续字体加载。'] });
        if (findings.length < MAX_REVIEW_FINDINGS) findings.push(item); else dropped += 1;
      }
      coverage.push(reviewCoverage('dom-text', { status: measured.partial ? 'partial' : 'observed', time, source: currentSource,
        details: { sampled: true, samples: measured.samples.length, sampleLimit: measured.sampleLimit, visitedTextNodes: measured.visitedTextNodes,
          textNodeLimit: measured.textNodeLimit, viewport: measured.viewport, targetWidthPx: targetWidth, projectionAvailable: outerScaleY !== null },
        limitations: [...samplingLimitations, '仅采样可见文字节点，每个父元素至多一个节点；SVG 图形、伪元素及完全在视口外文字不由此覆盖。'] }));
      coverage.push(reviewCoverage('canvas-webgl-and-contrast', { time, source: currentSource,
        details: { canvasElements: measured.canvasCount, glyphPixelsMeasured: false, backgroundContrastMeasured: false },
        limitations: ['不读取 Canvas/WebGL 字形或像素背景；复杂背景、遮挡与实际对比度未知。', 'canvasElements 为 DOM 元素计数，不证明采用何种绘制上下文或画面质量。'] }));
      coverage.push(reviewCoverage('text-target-projection', { status: measured.samples.length > 0 && projectedSamples === measured.samples.length ? 'observed' : 'unknown',
        time, source: currentSource, details: { textSamples: measured.samples.length, projectedSamples, targetWidthPx: targetWidth },
        limitations: ['复杂或未确认变换、缺少目标宽度或没有文字样本时，不能推断目标图中文字可读。', '目标字号是轴对齐几何估算，不是实际字形像素或审美通过线。'] }));
    } catch (error) {
      coverage.push(reviewCoverage('dom-page', { time, source: currentSource, details: { sampled: false, reason: 'measurement-unavailable', message: String(error?.message ?? error) },
        limitations: ['页面导航、跨源、关闭或测量错误不当作 DOM 检查通过。'] }));
    } finally { await owner?.dispose().catch(() => {}); }
  }
  if (frames.length > 32 || dropped) coverage.push(reviewCoverage('dom-findings-limit', { status: 'partial', time, source: originSource,
    details: { frameLimit: 32, framesPresent: frames.length, findingLimit: MAX_REVIEW_FINDINGS, droppedFindings: dropped }, limitations: ['超出上界的页面或事实未完整返回，不能据剩余列表宣称完整覆盖。'] }));
  return { findings, coverage };
}
