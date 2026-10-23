/** 有界时间窗及活动事实；不评分、不按阈值替导演选择节奏或剪片。 */
export const SEQUENCE_MAX_SECONDS = 30;
export const SEQUENCE_MAX_FRAMES = 1800;
export const SEQUENCE_MAX_SAMPLES = 24;

export function sequenceWindow(ask) {
  if (!ask || !Number.isFinite(ask.start) || !Number.isFinite(ask.end)
    || ask.start < 0 || ask.end - ask.start < 0.001 || ask.end - ask.start > SEQUENCE_MAX_SECONDS
    || !Number.isInteger(ask.count) || ask.count < 8 || ask.count > SEQUENCE_MAX_SAMPLES) throw new Error('序列需要0–30秒内的正时间窗及8–24个观察点。');
  return ask;
}

/** 编码时钟相对首个实际帧；半开区间只选择真实存在的帧，VFR 不按帧率猜。 */
export function sequencePoints(timestamps, ask) {
  sequenceWindow(ask);
  const relative = timestamps.map((pts) => Number((pts - timestamps[0]).toFixed(6)));
  const eligible = relative.map((time, index) => ({ time, index })).filter((p) => p.time >= ask.start && p.time < ask.end);
  if (!eligible.length) throw new Error('序列时间窗内没有实际编码帧。');
  if (eligible.length > SEQUENCE_MAX_FRAMES) throw new Error('序列时间窗超过1800真实帧预算；请选择更短窗口。');
  const lastTime = eligible.at(-1).time;
  const points = Array.from({ length: ask.count }, (_, i) => {
    const requestedTime = i === ask.count - 1 ? lastTime : Number((ask.start + (lastTime - ask.start) * i / (ask.count - 1)).toFixed(6));
    const chosen = eligible.find((p) => p.time >= requestedTime) ?? eligible.at(-1);
    return { requestedTime, actualTime: chosen.time, index: chosen.index, pts: timestamps[chosen.index] };
  });
  return { points, eligible, relative };
}

export function projectSequencePoints(duration, ask) {
  sequenceWindow(ask);
  if (ask.end > duration || ask.start >= duration) throw new Error('序列时间窗超出当前工程 duration。');
  const last = Math.max(ask.start, ask.end - 0.001);
  return Array.from({ length: ask.count }, (_, i) => ({ requestedTime: ask.start + (last - ask.start) * i / (ask.count - 1), actualTime: ask.start + (last - ask.start) * i / (ask.count - 1) }));
}

/** 低分辨率灰度差只描述像素活动；完全相同也不自动判定冻结或坏片。 */
export function lumaActivity(bytes, dimensions, eligible, ask) {
  const frameBytes = dimensions.width * dimensions.height;
  if (eligible.length > SEQUENCE_MAX_FRAMES || bytes.length !== frameBytes * eligible.length) throw new Error('序列灰度解码帧数与探测不符。');
  const windows = new Map(); let identicalAdjacentPairs = 0;
  for (let i = 0; i < eligible.length; i++) {
    const bucket = Math.floor(eligible[i].time - ask.start), frame = bytes.subarray(i * frameBytes, (i + 1) * frameBytes);
    let w = windows.get(bucket);
    if (!w) { w = { firstActualTime: eligible[i].time, lastActualTime: eligible[i].time, frames: 0, adjacentPairs: 0, meanAbsoluteLumaDelta: null, maxAbsoluteLumaDelta: null, maximumFrameGapSeconds: null, sum: 0 }; windows.set(bucket, w); }
    w.frames++; w.lastActualTime = eligible[i].time;
    if (i === 0) continue;
    const previous = bytes.subarray((i - 1) * frameBytes, i * frameBytes);
    let total = 0; for (let k = 0; k < frameBytes; k++) total += Math.abs(frame[k] - previous[k]);
    const delta = total / (frameBytes * 255);
    if (delta === 0) identicalAdjacentPairs++;
    w.sum += delta; w.adjacentPairs++; w.maxAbsoluteLumaDelta = Math.max(w.maxAbsoluteLumaDelta ?? 0, delta);
    w.maximumFrameGapSeconds = Math.max(w.maximumFrameGapSeconds ?? 0, eligible[i].time - eligible[i - 1].time);
  }
  return { method: 'all-selected-decoded-frames-downscaled-gray8', analysisRaster: dimensions, decodedFrames: eligible.length,
    firstActualTime: eligible[0].time, lastActualTime: eligible.at(-1).time, identicalAdjacentPairs,
    windows: [...windows.values()].map(({ sum, ...w }) => ({ ...w, meanAbsoluteLumaDelta: w.adjacentPairs ? sum / w.adjacentPairs : null })),
    limitations: ['灰度栅格的逐帧差不是物体速度、语义节奏、审美或闪烁安全认证；没有活动也可能是有意停留。', '只覆盖明确时间窗内的实际帧；最后实际PTS不代表容器尾部或音频时长。'] };
}

/** 每格像素坐标明确；整图 cap 可能使观察格小于调用者期望。 */
export function sequenceLayout(samples, maxEdge) {
  if (!samples.length || samples.some((s) => s.width !== samples[0].width || s.height !== samples[0].height)) throw new Error('序列捕获尺寸发生变化，不能按固定格子冒充等比缩放。');
  const columns = Math.min(6, Math.ceil(Math.sqrt(samples.length * samples[0].width / samples[0].height)));
  const rows = Math.ceil(samples.length / columns);
  const scale = Math.min(1, 360 / samples[0].width, maxEdge / (samples[0].width * columns), maxEdge / (samples[0].height * rows));
  const width = Math.max(1, Math.floor(samples[0].width * scale)), height = Math.max(1, Math.floor(samples[0].height * scale));
  return { coordinateSpace: 'artifact-pixels', width: width * columns, height: height * rows, columns, rows,
    cells: samples.map((s, i) => ({ sequenceIndex: i, x: i % columns * width, y: Math.floor(i / columns) * height, width, height,
      sourceWidth: s.width, sourceHeight: s.height, scale: width / s.width, requestedTime: s.requestedTime, actualTime: s.actualTime,
      actualPTS: s.actualPTS, timeBasis: s.timeBasis })) };
}

/** 多尺寸从同一原捕获派生；竖排保留真实格子宽度，整图不足时再次明确缩小。 */
export function comparisonLayout(capture, widths, maxEdge) {
  const desired = widths.map((requestedWidth) => ({ requestedWidth, width: Math.min(requestedWidth, capture.width), height: Math.max(1, Math.floor(capture.height * Math.min(requestedWidth, capture.width) / capture.width)) }));
  const scale = Math.min(1, maxEdge / Math.max(...desired.map((c) => c.width)), maxEdge / desired.reduce((n, c) => n + c.height, 0));
  let y = 0;
  const cells = desired.map((c) => {
    const width = Math.max(1, Math.floor(c.width * scale)), height = Math.max(1, Math.floor(c.height * scale));
    const cell = { requestedWidth: c.requestedWidth, x: 0, y, width, height, sourceWidth: capture.width, sourceHeight: capture.height,
      scale: width / capture.width, limitedBy: [...(c.requestedWidth > capture.width ? ['captured-source-no-upscale'] : []), ...(scale < 1 ? ['artifact-max-edge'] : [])] };
    y += height; return cell;
  });
  return { coordinateSpace: 'artifact-pixels', width: Math.max(...cells.map((c) => c.width)), height: y, cells };
}
