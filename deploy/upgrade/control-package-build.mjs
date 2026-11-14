import * as fs from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute, posix } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { command } from './artifacts.mjs';
import { atomicJson, fileDigest, inside, secureDirectory, treeManifest } from './io.mjs';
import { canonical, digest, invariant, DIGEST } from './trust.mjs';
import { validateControlPackage } from './control-package.mjs';

const ENTRIES = ['control-store-factory', 'upgrade-service', 'upgrade-catalog', 'upgrade-projection', 'upgrade-contract-service']
  .map(name => `apps/api/dist/platform/upgrade/${name}.js`);
const UNSAFE = /(?:^|[/\\])(?:app|platform)\.module\.js$|boxlite|[/\\](?:sandbox|runtime|automation|credential|image|project|terminal)[/\\]dist[/\\]|runtime-owner.*registry/i;
const packageName = /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;

// A separate process receives no deployment ENV or keys. Importing a stable
// controller must neither bootstrap an application nor open a database/socket.
// The sole constructor exception checks the actual native SQLite ABI in memory.
export async function probeControlImportClosure(apiRoot, { run = command, node = process.execPath } = {}) {
  apiRoot = await fs.realpath(resolve(apiRoot));
  const script = `
    const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
    const root=process.cwd(),unsafe=${UNSAFE.toString()};
    require('node:net').Server.prototype.listen=function(){throw Error('CONTROL_IMPORT_LISTENER_FORBIDDEN')};
    require('node:net').Socket.prototype.connect=function(){throw Error('CONTROL_IMPORT_NETWORK_FORBIDDEN')};
    const sqliteEntry=Module.createRequire(path.join(root,'apps/api/package.json')).resolve('better-sqlite3');
    const load=Module._load;let memoryProbe=false,constructors=0;
    function databaseAllowed(args){
      if(!memoryProbe||args[0]!==':memory:')throw Error('CONTROL_IMPORT_DATABASE_FORBIDDEN');
      constructors++;
    }
    Module._load=function(name,parent,isMain){
      const resolved=Module._resolveFilename(name,parent,isMain);
      if(typeof resolved==='string'&&unsafe.test(resolved))throw Error('CONTROL_IMPORT_BUSINESS_DEPENDENCY');
      const value=load.apply(this,arguments);
      if(resolved===sqliteEntry)return new Proxy(value,{
        construct(target,args){databaseAllowed(args);return Reflect.construct(target,args);},
        apply(target,self,args){databaseAllowed(args);return Reflect.apply(target,self,args);}
      });
      return value;
    };
    for(const entry of ${JSON.stringify(ENTRIES)})require(path.join(root,entry));
    const req=Module.createRequire(path.join(root,'apps/api/package.json'));
    req('@platform/contracts');memoryProbe=true;
    const db=new(req('better-sqlite3'))(':memory:');
    if(db.prepare('SELECT 1 ok').get().ok!==1)throw Error('CONTROL_SQLITE_ABI_FAILED');db.close();memoryProbe=false;
    const files=Object.keys(require.cache).sort();
    const packages=new Map();
    for(const file of files){
      let folder=path.dirname(file),manifest;
      while(true){try{manifest=JSON.parse(fs.readFileSync(path.join(folder,'package.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
        if(manifest?.name)break;const up=path.dirname(folder);if(up===folder)throw Error('CONTROL_DEPENDENCY_MANIFEST_MISSING');folder=up;}
      packages.set(folder,{root:folder,name:manifest.name,version:manifest.version,workspace:!file.includes(path.sep+'node_modules'+path.sep)});
    }
    if(constructors!==1)throw Error('CONTROL_IMPORT_DATABASE_COUNT_INVALID');
    process.stdout.write(JSON.stringify({files,packages:[...packages.values()].sort((a,b)=>a.root.localeCompare(b.root)),nativeAbi:process.versions.modules,nodeMajor:Number(process.versions.node.split('.')[0]),platform:process.platform,arch:process.arch,databaseConstructors:constructors}));
  `;
  const raw = await run(node, ['-e', script], { cwd: apiRoot, env: { NODE_ENV: 'production', PATH: process.env.PATH || '/usr/bin:/bin' } });
  const observed = JSON.parse(raw);
  invariant(observed.nodeMajor === 22 && observed.nativeAbi === process.versions.modules && observed.platform === process.platform && observed.arch === process.arch && observed.databaseConstructors === 1 && Array.isArray(observed.files) && observed.files.length > 0 && observed.files.length <= 20000 && Array.isArray(observed.packages), 'CONTROL_IMPORT_CLOSURE_INVALID');
  const files = [];
  for (const source of observed.files) {
    invariant(isAbsolute(source) && inside(apiRoot, source) && !UNSAFE.test(source), 'CONTROL_IMPORT_CLOSURE_ESCAPE');
    const stat = await fs.lstat(source);
    invariant(stat.isFile() && !stat.isSymbolicLink(), 'CONTROL_IMPORT_FILE_INVALID');
    files.push({ path: relative(apiRoot, source).split('\\').join('/'), ...(await fileDigest(source)) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  invariant(files.some(file => file.path.endsWith('/better_sqlite3.node')), 'CONTROL_NATIVE_SQLITE_BINDING_MISSING');
  const packageIdentities = [], dependencyPackages = new Map();
  for (const dependency of observed.packages) {
    invariant(packageName.test(dependency.name) && typeof dependency.version === 'string' && inside(apiRoot, dependency.root), 'CONTROL_DEPENDENCY_OUTSIDE_INPUT');
    if (dependency.workspace) invariant(['@platform/api', '@platform/contracts', '@platform/shared-kernel'].includes(dependency.name), 'CONTROL_IMPORT_BUSINESS_WORKSPACE');
    const manifest = await fileDigest(join(dependency.root, 'package.json'));
    const item = { path: relative(apiRoot, dependency.root).split('\\').join('/'), name: dependency.name, version: dependency.version, manifestDigest: manifest.digest };
    if (!dependency.workspace) {
      item.runtimeTreeDigest = digest(await dependencyFiles(dependency.root));
      const previous = dependencyPackages.get(dependency.name);
      invariant(!previous || previous.version === dependency.version && previous.digest === item.runtimeTreeDigest, 'CONTROL_DEPENDENCY_VARIANT_CONFLICT');
      dependencyPackages.set(dependency.name, { name: dependency.name, version: dependency.version, digest: item.runtimeTreeDigest });
    }
    packageIdentities.push(item);
  }
  return { apiRoot, entries: ENTRIES, files, packages: observed.packages, packageIdentities, dependencyPackages: [...dependencyPackages.values()].sort((a,b) => a.name.localeCompare(b.name)),
    closureDigest: digest({ files, packageIdentities, platform: observed.platform, arch: observed.arch, nativeAbi: observed.nativeAbi }), nativeAbi: observed.nativeAbi,
    nodeMajor: observed.nodeMajor, platform: observed.platform, arch: observed.arch, opensBusinessDatabase: false, startsListeners: false, initializesSdk: false };
}

async function frozenSource(repository, expectedRevision, run) {
  repository = await fs.realpath(resolve(repository));
  invariant(/^[a-f0-9]{40}$/.test(expectedRevision), 'CONTROL_SOURCE_REVISION_INVALID');
  const actual = (await run('git', ['rev-parse', 'HEAD'], { cwd: repository })).trim();
  invariant(actual === expectedRevision, 'CONTROL_SOURCE_REVISION_CHANGED');
  invariant((await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repository })).trim() === '', 'CONTROL_SOURCE_NOT_FROZEN');
  return { repository, revision: actual };
}

async function copyFile(source, target) {
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  await fs.chmod(target, (await fs.stat(source)).mode & 0o755);
}

async function dependencyFiles(root) {
  const files = [];
  async function visit(folder) {
    for (const name of (await fs.readdir(folder)).sort()) {
      if (name === 'node_modules') continue; // Dependencies are resolved from the observed graph below.
      const path = join(folder, name), stat = await fs.lstat(path), rel = relative(root, path).split('\\').join('/');
      invariant(!/\.(?:pem|key|p12)$|(?:^|\/)\.env(?:\.|$)/.test(rel), 'PRIVATE_FILE_IN_PACKAGE');
      if (stat.isDirectory()) await visit(path);
      else if (stat.isSymbolicLink()) {
        const link = await fs.readlink(path);
        invariant(!isAbsolute(link) && inside(root, await fs.realpath(path)), 'CONTROL_DEPENDENCY_LINK_ESCAPE');
        files.push({ path: rel, mode: stat.mode & 0o777, link });
      } else {
        invariant(stat.isFile(), 'SPECIAL_FILE_IN_PACKAGE');
        files.push({ path: rel, mode: stat.mode & 0o777, ...(await fileDigest(path)) });
      }
    }
  }
  await visit(root);
  return files;
}

async function copyApiClosure(proof, target) {
  const selected = new Map();
  for (const dependency of proof.packages) {
    if (dependency.workspace) continue;
    const files = await dependencyFiles(dependency.root);
    const previous = selected.get(dependency.name), identity = digest(files);
    invariant(!previous || (previous.version === dependency.version && previous.digest === identity), 'CONTROL_DEPENDENCY_VARIANT_CONFLICT');
    if (previous) continue;
    selected.set(dependency.name, { version: dependency.version, digest: identity });
    const destination = join(target, 'node_modules', dependency.name);
    await fs.cp(dependency.root, destination, { recursive: true, dereference: false, verbatimSymlinks: true,
      filter: path => relative(dependency.root, path).split('/').every(part => part !== 'node_modules') });
  }
  for (const file of proof.files) {
    if (file.path.split('/').includes('node_modules')) continue;
    invariant(file.path.includes('/dist/') && /\.(js|json|node)$/.test(file.path), 'CONTROL_WORKSPACE_NOT_COMPILED');
    await copyFile(join(proof.apiRoot, file.path), join(target, file.path));
  }
  for (const dependency of proof.packages.filter(item => item.workspace)) {
    const path = relative(proof.apiRoot, dependency.root);
    await copyFile(join(dependency.root, 'package.json'), join(target, path, 'package.json'));
    if (dependency.name !== '@platform/api') {
      const link = join(target, 'node_modules', dependency.name);
      await fs.mkdir(dirname(link), { recursive: true, mode: 0o700 });
      await fs.symlink(relative(dirname(link), join(target, path)), link);
    }
  }
  return [...selected].map(([name, value]) => ({ name, ...value })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Development/CI staging is unsigned and carries no installation authority. */
export async function stageControlApiClosure({ apiRoot, targetRoot, run = command, node = process.execPath }) {
  const proof = await probeControlImportClosure(apiRoot, { run, node });
  targetRoot = resolve(targetRoot);
  invariant(!inside(proof.apiRoot, targetRoot) && !(await fs.lstat(targetRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; })), 'CONTROL_API_STAGE_OVERLAP');
  const dependencies = await copyApiClosure(proof, targetRoot);
  const actual = await probeControlImportClosure(targetRoot, { run, node });
  await treeManifest(targetRoot);
  return { apiRoot: targetRoot, source: proof, actual, dependencies };
}

export async function probeControlEntrypoint(artifactRoot, { run = command, node = process.execPath } = {}) {
  artifactRoot = await fs.realpath(resolve(artifactRoot));
  const script = `
    const Module=require('node:module'),path=require('node:path');
    require('node:net').Server.prototype.listen=function(){throw Error('CONTROL_IMPORT_LISTENER_FORBIDDEN')};
    require('node:net').Socket.prototype.connect=function(){throw Error('CONTROL_IMPORT_NETWORK_FORBIDDEN')};
    const sqliteEntry=Module.createRequire(path.join(process.cwd(),'api/apps/api/package.json')).resolve('better-sqlite3');
    const load=Module._load,unsafe=${UNSAFE.toString()};
    Module._load=function(name,parent,isMain){const file=Module._resolveFilename(name,parent,isMain);
      if(typeof file==='string'&&unsafe.test(file))throw Error('CONTROL_IMPORT_BUSINESS_DEPENDENCY');
      const value=load.apply(this,arguments);
      if(file===sqliteEntry)return new Proxy(value,{construct(){throw Error('CONTROL_IMPORT_DATABASE_FORBIDDEN')},apply(){throw Error('CONTROL_IMPORT_DATABASE_FORBIDDEN')}});
      return value;};
    const sqlite=require('node:sqlite');sqlite.DatabaseSync=new Proxy(sqlite.DatabaseSync,{construct(){throw Error('CONTROL_IMPORT_DATABASE_FORBIDDEN')}});Module.syncBuiltinESMExports();
    import(require('node:url').pathToFileURL(path.join(process.cwd(),'installer/control-main.mjs')).href).then(()=>{
      const files=Object.keys(require.cache);if(files.some(file=>unsafe.test(file)))throw Error('CONTROL_IMPORT_BUSINESS_DEPENDENCY');
      process.stdout.write('stable-control-entry-import-passed');
    }).catch(()=>{process.exitCode=1});
  `;
  const output = await run(node, ['-e', script], { cwd: artifactRoot, env: { NODE_ENV: 'production', PATH: process.env.PATH || '/usr/bin:/bin' } });
  invariant(output === 'stable-control-entry-import-passed', 'CONTROL_MAIN_IMPORT_FAILED');
  return { entry: 'installer/control-main.mjs', startsListeners: false, opensBusinessDatabase: false, initializesSdk: false };
}

/** Stage immutable unsigned bytes without accepting or reading a signing key.
 * The same closure/ABI/entry probes are used by the compatible build+sign API. */
export async function stageControlPackage({ apiRoot, installerRoot, outputRoot, version, apiRevision, projectRevision,
  apiSourceRoot, projectSourceRoot, expectedApiClosureDigest, expectedInstallerDigest,
  run = command, node = process.execPath }) {
  invariant(DIGEST.test(expectedApiClosureDigest) && DIGEST.test(expectedInstallerDigest), 'CONTROL_BUILD_INPUT_DIGEST_REQUIRED');
  const sources = { api: await frozenSource(apiSourceRoot, apiRevision, run), project: await frozenSource(projectSourceRoot, projectRevision, run) };
  const proof = await probeControlImportClosure(apiRoot, { run, node });
  invariant(proof.closureDigest === expectedApiClosureDigest, 'CONTROL_API_BUILD_INPUT_CHANGED');
  installerRoot = await fs.realpath(resolve(installerRoot));
  const installerFiles = (await treeManifest(installerRoot)).filter(file => file.path.endsWith('.mjs') && !file.path.endsWith('.test.mjs'));
  invariant(installerFiles.some(file => file.path === 'control-main.mjs') && installerFiles.some(file => file.path === 'controller-main.mjs'), 'CONTROL_INSTALLER_ENTRY_MISSING');
  invariant(installerFiles.every(file => !file.link && !file.path.includes('/')), 'CONTROL_INSTALLER_LAYOUT_INVALID');
  const engineFiles = installerFiles.map(file => ({ ...file, path: 'installer/' + file.path }));
  invariant(digest(engineFiles) === expectedInstallerDigest, 'CONTROL_EXECUTION_ENGINE_INPUT_CHANGED');
  const output = await secureDirectory(outputRoot), artifactRoot = join(output, 'artifact');
  invariant(!inside(proof.apiRoot, output) && !inside(installerRoot, output), 'CONTROL_BUILD_OUTPUT_OVERLAP');
  invariant(!(await fs.lstat(artifactRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; })), 'IMMUTABLE_CONTROL_ARTIFACT_EXISTS');
  await fs.mkdir(artifactRoot, { mode: 0o700 });
  const dependencies = await copyApiClosure(proof, join(artifactRoot, 'api'));
  for (const file of installerFiles) await copyFile(join(installerRoot, file.path), join(artifactRoot, 'installer', file.path));
  const actualProof = await probeControlImportClosure(join(artifactRoot, 'api'), { run, node });
  invariant(canonical(actualProof.dependencyPackages) === canonical(dependencies), 'CONTROL_DEPENDENCY_COPY_CHANGED');
  const entryImport = await probeControlEntrypoint(artifactRoot, { run, node });
  const files = await treeManifest(artifactRoot), actualEngine = files.filter(file => file.path.startsWith('installer/'));
  invariant(digest(actualEngine) === expectedInstallerDigest, 'CONTROL_EXECUTION_ENGINE_COPY_CHANGED');
  const manifest = validateControlPackage({ schemaVersion: 1, kind: 'upgrade-control', version, protocolVersion: 1,
    apiRevision: sources.api.revision, projectRevision: sources.project.revision, treeDigest: digest(files), executionEngineDigest: expectedInstallerDigest });
  await frozenSource(sources.api.repository, apiRevision, run); await frozenSource(sources.project.repository, projectRevision, run);
  invariant((await probeControlImportClosure(proof.apiRoot, { run, node })).closureDigest === expectedApiClosureDigest, 'CONTROL_API_BUILD_INPUT_CHANGED');
  invariant(digest((await treeManifest(installerRoot)).filter(file => file.path.endsWith('.mjs') && !file.path.endsWith('.test.mjs')).map(file => ({ ...file, path: 'installer/' + file.path }))) === expectedInstallerDigest, 'CONTROL_EXECUTION_ENGINE_INPUT_CHANGED');
  const manifestDigest = digest(manifest), unsignedManifestPath = join(output, 'control-package.unsigned.json');
  await exclusiveJson(unsignedManifestPath, manifest);
  const archivePath = join(output, `agent-upgrade-control-${version}-${process.platform}-${process.arch}.tgz`);
  invariant(!(await fs.lstat(archivePath).catch(() => null)), 'IMMUTABLE_CONTROL_ARCHIVE_EXISTS');
  // macOS copyfile metadata is outside the signed payload tree. Suppress its
  // AppleDouble entries as well as extended attributes, without changing modes.
  await run('tar', ['--no-xattrs', '-czf', archivePath, '-C', artifactRoot, '.'],
    { env: { PATH: process.env.PATH || '/usr/bin:/bin', COPYFILE_DISABLE: '1' } });
  await fs.chmod(archivePath, 0o600);
  const archive = { path: archivePath, ...(await fileDigest(archivePath)) };
  const receipt = { schemaVersion: 1, kind: 'control-package-unsigned-stage', outputRoot: output, artifactRoot, unsignedManifestPath, manifestDigest,
    platform: process.platform, arch: process.arch,
    apiRevision, projectRevision, executionEngineDigest: expectedInstallerDigest, treeDigest: manifest.treeDigest,
    sourceClosureDigest: proof.closureDigest, installedClosureDigest: actualProof.closureDigest, nativeAbi: actualProof.nativeAbi,
    entries: files.filter(file => file.path === 'installer/control-main.mjs' || ENTRIES.some(entry => file.path === 'api/' + entry)),
    dependencyPackages: dependencies, fileCount: files.length,
    importClosure: { startsListeners: false, opensBusinessDatabase: false, initializesSdk: false }, entryImport, sources, archive,
    signed: false, privateKeyAccessed: false };
  const receiptPath = join(output, 'control-package.staged.json');await exclusiveJson(receiptPath, receipt);
  return { ...receipt, receiptPath };
}

async function exclusiveJson(path, value) {
  const handle = await fs.open(path, 'wx', 0o600);
  try { await handle.writeFile(canonical(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
}
async function readStagedFile(path, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const stat = await fs.lstat(path);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o022) === 0 && stat.size <= maximumBytes,
    'CONTROL_STAGED_FILE_INVALID');
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

/** Read the archive payload itself, without executing or extracting its code.
 * This lets the separately-owned publisher verify Linux bytes before signing. */
export async function verifyStagedControlArchive({ archivePath, manifest, expectedArchiveDigest, run = command }) {
  validateControlPackage(manifest);
  invariant(DIGEST.test(expectedArchiveDigest), 'CONTROL_STAGED_INPUT_DIGEST_REQUIRED');
  const stat = await fs.lstat(archivePath), before = await fileDigest(archivePath);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o022) === 0 &&
    before.digest === expectedArchiveDigest, 'CONTROL_STAGED_ARCHIVE_CHANGED');
  const script = `import sys,tarfile,hashlib,json
with tarfile.open(sys.argv[1], 'r:gz') as archive:
 members=archive.getmembers()
 if len(members)>100000: raise ValueError('too many entries')
 rows=[]
 for m in members:
  row={'name':m.name,'mode':m.mode,'type':'file' if m.isfile() else 'dir' if m.isdir() else 'symlink' if m.issym() else 'other'}
  if m.issym(): row['link']=m.linkname
  if m.isfile():
   h=hashlib.sha256();n=0
   with archive.extractfile(m) as f:
    while True:
     b=f.read(1048576)
     if not b: break
     n+=len(b);h.update(b)
   row.update(digest='sha256:'+h.hexdigest(),bytes=n)
  rows.append(row)
 print(json.dumps(rows))`;
  const rows = JSON.parse(await run('python3', ['-c', script, archivePath], { env: { PATH: process.env.PATH || '/usr/bin:/bin' } })), named = new Map();
  const safe = name => typeof name === 'string' && !posix.isAbsolute(name) && !/[\\\r\n\0]/.test(name) &&
    !name.split('/').includes('..') && !/^[A-Za-z]:/.test(name);
  for (const row of rows) {
    invariant(safe(row.name) && Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777 &&
      ['file', 'dir', 'symlink'].includes(row.type), 'CONTROL_ARCHIVE_UNSAFE');
    const name = posix.normalize(row.name).replace(/^\.\//, '').replace(/\/+$/, '') || '.';
    invariant(name !== '.' || row.type === 'dir', 'CONTROL_ARCHIVE_UNSAFE');
    invariant(!named.has(name), 'CONTROL_ARCHIVE_UNSAFE');named.set(name, { ...row, name });
  }
  for (const entry of named.values()) {
    const parent = posix.dirname(entry.name);
    invariant(parent === '.' || named.get(parent)?.type === 'dir', 'CONTROL_ARCHIVE_UNSAFE');
  }
  function resolveLink(path, chain = new Set()) {
    invariant(safe(path), 'CONTROL_ARCHIVE_UNSAFE');const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), entry = named.get(prefix);
      if (entry?.type !== 'symlink') continue;
      invariant(!chain.has(prefix) && typeof entry.link === 'string' && !posix.isAbsolute(entry.link) &&
        !/[\\\r\n\0]/.test(entry.link), 'CONTROL_ARCHIVE_UNSAFE');
      return resolveLink(posix.normalize(posix.join(posix.dirname(prefix), entry.link, ...parts.slice(i))), new Set([...chain, prefix]));
    }
    invariant(named.has(path), 'CONTROL_ARCHIVE_UNSAFE');return path;
  }
  for (const entry of named.values()) if (entry.type === 'symlink') resolveLink(entry.name);
  // Match treeManifest's directory traversal order, including a directory whose
  // name sorts before a sibling such as "module.js"; flat path sorting differs.
  const files = [];
  function visit(folder) {
    for (const entry of [...named.values()].filter(r => r.name !== '.' && posix.dirname(r.name) === (folder || '.')).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.type === 'dir') visit(entry.name);
      else files.push(entry.type === 'symlink' ? { path: entry.name, mode: entry.mode, link: entry.link } :
        { path: entry.name, mode: entry.mode, digest: entry.digest, bytes: entry.bytes });
    }
  }
  visit('');
  invariant(files.length > 0 && digest(files) === manifest.treeDigest &&
    digest(files.filter(file => file.path.startsWith('installer/'))) === manifest.executionEngineDigest,
    'CONTROL_STAGED_TREE_CHANGED');
  const after = await fileDigest(archivePath);invariant(canonical(before) === canonical(after), 'CONTROL_STAGED_ARCHIVE_CHANGED');
  return { files, archive: before };
}

