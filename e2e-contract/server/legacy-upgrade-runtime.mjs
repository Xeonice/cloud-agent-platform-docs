import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBuiltin } from 'node:module';
import { canonical, digest, invariant } from '../../deploy/upgrade/trust.mjs';
import { treeManifest } from '../../deploy/upgrade/io.mjs';

const factories = Object.freeze({
  createStableEntry: 'stable-entry.mjs',
  createCandidateSupervisor: 'candidate-supervisor.mjs',
  createCoordinatorClient: 'coordinator-client.mjs',
  createDockerRoleAdapter: 'docker-role-adapter.mjs',
});
// Node caches relative dependencies independently of the entry namespace. An
// immutable artifact path can never be rebound to a different verified tree.
const loaded = new Map();
async function regular(path, directory = false) {
  let s;
  try { s = await fs.lstat(path); }
  catch (e) { if (e.code === 'ENOENT') throw Object.assign(Error('Required legacy runtime file is absent'), { code: 'LEGACY_RUNTIME_FILE_REQUIRED' }); throw e; }
  invariant((directory ? s.isDirectory() : s.isFile()) && !s.isSymbolicLink() && (s.mode & 0o022) === 0 &&
    (!process.getuid || s.uid === process.getuid() || s.uid === 0) && await fs.realpath(path) === path, 'LEGACY_RUNTIME_PATH_INVALID');
  return s;
}

/** Explicit QA compatibility gate, not a JS sandbox or source of executable
 * trust. The caller's independently verified initial release/tree is the trust
 * anchor. Only the four fixed factories and their package-local static ESM
 * dependencies are supported; dynamic/require/bare/external imports fail closed.
 * It never copies current code into an old artifact or supplies a replacement
 * factory. legacyProvided=false preserves the caller's current fixture path.
 */
export async function loadLegacyUpgradeRuntime({ initialRoot, initialRelease, initialTreeDigest, legacyProvided = false } = {}) {
  invariant(typeof legacyProvided === 'boolean', 'LEGACY_RUNTIME_SELECTION_INVALID');
  if (!legacyProvided) return null;
  invariant(typeof initialRoot === 'string' && isAbsolute(initialRoot) && resolve(initialRoot) === initialRoot && initialRelease?.components,
    'LEGACY_RUNTIME_VERIFIED_ARTIFACT_REQUIRED');
  await regular(initialRoot, true);
  const installer = join(initialRoot, 'installer'); await regular(installer, true);
  const bundlePath = join(initialRoot, 'upgrade-artifact.json');
  invariant((await regular(bundlePath)).size <= 64 * 1024 * 1024, 'LEGACY_RUNTIME_BUNDLE_TOO_LARGE');
  const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf8'));
  const payload = (await treeManifest(initialRoot)).filter(f => !['upgrade-artifact.json', 'installed.json'].includes(f.path));
  invariant(bundle.schemaVersion === 1 && Array.isArray(bundle.files) && canonical(payload) === canonical(bundle.files) &&
    digest(payload) === bundle.treeDigest && (initialTreeDigest === undefined || bundle.treeDigest === initialTreeDigest) &&
    canonical(bundle.components) === canonical(initialRelease.components), 'LEGACY_RUNTIME_ARTIFACT_CHANGED');
  const installerFiles = payload.filter(f => f.path.startsWith('installer/') && f.path.endsWith('.mjs') && !f.path.endsWith('.test.mjs'));
  invariant(installerFiles.some(f => f.path === 'installer/controller-main.mjs') &&
    digest(installerFiles) === initialRelease.components.installer?.artifactDigest &&
    digest(installerFiles) === initialRelease.components.installer?.inputFingerprint, 'LEGACY_RUNTIME_INSTALLER_IDENTITY_CHANGED');
  const records = new Map(payload.map(f => [f.path, f])), closure = new Map();
  async function visit(path) {
    if (closure.has(path)) return;
    invariant(closure.size < 128, 'LEGACY_RUNTIME_IMPORT_CLOSURE_TOO_LARGE');
    const rel = relative(installer, path);
    invariant(rel !== '' && !isAbsolute(rel) && !rel.startsWith('../') && rel.endsWith('.mjs'), 'LEGACY_RUNTIME_IMPORT_OUTSIDE_INSTALLER');
    const stat = await regular(path);
    invariant(stat.size <= 2 * 1024 * 1024, 'LEGACY_RUNTIME_SOURCE_TOO_LARGE');
    const bytes = await fs.readFile(path), record = records.get('installer/' + rel.split('\\').join('/'));
    invariant(record && record.bytes === bytes.length && record.digest === digest(bytes) && record.link === undefined,
      'LEGACY_RUNTIME_IMPORT_NOT_VERIFIED');
    const source = bytes.toString('utf8'); closure.set(path, { bytes, source });
    // Supported historical installers use literal static ESM declarations. This
    // deliberately refuses unsupported module loading instead of guessing a
    // dependency or resolving to a current checkout/node_modules implementation.
    invariant(!/\b(?:import|require)\s*\(/.test(source) && !/\bcreateRequire\s*\(/.test(source), 'LEGACY_RUNTIME_DYNAMIC_IMPORT_UNSUPPORTED');
    const declarations = [...source.matchAll(/\b(?:import\s+(?:(?:[\w*$,{}\s]+?)\s+from\s*)?|export\s+(?:\*|\{[^}]*\})\s+from\s*)['"]([^'"\r\n]+)['"]/g)];
    for (const match of declarations) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) { invariant(isBuiltin(specifier), 'LEGACY_RUNTIME_BUILTIN_INVALID'); continue; }
      invariant(/^\.\/[a-zA-Z0-9._/-]+\.mjs$/.test(specifier) && !specifier.includes('/../'), 'LEGACY_RUNTIME_IMPORT_OUTSIDE_INSTALLER');
      await visit(resolve(dirname(path), specifier));
    }
    const remainder = declarations.reduce((text, match) => text.replace(match[0], ''), source);
    invariant(!/^(?:[ \t]*)import\s+(?![.]meta\b)/m.test(remainder) && !/^(?:[ \t]*)export\s+(?:\*|\{[^}]*\})\s+from\b/m.test(remainder),
      'LEGACY_RUNTIME_IMPORT_SYNTAX_UNSUPPORTED');
  }
  for (const file of Object.values(factories)) await visit(join(installer, file));
  const identity = digest({ treeDigest: bundle.treeDigest, installer: initialRelease.components.installer });
  const prior = loaded.get(initialRoot);
  invariant(!prior || prior.identity === identity, 'LEGACY_RUNTIME_MODULE_CACHE_CONFLICT');
  if (prior) return prior.promise;
  const promise = (async () => {
    const result = {};
    for (const [name, file] of Object.entries(factories)) {
      const module = await import(pathToFileURL(join(installer, file)).href);
      invariant(typeof module[name] === 'function', 'LEGACY_RUNTIME_FACTORY_REQUIRED'); result[name] = module[name];
    }
    // Detect changes while native ESM resolved the verified closure. Artifact
    // custody must still keep this immutable directory pinned after loading.
    for (const [path, { bytes }] of closure) {
      await regular(path); invariant((await fs.readFile(path)).equals(bytes), 'LEGACY_RUNTIME_IMPORT_CHANGED_DURING_LOAD');
    }
    return Object.freeze(result);
  })();
  loaded.set(initialRoot, { identity, promise });
  return promise;
}
