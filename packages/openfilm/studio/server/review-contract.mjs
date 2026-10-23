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
    sequence: { type: 'object', additionalProperties: false, required: ['start', 'end', 'count'], description: '补充一个半开时间窗的序列总览；与firstLast及compareWidths互斥。编码窗口最多1800实际帧/30秒，全帧低分辨率灰度活动不代表审美；工程仅离散采样。', properties: {
      start: { type: 'number', minimum: 0, maximum: 86400, description: '相对本来源时钟的包含起点，单位秒。编码以首解码帧为零。' },
      end: { type: 'number', exclusiveMinimum: 0, maximum: 86400, description: '不包含的终点，与start差须0.001至30秒；按实际PTS报告覆盖，不推测容器尾部。' },
      count: { type: 'integer', minimum: 8, maximum: 24, description: '序列格数量。编码按时间均匀选择不早于目标的真实帧；低帧率可能重复，回执如实报告。' },
    } },
    compareWidths: { type: 'array', minItems: 2, maxItems: 3, uniqueItems: true, items: { type: 'integer', minimum: 64, maximum: 4096 }, description: '从同一原捕获PNG派生2–3种观看宽度的一张竖排对照图。与firstLast及sequence互斥，受源像素和整图maxEdge约束，不改变响应式布局。' },
    compareFrame: { type: 'integer', minimum: 0, maximum: 5, description: 'compareWidths引用的本回执timed frame index，默认0；必须实际存在，不能引用编码frameIndex。' },
  },
};
const number = (description) => ({ type: 'number', description });
const firstLastArtifactSchema = {
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
const observationArtifactSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
  description: '同一次审片的序列或尺寸对照图。每格时钟/尺寸在layout.cells中；图片本身不烧录时间标签，不得当作单一时点。',
  required: ['artifactId', 'kind', 'timeBasis', 'derivedFrom', 'layout', 'path', 'bytes', 'sha256', 'width', 'height'],
  allOf: [
    { if: { properties: { artifactId: { const: 'sequence' } } }, then: { properties: { kind: { const: 'sequence-contact-sheet' }, derivedFrom: { minItems: 8 }, layout: { properties: { cells: { minItems: 8 } } } } } },
    { if: { properties: { artifactId: { const: 'size-comparison' } } }, then: { properties: { kind: { const: 'size-comparison' }, derivedFrom: { maxItems: 1 }, layout: { properties: { cells: { maxItems: 3 } } } } } },
  ],
  properties: {
    artifactId: { enum: ['sequence', 'size-comparison'], description: '封闭制品标识，GET只读取对应固定文件。' },
    kind: { enum: ['sequence-contact-sheet', 'size-comparison'], description: '序列离散格或同一捕获的观看尺寸对照。' },
    timeBasis: { const: 'composite-not-timed-frame', description: '整图不是单个timeline帧。' },
    path: { type: 'string', description: '本次自有review内固定PNG。' }, url: { type: 'string', description: '同项目鉴权下的精确制品GET。' },
    bytes: { type: 'integer', minimum: 1, maximum: 4194304, description: '实际PNG字节数，计入12MiB总预算。' },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '上述实际字节摘要；Read须携带期望值。' }, mimeType: { const: 'image/png', description: '固定PNG。' },
    width: { type: 'integer', minimum: 1, description: '整图实际宽度。' }, height: { type: 'integer', minimum: 1, description: '整图实际高度。' },
    derivedFrom: { type: 'array', minItems: 1, maxItems: 24, description: '序列原捕获或同一timed frame缩放前capture的来源，摘要不能互换。', items: { type: 'object', additionalProperties: false, properties: {
      sequenceIndex: { type: 'integer', minimum: 0, maximum: 23, description: '本序列观察格下标，不是timed frames index。' }, sourceFrameIndex: { type: 'integer', minimum: 0, description: '编码来源的真实原视频帧序号。' },
      frameIndex: { type: 'integer', minimum: 0, maximum: 5, description: '尺寸对照引用的本回执timed frame index。' },
      requestedTime: number('目标秒数，另报真实采样时间。'), actualTime: number('相对该来源时钟的实际秒数。'), actualPTS: { type: ['number', 'null'], description: '原编码PTS；工程为null。' },
      actualPTSTicks: { type: 'string', pattern: '^-?\\d+$', description: '原编码整数时间戳，不由小数秒反推。' }, ptsTimeBase: { type: 'string', description: '整数时间基num/den。' },
      timeBasis: { type: 'string', description: 'encoded-pts或project-seek。' }, sha256: { type: 'string', description: '序列实际原捕获PNG摘要。' }, bytes: { type: 'integer', description: '序列实际原捕获字节数。' },
      captureSha256: { type: 'string', description: '尺寸对照target缩小前的实际捕获摘要。' }, captureBytes: { type: 'integer', description: '该原捕获字节数。' }, captureWidth: { type: 'integer', description: '该原捕获像素宽。' }, captureHeight: { type: 'integer', description: '该原捕获像素高。' },
      publishedFrameSha256: { type: 'string', description: '已发布timed frame PNG摘要，可能已按targetWidth缩小，不能冒充原capture摘要。' }, publishedFrameBytes: { type: 'integer', description: '已发布timed frame字节数。' },
      method: { const: 'same-captured-buffer-before-target-resize', description: '尺寸对照从同一次原捕获Buffer派生，不放大已缩小帧。' },
    } } },
    layout: { type: 'object', required: ['coordinateSpace', 'width', 'height', 'cells', 'maxEdge'], additionalProperties: false, description: '整图与每格实际尺寸分列；空格补透明像素不属于源画面。', properties: {
      coordinateSpace: { const: 'artifact-pixels', description: '整张PNG左上为原点。' }, width: { type: 'integer', description: '整图实际宽。' }, height: { type: 'integer', description: '整图实际高。' }, maxEdge: { type: 'integer', description: '调用者的整图最长边上限。' },
      columns: { type: 'integer', description: '序列的列数，按从左到右/从上到下阅读。' }, rows: { type: 'integer', description: '序列的行数，末行空格是透明补边。' },
      cells: { type: 'array', minItems: 2, maxItems: 24, description: '每格精确坐标、缩放与来源时点或请求宽度。', items: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height', 'sourceWidth', 'sourceHeight', 'scale'], properties: {
        sequenceIndex: { type: 'integer', description: '序列格下标，对应derivedFrom.sequenceIndex。' }, requestedWidth: { type: 'integer', description: '尺寸对照的请求宽度。' },
        x: number('格子左边像素。'), y: number('格子上边像素。'), width: number('格子实际宽。'), height: number('格子实际高。'), sourceWidth: number('输入捕获宽。'), sourceHeight: number('输入捕获高。'), scale: number('格子宽/捕获宽，只缩小。'),
        requestedTime: number('序列目标时间。'), actualTime: number('序列真实相对时间。'), actualPTS: { type: ['number', 'null'], description: '序列真实编码PTS；工程为null。' }, timeBasis: { type: 'string', description: '该格时钟来源。' },
        limitedBy: { type: 'array', items: { enum: ['captured-source-no-upscale', 'artifact-max-edge'] }, description: '源像素不足或整图cap造成请求宽度未达到，按实际尺寸观察。' },
      } } },
    } },
    textProjections: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '仅当前工程同次DOM可投影字号按每格实际宽度换算；不是字形/OCR/可读性合格线。旧encoded没有DOM时为空。' },
    limitations: { type: 'array', items: { type: 'string' }, description: '离散观察、缩放、未知测量及声音/语义限制。' },
  },
};
export const reviewArtifactSchema = { $schema: 'http://json-schema.org/draft-07/schema#', description: '一个请求最多一张首尾、序列或尺寸对照制品。', oneOf: [firstLastArtifactSchema, observationArtifactSchema] };
export const reviewTemporalSchema = { $schema: 'http://json-schema.org/draft-07/schema#', type: ['object', 'null'], description: '只有请求sequence才返回。encoded为明确窗口全部实际帧的低分辨率灰度事实；工程为partial离散seek。不是节奏评分/冻结判定或连续播放证明。', properties: {
  status: { enum: ['observed', 'partial'], description: 'observed仅表示编码窗口全帧被量化；partial是工程采样。' },
  method: { type: 'string', description: '实际灰度栅格或离散seek方法。' },
  decodedFrames: { type: 'integer', minimum: 1, maximum: 1800, description: '实际全部分析帧数，不是序列格数。' },
  requestedWindow: reviewRequestSchema.properties.sequence,
  windows: { type: 'array', maxItems: 31, items: { type: 'object', additionalProperties: true }, description: '约每秒一组相邻灰度差均值/最大值、实际首尾时刻、帧数与最大PTS间隔；不设质量阈值。' },
  limitations: { type: 'array', items: { type: 'string' }, description: '低分辨率、非语义/非声音/仅明确窗口等边界。' },
}, additionalProperties: true };
export const reviewContract = { contractVersion: 3, requestSchema: reviewRequestSchema, findingSchema: reviewFindingSchema, coverageSchema: reviewCoverageSchema, artifactSchema: reviewArtifactSchema, temporalSchema: reviewTemporalSchema };
