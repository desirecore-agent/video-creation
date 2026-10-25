/** 审片视图的数据投影；来源和权限由既有服务端review合同校验。 */
export type ReviewFrame = { index: number; actualTime: number; actualPTS?: number | null; width: number; height: number; sha256: string; timeBasis?: string };
export type ReviewCell = { x: number; y: number; width: number; height: number; actualTime?: number; sequenceIndex?: number };
export type ReviewArtifact = { artifactId: string; kind: string; width: number; height: number; sha256: string; layout: { cells: ReviewCell[] }; derivedFrom: { reviewId?: string; frameIndex?: number; filmRevision?: string; sourceKind?: string; sha256?: string; actualTime?: number; width?: number; height?: number }[]; differences?: { files?: { status: string; totalChanges?: number; changes?: { path: string; kind: string }[] }; preservedData?: { status: string; totalChanges?: number; changes?: { field: string }[] } } };
export type ReviewRecord = { version: number; reviewId: string; createdAt: string; sourceKind: string; filmRevision: string | null; frames: ReviewFrame[]; artifacts: ReviewArtifact[]; sourceFacts?: { intents?: { clipId: string; status: string; value?: { targetWidths?: number[]; text?: { role: string; selector?: string; description: string }[]; note?: string } }[] } };
export type ReviewSummary = Pick<ReviewRecord, 'reviewId' | 'createdAt' | 'sourceKind' | 'filmRevision'> & { frames: Pick<ReviewFrame, 'index' | 'actualTime'>[]; artifactKinds: string[] };
export type ReviewTarget = { reviewId: string; sourceKind: string; filmRevision: string; point: { actualTime: number }; playback: { status: string; url: string; canLocate: boolean; time: number | null; limitation?: string | null } | null; engineering: { status: string; reason?: string; timeMs?: number; filmRevision?: string; inputSha256?: string } };
export type ReviewPoint = { key: string; reviewId: string; kind: 'frame' | 'sequence'; index: number; time: number; width: number; height: number; image: { artifactId?: string; frameIndex?: number; sha256: string; width: number; height: number; cell?: ReviewCell } };

export function pointsOf(r: ReviewRecord): ReviewPoint[] {
  const points: ReviewPoint[] = r.frames.map((f, index) => ({ key: `frame:${index}`, reviewId: r.reviewId, kind: 'frame', index, time: f.actualTime, width: f.width, height: f.height, image: { frameIndex: index, sha256: f.sha256, width: f.width, height: f.height } }));
  for (const a of r.artifacts ?? []) {
    if (a.artifactId === 'sequence') for (const [index, cell] of a.layout.cells.entries()) {
      if (!Number.isFinite(cell.actualTime)) continue;
      points.push({ key: `sequence:${index}`, reviewId: r.reviewId, kind: 'sequence', index, time: cell.actualTime!, width: cell.width, height: cell.height, image: { artifactId: a.artifactId, sha256: a.sha256, width: a.width, height: a.height, cell } });
    }
    if (a.artifactId === 'revision-comparison') for (const [index, cell] of a.layout.cells.entries()) {
      const ref = a.derivedFrom[index];
      if (!ref?.reviewId || ref.frameIndex == null || ref.actualTime == null) continue;
      points.push({ key: `pair:${index}`, reviewId: ref.reviewId, kind: 'frame', index: ref.frameIndex, time: ref.actualTime, width: cell.width, height: cell.height, image: { artifactId: a.artifactId, sha256: a.sha256, width: a.width, height: a.height, cell } });
    }
  }
  return points;
}

export function reviewImage(projectId: string, reviewId: string, image: ReviewPoint['image']): string {
  const path = `/api/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/${image.artifactId ? `artifacts/${encodeURIComponent(image.artifactId)}` : `frames/${image.frameIndex}`}`;
  return `${path}?expected_sha256=${encodeURIComponent(image.sha256)}`;
}

/** 只定位仍匹配且已保存的工程，不用历史时间点猜当前状态。 */
export function maySeekEngineering(target: ReviewTarget, rev: string | null, settled: boolean, saveError: unknown): boolean {
  return !saveError && settled && target.engineering.status === 'verified-at-check' && target.engineering.filmRevision === rev
    && Number.isFinite(target.engineering.timeMs) && target.engineering.timeMs! >= 0;
}
