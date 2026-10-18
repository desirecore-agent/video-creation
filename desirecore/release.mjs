#!/usr/bin/env node
/**
 * Freeze the existing Studio runtime into an app-authoring-v1 material root.
 * No dependency installation, app registration, startup, or upload happens here.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PACKAGE = 'packages/openfilm';
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE_BYTES = 128 * 1024 * 1024;

/** These are runtime files and declared dependency inputs, never installed dependencies. */
const REQUIRED_FILES = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'TRADEMARK.md', 'UPSTREAM.md', 'THIRD_PARTY_NOTICES.md',
  `${PACKAGE}/package.json`, `${PACKAGE}/product.json`, `${PACKAGE}/product.schema.json`,
  `${PACKAGE}/LICENSE`, `${PACKAGE}/THIRD_PARTY_NOTICES.md`, `${PACKAGE}/SPEC.md`, `${PACKAGE}/MANUAL.md`,
  `${PACKAGE}/studio/client.mjs`, 'desirecore/RUNTIME.md',
  'desirecore/cli.mjs', 'desirecore/client.mjs', 'desirecore/config.mjs', 'desirecore/config.schema.json',
  'desirecore/mcp.mjs', 'desirecore/setup-runtime.mjs', 'desirecore/ffmpeg-runtime.mjs',
];
const RUNTIME_TREES = [
  `${PACKAGE}/bin`, `${PACKAGE}/src`, `${PACKAGE}/studio/server`,
  `${PACKAGE}/studio/ui/dist`, `${PACKAGE}/skills`, `${PACKAGE}/examples-index`,
  'desirecore/licenses',
];

/** Full license/notice texts from the installed packages actually used by this build. */
export function writeDependencyLicenses({ root = SOURCE_ROOT, check = false } = {}) {
  const records = new Map();
  const outputs = new Map();
  const requireAt = (manifest) => createRequire(manifest);
  const locate = (name, fromManifest) => {
    const require = requireAt(fromManifest);
    let path;
    try { path = require.resolve(`${name}/package.json`); }
    catch {
      path = require.resolve(name);
      while (dirname(path) !== path) {
        path = dirname(path);
        if (existsSync(resolve(path, 'package.json'))) {
          const metadata = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8'));
          if (metadata.name === name) return { manifestPath: resolve(path, 'package.json'), metadata };
        }
      }
      throw new Error(`Cannot locate installed dependency license: ${name}`);
    }
    return { manifestPath: path, metadata: JSON.parse(readFileSync(path, 'utf8')) };
  };
  const visit = (name, fromManifest, dependencies = true) => {
    const { manifestPath, metadata } = locate(name, fromManifest);
    const identity = `${metadata.name}@${metadata.version}`;
    if (records.has(identity)) return;
    const packageRoot = dirname(manifestPath);
    const directory = `${metadata.name.replace(/^@/, '').replaceAll('/', '__')}@${metadata.version}`;
    const names = readdirSync(packageRoot).filter((file) => /^(?:licen[cs]e|copying|notice|thirdpartynotices)(?:[._ -].*)?$/i.test(file)
      && lstatSync(resolve(packageRoot, file)).isFile()).sort();
    if (!names.length) throw new Error(`Installed dependency lacks a complete license file: ${identity}`);
    const notices = names.map((file) => {
      const path = `desirecore/licenses/${directory}/${file}`;
      const bytes = readFileSync(resolve(packageRoot, file));
      outputs.set(path, bytes);
      return { path, sha256: sha256(bytes), size: bytes.length };
    });
    // Package metadata may say MIT for the wrapper; the actual font LICENSE is authoritative.
    const licenseText = names.map((file) => readFileSync(resolve(packageRoot, file), 'utf8')).join('\n');
    const license = metadata.name === '@fontsource-variable/inter'
      ? (/SIL OPEN FONT LICENSE Version 1\.1/.test(licenseText) ? 'OFL-1.1' : null) : metadata.license;
    if (!license) throw new Error(`Cannot verify license identity: ${identity}`);
    records.set(identity, { name: metadata.name, version: metadata.version, license,
      source: `https://registry.npmjs.org/${metadata.name.replace('/', '%2f')}/${metadata.version}`, notices });
    if (dependencies) for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) visit(dependency, manifestPath);
  };
  for (const name of ['ajv']) visit(name, resolve(root, 'package.json'));
  for (const name of ['@fontsource-variable/inter', 'react', 'react-dom', 'lucide-react', 'playwright-core'])
    visit(name, resolve(root, PACKAGE, 'package.json'));
  // Build-generated runtime/CSS helpers carry these licenses; their compiler dependency trees are not shipped.
  for (const name of ['vite', 'tailwindcss']) visit(name, resolve(root, PACKAGE, 'package.json'), false);
  outputs.set('desirecore/licenses/manifest.json', Buffer.from(`${JSON.stringify({ schemaVersion: 1,
    description: 'Full license and notice texts from installed runtime and bundled UI packages; no dependency code is copied.',
    packages: [...records.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
  }, null, 2)}\n`));
  for (const [path, bytes] of outputs) {
    if (check) {
      if (!existsSync(resolve(root, path)) || !readFileSync(resolve(root, path)).equals(bytes))
        throw new Error(`Dependency license is missing or stale: ${path}`);
    } else writeAtomic(resolve(root, path), bytes);
  }
  return { packages: records.size, files: outputs.size };
}

