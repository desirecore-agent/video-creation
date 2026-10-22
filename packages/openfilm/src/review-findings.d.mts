export interface ReviewTime { requestedTime: number | string | null; actualTime: number | null; actualPTS: number | null; timeBasis: string; [key: string]: unknown }
export interface ReviewSource { kind: string; page?: string | null; clipId?: string | null; inputSha256?: string | null; consistency?: string; [key: string]: unknown }
export interface ReviewBounds { coordinateSpace: 'page-css-pixels'; x: number; y: number; width: number; height: number }
export interface ReviewFinding {
  code: string; severity: 'info' | 'warning' | 'error'; status: 'observed' | 'unknown'; time: ReviewTime | null; source: ReviewSource;
  selector: string | null; bounds: ReviewBounds | null; measurement: Record<string, unknown>; evidence: Record<string, unknown>[]; limitations: string[];
}
export interface ReviewCoverage { code: string; status: 'observed' | 'unknown' | 'partial'; time: ReviewTime | null; source: ReviewSource; details: Record<string, unknown>; limitations: string[] }
export declare const MAX_REVIEW_FINDINGS: number;
export declare const reviewFindingSchema: Record<string, unknown>;
export declare const findingSchema: typeof reviewFindingSchema;
export declare const reviewCoverageSchema: Record<string, unknown>;
export declare function reviewFinding(code: string, options: { source: ReviewSource } & Partial<Omit<ReviewFinding, 'code'>>): ReviewFinding;
export declare function reviewCoverage(code: string, options: { source: ReviewSource } & Partial<Omit<ReviewCoverage, 'code'>>): ReviewCoverage;
export declare function textSampleFindings(sample: Record<string, any>, context: { time: ReviewTime | null; source: ReviewSource; viewport: { width: number; height: number }; stageWidth: number; targetWidth?: number | null; outerScaleY?: number | null }): ReviewFinding[];
export declare function collectFrameFindings(film: import('./host.mjs').FilmPage, options?: { time?: ReviewTime | null; stage?: { w?: number; h?: number; width?: number; height?: number }; targetWidth?: number | null; source?: ReviewSource }): Promise<{ findings: ReviewFinding[]; coverage: ReviewCoverage[] }>;
