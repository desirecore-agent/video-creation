/** CLI 离线发现、HTTP 和 MCP 使用同一份公开审片合同。 */
import { REVIEW_MAX_FRAMES } from '../../src/review-frames.mjs';
import { reviewFindingSchema, reviewCoverageSchema } from '../../src/review-findings.mjs';
export const reviewRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, required: ['source'],
  description: '只读审片请求。生成材料不等于看图，不限制导演自主创作或人工锁。',
  properties: {
    source: { enum: ['current-project', 'export-job'], description: 'current-project 是冻结本地工程的浏览器预览；export-job 只解码此工程完成的视频输出，不附当前 DOM 事实。' },
    job: { type: 'string', pattern: '^[a-f0-9]{12}$', description: 'export-job 必须指定 video_jobs 返回的 done 视频任务 ID，不接受任意路径。' },
    times: { type: 'array', minItems: 1, maxItems: REVIEW_MAX_FRAMES, uniqueItems: true, items: { type: 'number', minimum: 0, maximum: 86400 }, description: '明确秒数。编码视频以首个实际视频帧为相对零点，取不早于请求的第一帧，另报原始 PTS/整数时间基；不是原 film 的 range 时间。与 count 互斥。' },
    last: { type: 'boolean', description: '增加真实编码末帧；工程预览是 duration 前 1ms 末态，不能混称。' },
    count: { type: 'integer', minimum: 1, maximum: REVIEW_MAX_FRAMES, description: '均匀采样数，与 times 互斥；firstLast 可能额外补首帧/末帧，合计仍最多六帧。' },
    maxEdge: { type: 'integer', minimum: 128, maximum: 1920, default: 1280, description: '每帧和整个首尾合成图最长边上限，非每个 cell 的上限。只缩小，实际尺寸和限制写入回执。' },
    targetWidth: { type: 'integer', minimum: 64, maximum: 4096, description: '目标观看宽度。只缩小已核验的 PNG；受源像素及 maxEdge 限制时明示实际宽度，不放大、不重渲染。' },
    firstLast: { type: 'boolean', description: '同请求补充 first=0 与真实 last，在 artifacts 返回最多一个非 timed-frame 的首尾合成图。每图4MiB，frames+artifact总12MiB；不代表全片检查。' },
  },
};
const number = (description) => ({ type: 'number', description });
export const reviewArtifactSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: ['artifactId', 'kind', 'timeBasis', 'derivedFrom', 'layout', 'path', 'bytes', 'sha256', 'width', 'height'],
  description: '从本回执精确帧 buffer 派生的独立图片，不是编码时间线上某个时点。读取时仍须 expected_sha256。',
  properties: {
    artifactId: { const: 'first-last', description: '本次审片最多一个首尾组合制品。' }, kind: { const: 'first-last-composite', description: '首尾两格并列，透明补边。' },
    timeBasis: { const: 'composite-not-timed-frame', description: '禁止把组合图当单个时间点。' },
    width: { type: 'integer', minimum: 1, description: '整图实际像素宽度。' }, height: { type: 'integer', minimum: 1, description: '整图实际像素高度。' },
    path: { type: 'string', description: '本应用数据目录内的精确派生 PNG，不是任意下载路径。' }, bytes: { type: 'integer', minimum: 1, maximum: 4194304, description: '该 PNG 实际字节数。' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '上述实际字节的 SHA-256。' },
    mimeType: { const: 'image/png', description: '固定 PNG。' }, url: { type: 'string', description: '原项目鉴权下只读取此身份的精确图片。' },
    derivedFrom: { type: 'array', minItems: 2, maxItems: 2, description: '本回执 frames 的精确字节和时间，分别为首与尾；允许同一实际视频帧。', items: { type: 'object', required: ['frameIndex', 'sha256', 'bytes', 'actualTime', 'actualPTS', 'timeBasis'], properties: { frameIndex: { type: 'integer', minimum: 0, description: '本回执帧 index，不是编码 n。' }, sha256: { type: 'string', description: '源 PNG SHA-256。' }, bytes: { type: 'integer', description: '源 PNG 字节。' }, actualTime: number('源帧实际相对时间。'), actualPTS: { type: ['number', 'null'], description: '原始编码 PTS；工程预览为 null。' }, actualPTSTicks: { type: 'string', description: '存在编码时间基时的原始整数 ticks。' }, ptsTimeBase: { type: 'string', description: '整数 ticks 的 time_base。' }, timeBasis: { type: 'string', description: '源帧时间口径。' } } } },
    layout: { type: 'object', description: '整图限制和每格真实尺寸分列，不放大。', properties: { coordinateSpace: { const: 'artifact-pixels', description: '格子坐标以整图左上为原点。' }, maxEdge: { type: 'integer', description: '整图最长边请求上限。' }, cells: { type: 'array', minItems: 2, maxItems: 2, description: 'first、last 两格的 frameIndex/x/y/width/height/sourceWidth/sourceHeight/scale。', items: { type: 'object', required: ['position', 'frameIndex', 'x', 'y', 'width', 'height', 'sourceWidth', 'sourceHeight', 'scale'], properties: { position: { enum: ['first', 'last'], description: '首或尾的位置。' }, frameIndex: { type: 'integer', description: '源回执 frame index。' }, x: number('格子左边像素。'), y: number('格子顶边像素。'), width: number('格子实际内容宽度。'), height: number('格子实际内容高度；下方可有透明补边。'), sourceWidth: number('输入 PNG 宽度。'), sourceHeight: number('输入 PNG 高度。'), scale: number('格子宽度/输入宽度，只缩小。') } } } } },
    limitations: { type: 'array', items: { type: 'string' }, description: '两点不证明连续过程、音频、整体审美或模型已理解。' },
  },
};
export const reviewContract = { contractVersion: 2, requestSchema: reviewRequestSchema, findingSchema: reviewFindingSchema, coverageSchema: reviewCoverageSchema, artifactSchema: reviewArtifactSchema };