function isRuntimeFile(path) {
  return !path.split('/').some((part) => part === 'node_modules' || part.startsWith('.'))
    && !/(?:^|\/)[^/]*\.test\.[^/]+$/.test(path)
    && !path.endsWith('.map') && !path.endsWith('.tsbuildinfo');
}

function readRegularFile(root, path) {
  const file = resolve(root, path);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)
    throw new Error(`Release payload must be a regular file of at most 128 MiB: ${path}`);
  const bytes = readFileSync(file);
  if (bytes.length !== stat.size) throw new Error(`Release payload changed while reading: ${path}`);
  return bytes;
}

function walk(root, path, collected) {
  const stat = lstatSync(resolve(root, path));
  if (stat.isSymbolicLink()) throw new Error(`Release payload cannot contain symbolic links: ${path}`);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(resolve(root, path)).sort()) {
      const child = `${path}/${entry}`;
      if (isRuntimeFile(child)) walk(root, child, collected);
    }
  } else if (stat.isFile() && isRuntimeFile(path)) collected.add(path);
}

/** Read once so the manifest and staged payload describe the same frozen bytes. */
export function readRuntimePayload(root = SOURCE_ROOT) {
  const selected = new Set(REQUIRED_FILES);
  for (const path of REQUIRED_FILES) if (!existsSync(resolve(root, path)))
    throw new Error(`Required release file is missing: ${path}`);
  for (const tree of RUNTIME_TREES) {
    if (!existsSync(resolve(root, tree))) throw new Error(`Required runtime tree is missing: ${tree}; build the Studio UI first`);
    walk(root, tree, selected);
  }
  if (!selected.has(`${PACKAGE}/studio/ui/dist/index.html`))
    throw new Error('Built Studio UI index.html is missing; run pnpm build first');
  const payload = [...selected].sort().map((path) => ({ path, bytes: readRegularFile(root, path) }));
  if (payload.length > 4096) throw new Error('Release contains more than the platform limit of 4096 payload files');
  return payload;
}

function roleFor(path) {
  if (path.startsWith('desirecore/licenses/')) return 'license';
  if (path.includes('/studio/ui/dist/')) return 'ui';
  if (/(?:^|\/)(?:LICENSE|TRADEMARK\.md|THIRD_PARTY_NOTICES\.md)$/.test(path)) return 'license';
  if (/(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path)) return 'dependency';
  if (/\.(?:md|txt)$/.test(path)) return 'documentation';
  if (/\/(?:app|application)\.json$/.test(path)) return 'definition';
  return 'runtime';
}

/** Canonicalization is the public app-release-c14n-v1 wire format, with no private platform dependency. */
export function canonicalizeRelease(manifest) {
  const { releaseDigest: _digest, ...body } = manifest;
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical({ ...body, files: [...body.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }));
}

