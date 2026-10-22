import type { LaunchOptions, PageNetwork } from './host.mjs';
import type { ReviewFinding, ReviewCoverage } from './review-findings.mjs';
export declare function look(args: string[], opts?: { count?: number; targetWidth?: number; root?: string; offline?: boolean; network?: PageNetwork; launch?: LaunchOptions }): Promise<{ ok: boolean; lines: string[]; files: string[]; findings: ReviewFinding[]; coverage: ReviewCoverage[] }>;
