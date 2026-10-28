/** 公共领域类型与服务端同源，不经UI API循环定义。 */
export type { EditPreconditions, SpeechCutRequest, SpeechCutPlan } from '../../../server/speech-cut-types.mjs';

/** 仅清理这一次试听拥有的停止点；后来开始的一般播放不能被旧面板取消。 */
export function releaseSpeechPreview(ownedStop: number | null, currentStop: number | null): { stopAt: number | null; pause: boolean } {
  const own = ownedStop != null && ownedStop === currentStop;
  return { stopAt: own ? null : currentStop, pause: own };
}
