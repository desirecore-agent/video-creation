import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { canonicalizeRelease, createReleaseManifest, readRuntimePayload, writeRelease, writeDependencyLicenses } from './release.mjs';

const roots = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function put(root, path, bytes = path) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'video-creation-release-')); roots.push(root);
  const files = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'TRADEMARK.md', 'UPSTREAM.md', 'THIRD_PARTY_NOTICES.md',
    'packages/openfilm/package.json', 'packages/openfilm/product.json', 'packages/openfilm/product.schema.json',
    'packages/openfilm/LICENSE', 'packages/openfilm/THIRD_PARTY_NOTICES.md', 'packages/openfilm/SPEC.md',
    'packages/openfilm/MANUAL.md', 'packages/openfilm/studio/client.mjs', 'desirecore/RUNTIME.md',
    'packages/openfilm/bin/openfilm.mjs', 'packages/openfilm/src/product.mjs',
    'packages/openfilm/studio/server/server.mjs', 'packages/openfilm/studio/server/bridge.js',
    'packages/openfilm/studio/ui/dist/index.html', 'packages/openfilm/studio/ui/dist/assets/main.js',
    'packages/openfilm/skills/video/SKILL.md', 'packages/openfilm/examples-index/examples.json',
    'desirecore/cli.mjs', 'desirecore/client.mjs', 'desirecore/config.mjs', 'desirecore/config.schema.json',
    'desirecore/mcp.mjs', 'desirecore/setup-runtime.mjs', 'desirecore/ffmpeg-runtime.mjs',
    'desirecore/licenses/example/LICENSE', 'desirecore/licenses/manifest.json',
  ];
  for (const file of files) put(root, file);
  put(root, 'packages/openfilm/package.json', JSON.stringify({ name: '@desirecore-agent/video-creation', version: '0.2.0' }));
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('freezes the actual runtime and built UI with explicit license and dependency inputs', () => {
  const root = fixture();
  for (const excluded of ['apps/desktop/main.mjs', 'node_modules/private/index.js',
    'packages/openfilm/src/render.test.mjs', 'packages/openfilm/studio/server/secret.test.mjs',
    'packages/openfilm/studio/ui/src/App.tsx', 'packages/openfilm/studio/ui/dist/assets/main.js.map',
    'desirecore/release.mjs', 'desirecore/release.test.mjs', 'desirecore/app-release.json', 'desirecore/runtime-config.json']) put(root, excluded);
  const manifest = createReleaseManifest(readRuntimePayload(root));
  const paths = manifest.files.map((file) => file.path);
  assert.ok(paths.includes('packages/openfilm/studio/ui/dist/assets/main.js'));
  assert.ok(paths.includes('packages/openfilm/studio/server/bridge.js'));
  assert.ok(paths.includes('desirecore/cli.mjs'));
  assert.ok(paths.includes('pnpm-lock.yaml'));
  assert.ok(paths.includes('packages/openfilm/LICENSE'));
  assert.ok(!paths.some((path) => path.includes('desktop') || path.includes('node_modules') || path.includes('.test.') || path.endsWith('.map')));
  assert.ok(!paths.includes('desirecore/app-release.json'));
  assert.deepEqual(manifest.definition.entrypoints, [{ id: 'studio', name: '创作工作台', kind: 'embedded-web', serviceRef: 'video-creation:studio' }]);
  assert.equal(manifest.definition.sourceId, undefined);
  assert.deepEqual(manifest.supportedPlatforms, ['darwin', 'win32', 'linux']);
  assert.equal(manifest.files.find((file) => file.path === 'packages/openfilm/LICENSE').role, 'license');
  assert.equal(manifest.files.find((file) => file.path === 'pnpm-lock.yaml').role, 'dependency');
  assert.equal(manifest.files.find((file) => file.path === 'desirecore/licenses/example/LICENSE').role, 'license');
  assert.ok(!paths.includes('desirecore/runtime-config.json'));
  assert.equal(manifest.releaseDigest, digest(canonicalizeRelease(manifest)));
});