export async function unpackStagedControlPackage({ archivePath, manifest, expectedArchiveDigest, artifactRoot, run = command }) {
  const proof = await verifyStagedControlArchive({ archivePath, manifest, expectedArchiveDigest, run });
  artifactRoot = resolve(artifactRoot);
  invariant(!(await fs.lstat(artifactRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; })), 'IMMUTABLE_CONTROL_ARTIFACT_EXISTS');
  await secureDirectory(artifactRoot);
  const space = await fs.statfs(artifactRoot);
  invariant(space.bavail * space.bsize > proof.files.reduce((n, file) => n + (file.bytes || 0), 0), 'INSUFFICIENT_UNPACK_CAPACITY');
  await run('tar', ['-xzpf', archivePath, '-C', artifactRoot, '--no-same-owner']);
  invariant(canonical(await treeManifest(artifactRoot)) === canonical(proof.files), 'CONTROL_STAGED_TREE_CHANGED');
  return { artifactRoot, manifestDigest: digest(manifest), executionEngineDigest: manifest.executionEngineDigest };
}

/** Sign exactly the independently staged descriptor/archive selected by the
 * caller. All public bytes are rechecked before any private-key access. */
export async function signStagedControlPackage({ stageReceiptPath, expectedManifestDigest, expectedArchiveDigest,
  keyId, privateKeyPath, unsignedManifestPath, archivePath, outputRoot, run = command }) {
  invariant(DIGEST.test(expectedManifestDigest) && DIGEST.test(expectedArchiveDigest), 'CONTROL_STAGED_INPUT_DIGEST_REQUIRED');
  invariant(typeof keyId === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(keyId), 'CONTROL_BUILD_SIGNING_KEY_ID_INVALID');
  stageReceiptPath = resolve(stageReceiptPath);
  const staged = await readStagedFile(stageReceiptPath, 262144), output = await secureDirectory(outputRoot ?? dirname(stageReceiptPath));
  invariant(stageReceiptPath.endsWith('/control-package.staged.json') && staged.schemaVersion === 1 &&
    staged.kind === 'control-package-unsigned-stage' && staged.signed === false && staged.privateKeyAccessed === false &&
    isAbsolute(staged.outputRoot) && staged.artifactRoot === join(staged.outputRoot, 'artifact') &&
    staged.unsignedManifestPath === join(staged.outputRoot, 'control-package.unsigned.json'), 'CONTROL_STAGED_RECEIPT_INVALID');
  const relocated = unsignedManifestPath !== undefined || archivePath !== undefined;
  invariant(!relocated || typeof unsignedManifestPath === 'string' && typeof archivePath === 'string', 'CONTROL_STAGED_RELOCATION_INCOMPLETE');
  const manifest = validateControlPackage(await readStagedFile(unsignedManifestPath ?? staged.unsignedManifestPath, 16384));
  invariant(digest(manifest) === expectedManifestDigest && staged.manifestDigest === expectedManifestDigest &&
    manifest.apiRevision === staged.apiRevision && manifest.projectRevision === staged.projectRevision &&
    manifest.treeDigest === staged.treeDigest && manifest.executionEngineDigest === staged.executionEngineDigest,
    'CONTROL_STAGED_DESCRIPTOR_CHANGED');
  if (!relocated) invariant(digest(await treeManifest(staged.artifactRoot)) === manifest.treeDigest, 'CONTROL_STAGED_TREE_CHANGED');
  invariant(['linux', 'darwin'].includes(staged.platform) && ['arm64', 'x64'].includes(staged.arch) &&
    staged.archive?.path === join(staged.outputRoot, `agent-upgrade-control-${manifest.version}-${staged.platform}-${staged.arch}.tgz`) &&
    staged.archive.digest === expectedArchiveDigest, 'CONTROL_STAGED_ARCHIVE_CHANGED');
  const proof = await verifyStagedControlArchive({ archivePath: archivePath ?? staged.archive.path, manifest, expectedArchiveDigest, run }), archive = proof.archive;
  invariant(archive.digest === expectedArchiveDigest && archive.bytes === staged.archive.bytes, 'CONTROL_STAGED_ARCHIVE_CHANGED');
  const manifestPath = join(output, 'control-package.signed.json'), receiptPath = join(output, 'control-package.build.json');
  invariant(!(await fs.lstat(manifestPath).catch(() => null)) && !(await fs.lstat(receiptPath).catch(() => null)), 'IMMUTABLE_CONTROL_DESCRIPTOR_EXISTS');
  invariant(!inside(staged.artifactRoot, resolve(privateKeyPath)), 'CONTROL_BUILD_OUTPUT_OVERLAP');
  const keyStat = await fs.lstat(privateKeyPath);
  invariant(keyStat.isFile() && !keyStat.isSymbolicLink() && (keyStat.mode & 0o077) === 0 && keyStat.size <= 16384, 'INSECURE_RELEASE_SIGNING_KEY');
  const key = createPrivateKey(await fs.readFile(privateKeyPath, 'utf8'));
  invariant(key.asymmetricKeyType === 'ed25519', 'INVALID_SIGNING_KEY');
  const envelope = { manifest, manifestDigest: expectedManifestDigest, signature: { algorithm: 'Ed25519', keyId,
    value: sign(null, Buffer.from(canonical(manifest)), key).toString('base64') } };
  await exclusiveJson(manifestPath, envelope);
  const { outputRoot: stagedOutput, unsignedManifestPath: stagedManifest, signed, privateKeyAccessed, ...original } = staged;
  const receipt = { ...original, kind: 'control-package-build', manifestPath, archive: { ...archive, path: archivePath ?? staged.archive.path } };
  await exclusiveJson(receiptPath, receipt);
  return { ...receipt, receiptPath };
}

/** Backward-compatible build+sign entry; callers needing qualification before
 * signing use stageControlPackage then signStagedControlPackage explicitly. */
export async function buildControlPackage(input) {
  invariant(typeof input.keyId === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(input.keyId), 'CONTROL_BUILD_SIGNING_KEY_ID_INVALID');
  const staged = await stageControlPackage(input);
  return signStagedControlPackage({ stageReceiptPath: staged.receiptPath, expectedManifestDigest: staged.manifestDigest,
    expectedArchiveDigest: staged.archive.digest, keyId: input.keyId, privateKeyPath: input.privateKeyPath });
}