export function createReleaseManifest(payload) {
  const packageFile = payload.find((file) => file.path === `${PACKAGE}/package.json`);
  if (!packageFile) throw new Error('Runtime package manifest is missing');
  const pkg = JSON.parse(packageFile.bytes.toString('utf8'));
  const files = payload.map(({ path, bytes }) => ({ path, sha256: sha256(bytes), size: bytes.length, role: roleFor(path) }));
  // Always describe the actual selected working-tree bytes, including the locally built UI.
  // A checkout HEAD alone would misattribute uncommitted adapters or ignored dist files.
  const sourceDigest = sha256(JSON.stringify(files.map(({ path, sha256, size }) => ({ path, sha256, size }))));
  const manifest = {
    schemaVersion: 1,
    canonicalization: 'app-release-c14n-v1',
    definition: {
      id: 'video-creation', name: '视频创作', iconLetter: '影', version: pkg.version,
      entrypoints: [{ id: 'studio', name: '创作工作台', kind: 'embedded-web', serviceRef: 'video-creation:studio' }],
      placementPolicy: { showInMyApps: true, allowNavPin: true, allowAgentBinding: true },
    },
    delivery: { type: 'native-app', runtimeInstructionsPath: 'desirecore/RUNTIME.md' },
    files,
    source: { kind: 'worktree', sha256: sourceDigest },
    supportedPlatforms: ['darwin', 'win32', 'linux'],
    requiredCapabilities: ['app-authoring-v1', 'release', 'runtime-binding'],
    bridgeCapabilities: ['connect', 'capabilities', 'publishSelection', 'requestWork'],
    dataContract: {
      schemaVersion: 1, formatVersion: 'video-creation-home-v1',
      readableVersions: ['video-creation-home-v1'], writableVersions: ['video-creation-home-v1'],
      files: [], uninstallRetention: 'retain', backupInstructionsPath: 'desirecore/RUNTIME.md',
      restoreInstructionsPath: 'desirecore/RUNTIME.md',
    },
    instructionsPath: 'desirecore/RUNTIME.md',
  };
  manifest.releaseDigest = sha256(canonicalizeRelease(manifest));
  return manifest;
}

function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, file);
}

export function writeRelease({ root = SOURCE_ROOT, output = resolve(root, 'desirecore/.release'), check = false } = {}) {
  root = resolve(root); output = resolve(output);
  const outputRelative = relative(root, output);
  // Prevent a command typo from materializing on top of the repository or a runtime source directory.
  if (!outputRelative || RUNTIME_TREES.some((tree) => output === resolve(root, tree)
    || output.startsWith(`${resolve(root, tree)}${sep}`)) || REQUIRED_FILES.some((path) => output === resolve(root, path)))
    throw new Error('Release output must be a separate material directory');
  const payload = readRuntimePayload(root);
  const manifest = createReleaseManifest(payload);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (check) {
    if (!existsSync(resolve(root, 'desirecore/app-release.json')) || readFileSync(resolve(root, 'desirecore/app-release.json'), 'utf8') !== text)
      throw new Error('Reviewed app-release.json is stale; build and regenerate the release');
    for (const file of payload) {
      const staged = resolve(output, file.path);
      if (!existsSync(staged) || !readRegularFile(output, file.path).equals(file.bytes))
        throw new Error(`Staged runtime is missing or stale: ${file.path}`);
    }
    if (readFileSync(resolve(output, 'app-release.json'), 'utf8') !== text) throw new Error('Staged manifest is stale');
  } else {
    if (existsSync(output) && readdirSync(output).length)
      throw new Error('Release output already exists; choose a fresh --output directory to preserve the prior snapshot');
    for (const file of payload) writeAtomic(resolve(output, file.path), file.bytes);
    writeAtomic(resolve(output, 'app-release.json'), text);
    writeAtomic(resolve(root, 'desirecore/app-release.json'), text);
  }
  return { materialRoot: output, manifestPath: 'app-release.json', manifest, payloadBytes: payload.reduce((sum, file) => sum + file.bytes.length, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    let output; let check = false; let licensesOnly = false;
    while (args.length) {
      const option = args.shift();
      if (option === '--check') check = true;
      else if (option === '--licenses-only') licensesOnly = true;
      else if (option === '--output' && args.length) output = resolve(args.shift());
      else throw new Error(`Unknown or incomplete argument: ${option}`);
    }
    const licenses = writeDependencyLicenses({ check });
    if (licensesOnly) { console.log(JSON.stringify({ ...licenses, checked: check }, null, 2)); }
    else {
    const result = writeRelease({ ...(output ? { output } : {}), check });
    console.log(JSON.stringify({ materialRoot: result.materialRoot, manifestPath: result.manifestPath,
      releaseDigest: result.manifest.releaseDigest, files: result.manifest.files.length, payloadBytes: result.payloadBytes, checked: check }, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
