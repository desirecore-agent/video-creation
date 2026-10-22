/** 时间线操作的公开自描述数据；复用原 applyOps，不建立另一套编辑或源码 CAS。 */
import { motionChangesSchema } from './motion-edits.mjs';

export const SETTABLE_FIELDS = Object.freeze(['at', 'time', 'box', 'size', 'volume', 'speed', 'overrides', 'src']);
const clipId = { type: 'string', description: 'inspect 返回的真实稳定片段 ID，不是轨道标签或数组位置。' };
const index = { type: ['integer', 'null'], minimum: 0, description: '当前 inspect 中 tracks 的数字索引；省略/null 沿用该操作的内核默认。' };
const insertedClip = { type: ['object', 'null'], description: '新片段原样数据，新建时必须包含 src；其他字段按影片 SPEC，ID 回退仍由内核决定。', properties: {
  src: { type: 'string', description: '可播放的项目相对来源；媒体片段 #t 按当前格式解释。' },
  id: { description: '正常为可选稳定字符串 ID；缺失/null/非字符串/已占用时沿原内核生成。' },
}, additionalProperties: true };
const value = { description: 'JSON 值；领域有效性与人工锁仍由影片内核检查，不因公开 Schema 而放宽。' };
const op = (name, description, required, properties, extra = {}) => ({
  type: 'object', description, required: ['op', ...required],
  properties: { op: { const: name, description: `既有时间线操作：${name}。` }, ...properties },
  // 原内核允许未消费的附加字段，发布描述不借机收紧旧请求。
  additionalProperties: true, ...extra,
});