test('materializes matching bytes once and checks all payload hashes without mutating the original snapshot', () => {
  const root = fixture();
  const result = writeRelease({ root });
  const reviewed = readFileSync(join(root, 'desirecore/app-release.json'), 'utf8');
  assert.equal(reviewed, readFileSync(join(result.materialRoot, 'app-release.json'), 'utf8'));
  for (const file of result.manifest.files) {
    const actual = readFileSync(join(result.materialRoot, file.path));
    assert.equal(actual.length, file.size);
    assert.equal(digest(actual), file.sha256);
  }
  assert.deepEqual(writeRelease({ root, check: true }).manifest, result.manifest);
  assert.throws(() => writeRelease({ root }), /already exists/);
  const oldSource = result.manifest.source.sha256;
  put(root, 'packages/openfilm/studio/ui/dist/assets/main.js', 'new compiled bytes');
  const updated = createReleaseManifest(readRuntimePayload(root));
  assert.notEqual(updated.source.sha256, oldSource);
  assert.notEqual(updated.releaseDigest, result.manifest.releaseDigest);
  assert.throws(() => writeRelease({ root, check: true }), /stale/);
  assert.equal(readFileSync(join(root, 'desirecore/app-release.json'), 'utf8'), reviewed);
  assert.equal(readFileSync(join(result.materialRoot, 'packages/openfilm/studio/ui/dist/assets/main.js'), 'utf8'), 'packages/openfilm/studio/ui/dist/assets/main.js');
});

test('rejects incomplete builds and symbolic links instead of exporting files outside the runtime', () => {
  const root = fixture();
  rmSync(join(root, 'packages/openfilm/studio/ui/dist/index.html'));
  assert.throws(() => readRuntimePayload(root), /index.html is missing/);
  put(root, 'packages/openfilm/studio/ui/dist/index.html');
  symlinkSync(join(root, 'LICENSE'), join(root, 'packages/openfilm/src/outside.mjs'));
  assert.throws(() => readRuntimePayload(root), /symbolic links/);
});

test('canonical digest ignores object insertion order and the self digest but includes payload changes', () => {
  const manifest = createReleaseManifest(readRuntimePayload(fixture()));
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  reordered.files = [...manifest.files].reverse();
  reordered.releaseDigest = '0'.repeat(64);
  assert.equal(canonicalizeRelease(reordered), canonicalizeRelease(manifest));
  reordered.definition = { ...reordered.definition, name: 'changed' };
  assert.notEqual(canonicalizeRelease(reordered), canonicalizeRelease(manifest));
});

test('extracts full notices from actual dependency graphs and recognizes the font OFL over wrapper metadata', () => {
  const root = fixture();
  put(root, 'package.json', JSON.stringify({ name: 'runtime' }));
  const addPackage = (name, { dependencies = {}, license = 'MIT', text = `Full license for ${name}` } = {}) => {
    const path = `node_modules/${name}`;
    put(root, `${path}/package.json`, JSON.stringify({ name, version: '1.0.0', license, dependencies }));
    put(root, `${path}/LICENSE`, text);
    put(root, `${path}/index.js`, 'private dependency code is not copied');
  };
  addPackage('ajv', { dependencies: { 'ajv-child': '1.0.0' } }); addPackage('ajv-child');
  addPackage('@fontsource-variable/inter', { license: 'MIT', text: 'Original font copyright\nSIL OPEN FONT LICENSE Version 1.1\nFull OFL text' });
  addPackage('react'); addPackage('react-dom', { dependencies: { scheduler: '1.0.0' } }); addPackage('scheduler');
  addPackage('lucide-react'); addPackage('playwright-core', { license: 'Apache-2.0' });
  put(root, 'node_modules/playwright-core/NOTICE', 'Original Playwright notice');
  put(root, 'node_modules/playwright-core/ThirdPartyNotices.txt', 'Full bundled third-party notices');
  addPackage('vite', { dependencies: { 'not-shipped-compiler': '1.0.0' } }); addPackage('tailwindcss');
  const summary = writeDependencyLicenses({ root });
  assert.equal(summary.packages, 10);
  const index = JSON.parse(readFileSync(join(root, 'desirecore/licenses/manifest.json'), 'utf8'));
  const font = index.packages.find(pkg => pkg.name === '@fontsource-variable/inter');
  assert.equal(font.license, 'OFL-1.1');
  assert.match(readFileSync(join(root, font.notices[0].path), 'utf8'), /Original font copyright/);
  assert.ok(index.packages.some(pkg => pkg.name === 'ajv-child'));
  assert.ok(index.packages.some(pkg => pkg.name === 'scheduler'));
  assert.ok(!index.packages.some(pkg => pkg.name === 'not-shipped-compiler'));
  assert.equal(index.packages.find(pkg => pkg.name === 'playwright-core').notices.length, 3);
  assert.ok(index.packages.every(pkg => pkg.notices.every(file => !file.path.endsWith('.js'))));
  assert.deepEqual(writeDependencyLicenses({ root, check: true }), summary);
  put(root, 'node_modules/react/LICENSE', 'updated actual license');
  assert.throws(() => writeDependencyLicenses({ root, check: true }), /missing or stale/);
});
