/** 只从已核验的本次 PNG buffer 派生，不重新渲染或打开原工程路径。 */
import { pngSize, runReviewProcess, REVIEW_MAX_FRAME_BYTES } from './review-frames.mjs';

/** 只缩小；maxEdge 是整图上限，targetWidth 不能突破源像素和该上限。 */
export function reviewPresentation(dimensions, request, source = dimensions) {
  const factor = Math.min(1, (request.targetWidth ?? dimensions.width) / dimensions.width);
  const width = Math.max(1, Math.floor(dimensions.width * factor)), height = Math.max(1, Math.floor(dimensions.height * factor));
  return { requestedTargetWidth: request.targetWidth ?? null, sourceWidth: source.width, sourceHeight: source.height,
    captureWidth: dimensions.width, captureHeight: dimensions.height, actualWidth: width, actualHeight: height,
    scale: width / source.width, maxEdge: request.maxEdge,
    limitedBy: [...(request.targetWidth > source.width ? ['source-no-upscale'] : []), ...(dimensions.width < Math.min(source.width, request.targetWidth ?? source.width) ? ['max-edge'] : [])] };
}

export async function downscaleReviewPNG(png, presentation, { signal } = {}) {
  const dimensions = pngSize(png), width = presentation.actualWidth, height = presentation.actualHeight;
  if (width > dimensions.width || height > dimensions.height) throw new Error('审片派生不能放大源图片。');
  if (width === dimensions.width && height === dimensions.height) return png;
  const { stdout } = await runReviewProcess('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:3', '-vf', `scale=${width}:${height}:flags=lanczos`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { binary: true, inputs: [png], maxBytes: REVIEW_MAX_FRAME_BYTES, signal });
  const actual = pngSize(stdout);
  if (actual.width !== width || actual.height !== height) throw new Error('目标尺寸 PNG 与实际编码尺寸不符。');
  return stdout;
}

/** 一个首尾组合图是两格布局，不是时间线上存在的单帧。 */
export function firstLastLayout(first, last, maxEdge) {
  const factor = Math.min(1, maxEdge / (first.width + last.width), maxEdge / Math.max(first.height, last.height));
  const cells = [first, last].map((d, index) => ({ position: index ? 'last' : 'first', frameIndex: d.index,
    x: 0, y: 0, width: Math.max(1, Math.floor(d.width * factor)), height: Math.max(1, Math.floor(d.height * factor)),
    sourceWidth: d.width, sourceHeight: d.height, scale: Math.max(1, Math.floor(d.width * factor)) / d.width }));
  cells[1].x = cells[0].width;
  return { coordinateSpace: 'artifact-pixels', width: cells[0].width + cells[1].width, height: Math.max(...cells.map((c) => c.height)), cells };
}

export async function firstLastReviewPNG(first, last, layout, { signal } = {}) {
  const [a, b] = layout.cells;
  const filter = `[0:v]scale=${a.width}:${a.height}:flags=lanczos,format=rgba,pad=${a.width}:${layout.height}:0:0:color=black@0[a];[1:v]scale=${b.width}:${b.height}:flags=lanczos,format=rgba,pad=${b.width}:${layout.height}:0:0:color=black@0[b];[a][b]hstack=inputs=2[out]`;
  const { stdout } = await runReviewProcess('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:3', '-f', 'image2pipe', '-i', 'pipe:4', '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { binary: true, inputs: [first, last], maxBytes: REVIEW_MAX_FRAME_BYTES, signal });
  const actual = pngSize(stdout);
  if (actual.width !== layout.width || actual.height !== layout.height) throw new Error('首尾组合图的实际布局不符。');
  return stdout;
}

/** 格子顺序与回执完全一致；固定buffer输入，不在子进程中重新读工程或旧路径。 */
export async function observationGridPNG(buffers, layout, { signal } = {}) {
  let args, inputs;
  if (layout.columns) {
    const cell = layout.cells[0];
    args = ['-f', 'image2pipe', '-i', 'pipe:3', '-vf', `scale=${cell.width}:${cell.height}:flags=lanczos,format=rgba,tile=${layout.columns}x${layout.rows}:nb_frames=${buffers.length}:color=black@0`];
    inputs = [Buffer.concat(buffers)];
  } else {
    args = buffers.flatMap((_, i) => ['-f', 'image2pipe', '-i', `pipe:${i + 3}`]);
    const parts = layout.cells.map((cell, i) => `[${i}:v]scale=${cell.width}:${cell.height}:flags=lanczos,format=rgba[c${i}]`);
    parts.push(`${layout.cells.map((_, i) => `[c${i}]`).join('')}xstack=inputs=${buffers.length}:layout=${layout.cells.map((c) => `${c.x}_${c.y}`).join('|')}:fill=black@0[out]`);
    args.push('-filter_complex', parts.join(';'), '-map', '[out]'); inputs = buffers;
  }
  const { stdout } = await runReviewProcess('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', ...args,
    '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { binary: true, inputs, maxBytes: REVIEW_MAX_FRAME_BYTES, signal });
  const size = pngSize(stdout);
  if (size.width !== layout.width || size.height !== layout.height) throw new Error('观察组合图实际尺寸与布局不符。');
  return stdout;
}
