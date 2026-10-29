/** CLI 离线发现、HTTP 和 MCP 使用同一份公开审片合同。 */
import { REVIEW_MAX_FRAMES } from '../../src/review-frames.mjs';
import { reviewFindingSchema, reviewCoverageSchema } from '../../src/review-findings.mjs';
import { reviewIntentSchema } from './review-facts.mjs';
const reviewFrameReference = { type: 'object', additionalProperties: false, required: ['reviewId', 'frameIndex'], description: '同一项目已生成的timed frame，不引用任意路径或递归对照。', properties: {
  reviewId: { type: 'string', pattern: '^[a-f0-9]{24}$', description: '本项目既有reviewId。' },
  frameIndex: { type: 'integer', minimum: 0, maximum: 5, description: '该回执的frames下标，不是原视频帧编号。' },
  expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '可选的调用者期望图片摘要；不符即拒绝。' },
} };
export const reviewRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, required: ['source'],
  description: '只读审片请求。生成材料不等于看图，不限制导演自主创作或人工锁。',
  allOf: [{ if: { properties: { source: { const: 'review-pair' } }, required: ['source'] }, then: { required: ['before', 'after'], properties: { job: false, times: false, last: false, count: false, firstLast: false, sequence: false, compareWidths: false, compareFrame: false, informationSafeArea: false } }, else: { properties: { before: false, after: false } } }],
  properties: {
    informationSafeArea: { type: 'object', additionalProperties: false, required: ['top', 'bottom'], description: '可选的上/下实质信息禁入区高度比例，和须小于1；只观察字幕与显式essential/supporting DOM目标完整边界，不自动移动、裁切、评分或修改锁。编码来源没有DOM，返回unknown而非安全通过。', properties: { top: { type: 'number', minimum: 0, exclusiveMaximum: 1, description: '从画面上沿起的高度比例，例如0.15，不是15。' }, bottom: { type: 'number', minimum: 0, exclusiveMaximum: 1, description: '从画面下沿起的高度比例，例如0.15。' } } },
    source: { enum: ['current-project', 'export-job', 'review-pair'], description: 'current-project为冻结工程预览；export-job解码完成视频；review-pair仅组合before/after已有帧，不再渲染。' },
    before: reviewFrameReference, after: reviewFrameReference,
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
  description: '同一次审片的序列或尺寸对照图。独立标签带只标元数据，不覆盖源画面；完整时钟/尺寸在layout.cells中，不得当作单一时点。',
  required: ['artifactId', 'kind', 'timeBasis', 'derivedFrom', 'layout', 'path', 'bytes', 'sha256', 'width', 'height'],
  allOf: [
    { if: { properties: { artifactId: { const: 'sequence' } } }, then: { properties: { kind: { const: 'sequence-contact-sheet' }, derivedFrom: { type: 'array', minItems: 8 }, layout: { type: 'object', properties: { cells: { type: 'array', minItems: 8 } } } } } },
    { if: { properties: { artifactId: { const: 'size-comparison' } } }, then: { properties: { kind: { const: 'size-comparison' }, derivedFrom: { type: 'array', maxItems: 1 }, layout: { type: 'object', properties: { cells: { type: 'array', maxItems: 3 } } } } } },
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
      labelBandHeight: { type: 'integer', minimum: 1, description: '每行/每个尺寸格在内容上方预留的标签带高度；不属于源像素。' },
      labelTimeDecimals: { const: 3, description: '序列图内秒数只显示三位小数；完整精度与整数PTS仍看metadata。' },
      cells: { type: 'array', minItems: 2, maxItems: 24, description: '每格精确坐标、缩放与来源时点或请求宽度。', items: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height', 'sourceWidth', 'sourceHeight', 'scale'], properties: {
        sequenceIndex: { type: 'integer', description: '序列格下标，对应derivedFrom.sequenceIndex。' }, requestedWidth: { type: 'integer', description: '尺寸对照的请求宽度。' },
        x: number('格子左边像素。'), y: number('格子上边像素。'), width: number('格子实际宽。'), height: number('格子实际高。'), sourceWidth: number('输入捕获宽。'), sourceHeight: number('输入捕获高。'), scale: number('格子宽/捕获宽，只缩小。'),
        requestedTime: number('序列目标时间。'), actualTime: number('序列真实相对时间。'), actualPTS: { type: ['number', 'null'], description: '序列真实编码PTS；工程为null。' }, timeBasis: { type: 'string', description: '该格时钟来源。' },
        limitedBy: { type: 'array', items: { enum: ['captured-source-no-upscale', 'artifact-max-edge'] }, description: '源像素不足或整图cap造成请求宽度未达到，按实际尺寸观察。' },
        label: { type: 'object', required: ['text', 'renderedText', 'fullLabelRendered', 'rendered', 'fontScale', 'x', 'y', 'width', 'height'], additionalProperties: false,
          description: '独立标签区域，与本cell源内容的x/y/width/height分开。', properties: {
            text: { type: 'string', description: '完整元数据标签：格号和实际秒数，或请求>实际px。' }, renderedText: { type: 'string', description: '实际写进PNG的文字；极小格子只显示编号/实际宽度或省略，绝不裁成半个时间。' },
            fullLabelRendered: { type: 'boolean', description: '是否完整显示标签，不是源画面完整或质量通过标志。' }, rendered: { type: 'boolean', description: '是否至少显示了文字。' }, fontScale: { type: 'integer', description: '自包含元数据像素字形的缩放倍数，不是作品字号。' },
            x: number('标签区域左边。'), y: number('标签区域上边。'), width: number('标签区域宽。'), height: number('标签区域高。'),
            limitedBy: { const: 'label-space', description: '空间不足而简化或省略。' }, limitation: { type: 'string', description: '完整metadata仍保留，禁止从简化编号猜时间。' },
          } },
      } } },
    } },
    textProjections: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '仅当前工程同次DOM可投影字号按每格实际宽度换算；不是字形/OCR/可读性合格线。旧encoded没有DOM时为空。' },
    limitations: { type: 'array', items: { type: 'string' }, description: '离散观察、缩放、未知测量及声音/语义限制。' },
  },
};
const revisionComparisonSchema = { $schema: observationArtifactSchema.$schema, type: 'object', required: observationArtifactSchema.required, description: '两份已有timed frame的独立前后对照；时间与版本逐侧报告，不承诺语义对齐。', properties: {
  ...observationArtifactSchema.properties,
  artifactId: { const: 'revision-comparison', description: '本次单独的前后对照PNG。' }, kind: { const: 'revision-comparison', description: '按调用者选择的两帧，不自动评价修改质量。' },
  derivedFrom: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'object', additionalProperties: true }, description: '每侧的原review、film版本、实际时点、图片SHA、尺寸及原source。' },
  presentation: { type: 'object', additionalProperties: true, description: '请求观看宽度、两侧共同实际宽度和只缩小的共同尺寸策略；不把较小旧图放大。' },
  differences: { type: 'object', additionalProperties: true, description: '可证明的输入集合和已捕获参数/overrides/锁字段摘要差异；缺失明确unknown，非修改者身份或质量判断。' },
} };
export const reviewArtifactSchema = { $schema: 'http://json-schema.org/draft-07/schema#', description: '一个请求最多一张首尾、序列、尺寸或版本对照制品。', oneOf: [firstLastArtifactSchema, observationArtifactSchema, revisionComparisonSchema] };
const temporalFrameLocator = { type: 'object', additionalProperties: false, required: ['sourceFrameIndex', 'actualTime', 'actualPTSTicks', 'ptsTimeBase'], description: '已经逐帧核过整数PTS的编码帧定位，不是稀疏contact格号。', properties: {
  sourceFrameIndex: { type: 'integer', minimum: 0, description: '原视频全部已探测帧中的零起点下标。' },
  actualTime: number('相对原视频第一实际帧的秒数；不是绝对PTS。'),
  actualPTSTicks: { type: 'string', pattern: '^-?[0-9]+$', description: '原流的实际整数PTS，保留字符串避免长时钟精度损失。' },
  ptsTimeBase: { type: 'string', pattern: '^[0-9]+/[0-9]+$', description: '原流整数PTS对应的分数时间基；完整定位优先整数与此值。' },
} };
export const reviewTemporalSchema = { $schema: 'http://json-schema.org/draft-07/schema#', type: ['object', 'null'], description: '只有请求sequence才返回。encoded为明确窗口全部实际帧的低分辨率灰度事实；工程为partial离散seek。不是节奏评分/冻结判定或连续播放证明。', properties: {
  status: { enum: ['observed', 'partial'], description: 'observed仅表示编码窗口全帧被量化；partial是工程采样。' },
  method: { type: 'string', description: '实际灰度栅格或离散seek方法。' },
  decodedFrames: { type: 'integer', minimum: 1, maximum: 1800, description: '实际全部分析帧数，不是序列格数。' },
  requestedWindow: reviewRequestSchema.properties.sequence,
  windows: { type: 'array', maxItems: 31, description: '约每秒一组相邻灰度差、覆盖与定位；相邻对归后帧所在的请求起点相对秒桶，可能跨桶，不设质量阈值。', items: { type: 'object', additionalProperties: true, properties: {
    peakAdjacentPair: { type: ['object', 'null'], additionalProperties: false, required: ['meanAbsoluteLumaDelta', 'from', 'to'], description: '该桶最大相邻灰度差的首对；无相邻对为null，零差不是坏片判断。', properties: {
      meanAbsoluteLumaDelta: { type: 'number', minimum: 0, maximum: 1, description: '这一对低分辨率灰度绝对差的归一化均值，不是物体速度或节奏分。' },
      from: temporalFrameLocator, to: temporalFrameLocator,
    } },
  } } },
  limitations: { type: 'array', items: { type: 'string' }, description: '低分辨率、非语义/非声音/仅明确窗口等边界。' },
}, additionalProperties: true };
export const reviewSourceFactsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: ['status'],
  description: '从同一冻结film提取的意图与工程字段摘要。observed是数据采样，不证明任意代码的视觉语义或修改者身份。',
  properties: {
    status: { enum: ['observed', 'unknown'], description: '可解析且在预算内才记录，否则unknown并给reason，不从live补造。' },
    version: { enum: [1, 2], description: '已捕获事实格式：2按真实motion.locked提取人工锁并独立于布局；历史1仍可读取，其锁/布局投影不参与工程字段对照证明。' }, filmSha256: { type: 'string', description: '事实所属完整film原字节SHA256。' },
    reason: { type: 'string', description: '不可提取的具体边界。' },
    intents: { type: 'array', description: '按clipId关联的作者标注；observed表示JSON符合intentSchema，不是DOM或可读性通过。', items: { type: 'object', properties: {
      clipId: { type: 'string', description: '稳定片段ID。' }, status: { enum: ['observed', 'invalid'], description: '标注解析结果。' }, value: reviewIntentSchema,
      reason: { type: 'string', description: '标注无效原因，原作品仍可播放。' },
    } } },
    clips: { type: 'array', maxItems: 1000, description: '每片段的src及params、motion.locked、DOM overrides、其他布局/时间字段的规范JSON摘要；不创建第二套锁。', items: { type: 'object', additionalProperties: true } },
    tracks: { type: 'array', description: '按轨道位置记录已有开关/锁字段摘要。', items: { type: 'object', additionalProperties: true } },
    limitations: { type: 'array', items: { type: 'string' }, description: '数据摘要与视觉判断的边界。' },
  },
};
export const reviewCLIOptionsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
  description: '仅本地CLI选项，不是HTTP/MCP捕获参数，不授予目录权限。省略时原行为不变。',
  properties: {
    read: { type: 'string', pattern: '^[a-f0-9]{24}$', description: '--read：读取已有review，不重新捕获；不可同时给source/job/采样或组合参数。' },
    copyTo: { type: 'string', minLength: 1, maxLength: 4096, description: '--copy-to：调用者选择的已授权、已存在目录。把核SHA的PNG保存到其review-ID子目录，供既有Read使用；相同副本复用，冲突不覆盖。' },
  },
};
export const reviewContract = { contractVersion: 4, requestSchema: reviewRequestSchema, cliOptionsSchema: reviewCLIOptionsSchema, intentSchema: reviewIntentSchema, sourceFactsSchema: reviewSourceFactsSchema, findingSchema: reviewFindingSchema, coverageSchema: reviewCoverageSchema, artifactSchema: reviewArtifactSchema, temporalSchema: reviewTemporalSchema,
  navigation: { description: '项目审片入口可查看近期材料、放大已有图并按点播放原成片。回工程只在冻结输入仍匹配且映射可证明时启用。', intentAttribute: 'clip.attrs.data-review-intent' } };