export const timelineOpsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:desirecore:video-creation:timeline-ops:v1',
  title: '视频创作时间线 Op 合同 v1',
  $comment: 'contractVersion=1; 描述既有操作，最终仍由 applyOps/readFilm/版本及人工锁检查。',
  description: 'patch 的 JSON 文件本身就是此数组。先 inspect，再携带其真实 base revision；并发冲突重读合并，不用新 base 盲目重放。只修改点名字段，不要求重交整个片段；不是场景源码摘要 CAS 或权限授予。',
  type: 'array', minItems: 1, maxItems: 1000,
  items: { oneOf: [
    op('set', '只修改一个既有片段字段；例如换 src 不重交 motion/overrides/人工锁。value 省略或 null 按既有内核删除字段。', ['clip', 'field'], {
      clip: clipId, field: { enum: SETTABLE_FIELDS, description: '既有 set 操作支持的字段；src 是相对 film.html 的来源。inspect 将 HTML #t 片段分离为 time 时只换 src，不把 #t 再拼进 src；保留原 time。' }, value,
    }, { examples: [{ op: 'set', clip: 'scene', field: 'src', value: 'tide-beacon-r2.html' }] }),
    op('motion', '局部修改动效参数/数据、整条属性轨或稳定事件；沿已有场景 Schema 与人工锁检查。', ['clip', 'changes'], { clip: clipId, changes: motionChangesSchema }),
    op('motion-locks', '仅用户明确调整锁时修改完整锁列表；要求最新真实 revision，不与参数修改混为一项，不用此操作为其他修改解锁。', ['clip'], {
      clip: clipId, locked: { type: 'array', items: { type: 'string' }, description: '要保留的完整参数路径列表，[] 明确解锁。正常调用显式提供；省略沿历史内核语义处理，不赋予解锁授权。' },
    }),
    op('move', '移动既有片段的影片起点，可选换到现有轨或新建轨；其他片段字段保留。', ['clip', 'at'], {
      clip: clipId, at: { type: 'number', minimum: 0, description: '影片绝对秒数，内核写到毫秒。' }, track: { description: '当前轨数字索引；合法 newTrack 存在时此字段不被消费，保持历史忽略语义。' }, newTrack: { ...index, description: '插入一条新轨的位置，范围由当前工程决定；提供时优先于 track。' },
    }, { if: { required: ['newTrack'], properties: { newTrack: { type: 'integer', minimum: 0 } } }, else: { properties: { track: index } } }),
    op('insert', '插入明确新 clip，或用 from 复制现有 clip。路由优先级为非空 after → track 对象 → 其余 track/newTrack；其余路由中非空 newTrack 优先。null/省略沿默认按内容类型选轨；现存同 ID 同 src 的插入按原内核幂等忽略。', [], {
      clip: { description: '新建时为含 src 的片段对象；from 非空时整个 clip 子树不被消费，不前置验证被忽略的值。' },
      from: { type: ['string', 'null'], description: '可选现有片段 ID；提供时深拷贝其全部字段。' }, at: { description: '正常为影片起点秒数；null/省略保留来源值或默认。幂等插入可能不消费此字段，历史宽值交原内核最终判断。' },
      after: { description: '正常为现有片段字符串 ID；非空时紧接它插入并忽略 track/newTrack，null/省略进入后续路由。幂等插入可能不消费，最终仍由内核找片段。' },
      track: { description: '正常为现有轨数字索引或 {insert:数字位置}；after 非空时忽略，track 对象分支优先于 newTrack 并沿 Math.trunc/clamp。null/省略按剩余路由选轨；保留宽 JSON，由原内核判断消费与有效性。' },
      newTrack: { description: '正常为新轨非负整数位置；after 非空或 track 为对象时不消费；其余路由中非空值优先于 track，null/省略沿默认。历史宽值交内核最终判断。' }, link: { description: '可选字符串链接组，null 清除；不提供则保留来源片段值，其他历史值仍交内核处理。' },
    }, { examples: [{ op: 'insert', clip: { src: 'new.html' }, at: 0, track: { insert: 1 } }, { op: 'insert', from: 'scene', after: 'scene' }], anyOf: [{ required: ['clip'] }, { required: ['from'] }], if: { required: ['from'], properties: { from: { type: 'string' } } }, else: { properties: { clip: insertedClip } } }),
    op('remove', '按真实 ID 移除片段；原人工锁继续检查，不能借移除绕过。', ['clip'], { clip: clipId }),
    op('split', '既有两种切分形状：提供 left/right 字段覆盖，或 at/time/restTime 两段时间。继承原片段其他字段及内核淡入淡出规则。', ['clip'], {
      clip: clipId, left: { description: '存在此键时选择字段覆盖形状，正常为左半段字段对象；字段值沿既有 setField 语义，null 删除，兼容历史宽值。' },
      right: { description: '右半段字段对象；省略/null 按既有空覆盖处理。' }, rightId: { description: '正常为字段形状可选右片段字符串 ID；缺失/null/非字符串/不合法/已占用时内核生成。' },
      at: { description: '时间形状为大于零的右半段影片起点秒数；left 键存在时此字段不被消费。' }, time: { description: '时间形状的左半段源时间数组；保持已有格式，最终由 readFilm 检查。' },
      restTime: { description: '时间形状的右半段源时间数组，结束必须大于开始；不是影片全局时间。' }, restId: { description: '时间形状可选右片段 ID；沿既有生成/冲突规则，不改变原片段 ID。' },
    }, { anyOf: [{ required: ['left'] }, { required: ['at', 'restTime'] }], if: { not: { required: ['left'] } }, then: { properties: { at: { type: 'number', exclusiveMinimum: 0 } } } }),
    op('props', '沿编辑器原批处理语义：片段字段、轨标记、换轨、最后轨顺序；不是整片段替换。', ['edits'], {
      edits: { type: 'array', minItems: 1, description: '按顺序提交编辑器属性项；数组位置不是片段身份。', items: { type: 'object', required: ['prop'], properties: {
        clip: { description: '除 trackOrder 外需要真实片段 ID；trackOrder 不消费此字段。' }, prop: { type: 'string', description: '既有属性：普通片段字段、start/end、fade、gainDb、link，或 locked/hidden/muted、track、trackOrder；其他原字段仍交内核。' },
        value: { description: '普通字段的 JSON 值/null；track 为数字索引或 {insert:数字}；trackOrder 为 {from:数字,to:数字}；轨标记仅 true 设置，其余清除。' },
      }, additionalProperties: true, if: { properties: { prop: { const: 'trackOrder' } } }, else: { required: ['clip'], properties: { clip: clipId } } } },
    }),
    op('fields', '仅按给定键修改已有片段字段，id 被忽略；null 删除，其他字段保留。保留内核历史缺省/宽值处理，合法影片及锁仍校验。', ['clip'], {
      clip: clipId, fields: { description: '正常为 {字段名:JSON值} 对象；不要复制整片段来换一个字段。省略/null 为原来的空覆盖，不产生新写入能力。' },
    }),
    op('stage', '设置影片画布尺寸，保留其他 stage 字段。', ['w', 'h'], {
      w: { type: 'integer', minimum: 1, maximum: 8192, description: '画布宽度，1–8192 整数像素。' }, h: { type: 'integer', minimum: 1, maximum: 8192, description: '画布高度，1–8192 整数像素。' },
    }),
    op('track', '设置或清除既有轨标记；不替导演决定轨道组织。', ['track', 'field'], {
      track: { description: '当前 inspect 的真实轨数字索引，沿现有内核索引处理。' }, field: { enum: ['locked', 'hidden', 'muted'], description: '轨道已有标记。' },
      value: { description: '正常为 boolean；既有内核按 truthy 设置 true，否则清除。省略沿原清除语义，不赋予用户未授权的解锁操作。' },
    }),
    op('reorder', '移动现有轨顺序，索引以之前操作留下的当前状态为准。', ['from', 'to'], {
      from: { description: '现有源轨数字索引，兼容原内核索引读取。' }, to: { type: 'integer', minimum: 0, description: '目标现有轨数字索引，必须小于当前 tracks.length。' },
    }),
  ] },
};
