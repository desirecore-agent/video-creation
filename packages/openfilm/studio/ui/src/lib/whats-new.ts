/**
 * What each release brings, said to the person after an update: a few lines a release, in every language Studio
 * speaks (a release without them all does not compile), grouped as new, improved and fixed. The newest first.
 *
 * Written when a release is made (the "Version packages" pull request): the changesets say everything that changed,
 * for the changelog; these say what a person would notice, in their words, at most six lines. A version without them
 * fails the tests (whats-new.test.ts), so that pull request cannot be merged until they are written.
 *
 * After an update the release notes since the version last shown appear once (lib's notesToShow; Studio's prefs keep
 * `seenVersion`). A new install shows none: there is nothing it was updated from.
 */
import type { Language } from '@/i18n';

export type NoteKind = 'new' | 'improved' | 'fixed';
export interface ReleaseNote { kind: NoteKind; text: string }
export interface ReleaseNotes { version: string; date: string; notes: Record<Language, ReleaseNote[]> }

export const RELEASES: readonly ReleaseNotes[] = [
  {
    version: '0.2.0',
    date: '2026-10-18',
    notes: {
      en: [{ kind: 'new', text: '视频创作 reuses the OpenFilm editor and film format, with an independent identity and DesireCore-managed updates.' }],
      'zh-CN': [{ kind: 'new', text: '视频创作复用 OpenFilm 编辑器和影片格式，采用独立名称、运行目录与 DesireCore 应用更新方式。' }],
      ja: [{ kind: 'new', text: '视频创作 は OpenFilm のエディターと形式を再利用し、独自の名前と作業フォルダーを使用します。更新は DesireCore が管理します。' }],
      ko: [{ kind: 'new', text: '视频创作는 OpenFilm 편집기와 영상 형식을 재사용하며 독립된 이름과 작업 폴더를 사용합니다. 업데이트는 DesireCore에서 관리합니다.' }],
      es: [{ kind: 'new', text: '视频创作 reutiliza el editor y el formato de OpenFilm con identidad propia y actualizaciones administradas por DesireCore.' }],
    },
  },
];

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b` (x.y.z; a pre-release is older than its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ''] = v.split('-');
    return { parts: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The releases to tell of after an update from `seen` to `current`: those newer than `seen`, up to `current`, the
 * newest first. None when nothing was seen before (a new install) or nothing is newer.
 */
export function notesToShow(seen: string | null, current: string, releases: readonly ReleaseNotes[] = RELEASES): ReleaseNotes[] {
  if (!seen) return [];
  return releases.filter((r) => compareVersions(r.version, seen) > 0 && compareVersions(r.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The notes of one release, if it has any. */
export function releaseNotes(version: string, releases: readonly ReleaseNotes[] = RELEASES): ReleaseNotes | null {
  return releases.find((r) => compareVersions(r.version, version) === 0) ?? null;
}

/** Said on the window to show releases' notes (Settings → About, Developer's preview): `detail` is the versions. */
export const WHATS_NEW_EVENT = 'openfilm:whats-new';
export function showWhatsNew(versions: string[]): void {
  window.dispatchEvent(new CustomEvent(WHATS_NEW_EVENT, { detail: versions }));
}
