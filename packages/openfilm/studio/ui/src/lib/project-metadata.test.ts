import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProjectMetadata } from './project-metadata.ts';
import type { ProjectFilm } from '../api';

test('same-id rename updates the source directory without resetting an edited film', () => {
  const loaded: ProjectFilm = {
    project: { id: 'same-project', name: 'Draft', path: '/films/Draft', openedAt: 1, missing: false },
    folder: 'http://localhost:8001/p/stable-token/', text: 'the original film text', rev: 'original-rev',
    value: { tracks: [{ clips: [{ src: 'title.html', id: 'title', overrides: [{ text: 'Human edit' }] }] }] },
    doc: { tracks: [] }, problems: [],
  };
  const renamed = { project: { ...loaded.project, name: 'Final', path: '/films/Final' }, folder: loaded.folder };
  const next = mergeProjectMetadata(loaded, renamed)!;
  assert.equal(next.project.path, '/films/Final');
  assert.equal(next.project.name, 'Final');
  assert.equal(next.value, loaded.value, 'local edits keep their identity');
  assert.equal(next.doc, loaded.doc);
  assert.equal(next.rev, loaded.rev);
  assert.equal(next.text, loaded.text);
  assert.equal(loaded.project.path, '/films/Draft', 'does not mutate an earlier render');
  assert.equal(mergeProjectMetadata(next, { ...renamed, project: { ...renamed.project, id: 'another-project' } }), next, 'events from another source never switch projects');
  assert.equal(mergeProjectMetadata(null, renamed), null, 'metadata never invents a film before it loads');
});
