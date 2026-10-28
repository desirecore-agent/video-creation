import type { Op } from './ops.mjs';

/** 所见影片与完整源字幕集合共同限定一次编辑。 */
export interface EditPreconditions { strictBase: true; subtitles: { src: string; revision: string }[] }
export interface SpeechCutRequest {
  base: string; clip: string; sourceRevision: string;
  first: { line: number; part?: number }; last: { line: number; part?: number };
  adjust?: { startMs: number; endMs: number };
  follow?: { sync: boolean; linkage?: boolean };
}
export interface SpeechCutPlan {
  base: string; clip: string; text: string;
  source: { src: string; revision: string };
  range: { sourceStartMs: number; sourceEndMs: number; filmStartMs: number; filmEndMs: number };
  timing: ('measured' | 'estimated' | 'edited' | 'unknown')[];
  affected: string[]; ops: Extract<Op, { op: 'split' | 'props' | 'remove' }>[]; shortMs: number; preconditions: EditPreconditions;
}
/** 共享计划器的纯数据输入；不依赖浏览器、React或UI模块解析。 */
export interface TimelineEditTrack {
  index: number; locked?: boolean; role?: 'video' | 'audio' | 'mg';
  clips: { id: string; startMs: number; endMs: number; inMs: number; speed: number; sourceMs: number; still?: boolean; link?: string }[];
}
