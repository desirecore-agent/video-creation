import type { ProjectFilm, ProjectMetadata } from '../api';

/** Renaming the same project preserves the film object, revision and local edit history. */
export function mergeProjectMetadata(current: ProjectFilm | null, next: ProjectMetadata): ProjectFilm | null {
  if (!current || current.project.id !== next.project.id) return current;
  return { ...current, project: next.project, folder: next.folder };
}
