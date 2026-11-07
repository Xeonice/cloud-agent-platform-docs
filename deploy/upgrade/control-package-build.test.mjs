import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { command } from './artifacts.mjs';
import { treeManifest, atomicJson, fileDigest } from './io.mjs';
import { digest } from './trust.mjs';
import { verifyInstalledControlPackage } from './control-package.mjs';
import { stageControlApiClosure, probeControlImportClosure, buildControlPackage, stageControlPackage, signStagedControlPackage, verifyStagedControlArchive } from './control-package-build.mjs';

async function commit(root) {
  await command('git', ['init', '-q'], { cwd: root });
  await command('git', ['add', '.'], { cwd: root });
  await command('git', ['-c', 'user.name=Control Package Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Freeze isolated package fixture'], { cwd: root });
  return (await command('git', ['rev-parse', 'HEAD'], { cwd: root })).trim();
}

test('builds an independently signed control artifact from actual compiled imports and native SQLite, preserving the frozen engine', { timeout: 60000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'control-package-real-closure-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // These are real current compiled API bytes and a real native SQLite memory
  // constructor. The installer below is a harmless isolated packaging fixture;
  // this test does not qualify a live control installation or Guest continuity.
  const staged = await stageControlApiClosure({ apiRoot: resolve('api'), targetRoot: join(root, 'frozen-api') });
  assert.equal(staged.actual.initializesSdk, false);
  assert.equal(staged.actual.startsListeners, false);
  assert(staged.actual.files.some(file => file.path.endsWith('/better_sqlite3.node')));
  assert(!staged.actual.files.some(file => /packages\/modules\/sandbox\/|node_modules\/@boxlite|boxlite-runtime|app\.module|platform\.module/.test(file.path)));
  const project = join(root, 'frozen-project'), installer = join(project, 'deploy/upgrade');
  await fs.mkdir(installer, { recursive: true });
  await fs.writeFile(join(installer, 'control-main.mjs'), "export const fixture='isolated-control-main';\n");
  await fs.writeFile(join(installer, 'controller-main.mjs'), "export const fixture='isolated-execution-engine';\n");
  const apiRevision = await commit(staged.apiRoot), projectRevision = await commit(project);
  const executionEngineDigest = digest((await treeManifest(installer)).map(file => ({ ...file, path: 'installer/' + file.path })));
  const keys = generateKeyPairSync('ed25519'), privateKeyPath = join(root, 'fixture-private.pem');
  await fs.writeFile(privateKeyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const trustRootPath = join(root, 'fixture-trust.json');
  await atomicJson(trustRootPath, { schemaVersion: 1, keys: [{ id: 'isolated-fixture', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] });
  const input = { apiRoot: staged.apiRoot, apiSourceRoot: staged.apiRoot, installerRoot: installer, projectSourceRoot: project,
    apiRevision, projectRevision, version: 'v0.0.1-control.fixture', expectedApiClosureDigest: staged.actual.closureDigest,
    expectedInstallerDigest: executionEngineDigest, keyId: 'isolated-fixture', privateKeyPath };
  // Independent staging cannot access a missing key. The public bytes and real
  // native import probes are complete before the signer is ever called.
  const unsigned = await stageControlPackage({ ...input, privateKeyPath: join(root, 'must-not-be-read.pem'), outputRoot: join(root, 'unsigned') });
  assert.equal(unsigned.kind, 'control-package-unsigned-stage');
  assert.equal(unsigned.signed, false); assert.equal(unsigned.privateKeyAccessed, false);
  assert.equal(await fs.lstat(join(root, 'unsigned/control-package.signed.json')).catch(() => null), null);
  const signInput = { stageReceiptPath: unsigned.receiptPath, expectedManifestDigest: unsigned.manifestDigest,
    expectedArchiveDigest: unsigned.archive.digest, keyId: 'isolated-fixture', privateKeyPath };
  const stagedEntry = join(unsigned.artifactRoot, 'installer/control-main.mjs'), stagedBytes = await fs.readFile(stagedEntry);
  await fs.appendFile(stagedEntry, '// corrupt staged payload\n');
  await assert.rejects(signStagedControlPackage({ ...signInput, privateKeyPath: join(root, 'must-not-be-read.pem') }), /CONTROL_STAGED_TREE_CHANGED/);
  await fs.writeFile(stagedEntry, stagedBytes);
  await assert.rejects(signStagedControlPackage({ ...signInput, expectedManifestDigest: 'sha256:' + 'f'.repeat(64),
    privateKeyPath: join(root, 'must-not-be-read.pem') }), /CONTROL_STAGED_DESCRIPTOR_CHANGED/);
  const originalArchive = await fs.readFile(unsigned.archive.path);
  await fs.appendFile(unsigned.archive.path, 'corrupt archive');
  await assert.rejects(signStagedControlPackage({ ...signInput, privateKeyPath: join(root, 'must-not-be-read.pem') }), /CONTROL_STAGED_ARCHIVE_CHANGED/);
  await fs.writeFile(unsigned.archive.path, originalArchive);
  const independentlySigned = await signStagedControlPackage(signInput);
  const independentVerified = await verifyInstalledControlPackage({ artifactRoot: independentlySigned.artifactRoot,
    manifestPath: independentlySigned.manifestPath, trustRootPath, engineIdentity: { artifactDigest: executionEngineDigest } });
  assert.equal(independentVerified.packageDigest, unsigned.manifestDigest);
  assert.equal((await fileDigest(unsigned.archive.path)).digest, unsigned.archive.digest);
  const publisher = join(root, 'publisher');await fs.mkdir(publisher, { mode: 0o700 });
  const publisherArchive = join(publisher, unsigned.archive.path.split('/').at(-1)), publisherDescriptor = join(publisher, 'control-package.unsigned.json'),
    publisherReceipt = join(publisher, 'control-package.staged.json');
  await fs.copyFile(unsigned.archive.path, publisherArchive);await fs.copyFile(unsigned.unsignedManifestPath, publisherDescriptor);
  await fs.copyFile(unsigned.receiptPath, publisherReceipt);
  const portable = await signStagedControlPackage({ ...signInput, stageReceiptPath: publisherReceipt,
    unsignedManifestPath: publisherDescriptor, archivePath: publisherArchive, outputRoot: publisher });
  assert.equal((await verifyInstalledControlPackage({ artifactRoot: unsigned.artifactRoot, manifestPath: portable.manifestPath,
    trustRootPath, engineIdentity: { artifactDigest: executionEngineDigest } })).packageDigest, unsigned.manifestDigest);
  await assert.rejects(signStagedControlPackage({ ...signInput, privateKeyPath: join(root, 'must-not-be-read.pem') }), /IMMUTABLE_CONTROL_DESCRIPTOR_EXISTS/);
  const result = await buildControlPackage({ ...input, outputRoot: join(root, 'output') });
  assert.equal(result.apiRevision, apiRevision); assert.equal(result.projectRevision, projectRevision);
  assert.equal(result.executionEngineDigest, executionEngineDigest);
  assert.equal(result.entries.length, 6); assert(result.entries.every(entry => entry.digest && entry.bytes > 0));
  assert(!result.manifestPath.startsWith(result.artifactRoot + '/'));
  assert.deepEqual(result.importClosure, { startsListeners: false, opensBusinessDatabase: false, initializesSdk: false });
  assert.equal(result.entryImport.entry, 'installer/control-main.mjs');
  const verified = await verifyInstalledControlPackage({ artifactRoot: result.artifactRoot, manifestPath: result.manifestPath,
    trustRootPath, engineIdentity: { artifactDigest: executionEngineDigest } });
  assert.equal(verified.packageDigest, result.manifestDigest);
  assert.equal(verified.executionEngineDigest, executionEngineDigest);
  assert.equal((await fileDigest(result.archive.path)).digest, result.archive.digest);
  const extracted = join(root, 'extracted'); await fs.mkdir(extracted);
  await command('tar', ['-xzpf', result.archive.path, '-C', extracted, '--no-same-owner']);
  const archiveVerified = await verifyInstalledControlPackage({ artifactRoot: extracted, manifestPath: result.manifestPath,
    trustRootPath, engineIdentity: { artifactDigest: executionEngineDigest } });
  assert.equal(archiveVerified.treeDigest, result.treeDigest);
  await assert.rejects(buildControlPackage({ ...input, outputRoot: join(root, 'output') }), /IMMUTABLE_CONTROL_ARTIFACT_EXISTS/);
  await assert.rejects(buildControlPackage({ ...input, outputRoot: join(root, 'wrong-engine'), expectedInstallerDigest: 'sha256:' + 'f'.repeat(64) }), /CONTROL_EXECUTION_ENGINE_INPUT_CHANGED/);
  await assert.rejects(buildControlPackage({ ...input, outputRoot: join(root, 'wrong-api'), apiRevision: 'a'.repeat(40) }), /CONTROL_SOURCE_REVISION_CHANGED/);
  await assert.rejects(buildControlPackage({ ...input, outputRoot: join(root, 'wrong-bytes'), expectedApiClosureDigest: 'sha256:' + 'f'.repeat(64) }), /CONTROL_API_BUILD_INPUT_CHANGED/);
  await assert.rejects(verifyInstalledControlPackage({ artifactRoot: result.artifactRoot, manifestPath: result.manifestPath,
    trustRootPath, engineIdentity: { artifactDigest: 'sha256:' + 'f'.repeat(64) } }), /CONTROL_PACKAGE_ACTUAL_CODE_CHANGED/);
  const internalDescriptor = join(result.artifactRoot, 'descriptor.json');
  await fs.copyFile(result.manifestPath, internalDescriptor);
  await assert.rejects(verifyInstalledControlPackage({ artifactRoot: result.artifactRoot, manifestPath: internalDescriptor,
    trustRootPath, engineIdentity: { artifactDigest: executionEngineDigest } }), /CONTROL_PACKAGE_DESCRIPTOR_MUST_BE_EXTERNAL/);
  await fs.unlink(internalDescriptor);
  await fs.writeFile(join(project, 'unfrozen.mjs'), 'export default true');
  await assert.rejects(buildControlPackage({ ...input, outputRoot: join(root, 'dirty-source') }), /CONTROL_SOURCE_NOT_FROZEN/);
  await fs.appendFile(join(result.artifactRoot, 'installer/control-main.mjs'), '// modified\n');
  await assert.rejects(verifyInstalledControlPackage({ artifactRoot: result.artifactRoot, manifestPath: result.manifestPath,
    trustRootPath, engineIdentity: { artifactDigest: executionEngineDigest } }), /CONTROL_PACKAGE_ACTUAL_CODE_CHANGED/);
  const factory = join(staged.apiRoot, 'apps/api/dist/platform/upgrade/control-store-factory.js'), originalFactory = await fs.readFile(factory);
  const forbiddenDb = join(root, 'forbidden-business.db');
  await fs.appendFile(factory, '\nrequire("better-sqlite3")(' + JSON.stringify(forbiddenDb) + ');\n');
  await assert.rejects(probeControlImportClosure(staged.apiRoot), /Artifact command failed/);
  assert.equal(await fs.stat(forbiddenDb).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null);
  await fs.writeFile(factory, originalFactory);
  await fs.appendFile(factory, "\nrequire('node:net').createServer().listen(0,'127.0.0.1');\n");
  await assert.rejects(probeControlImportClosure(staged.apiRoot), /Artifact command failed/);
});

test('archive signing rejects an unmanifested orphan path and symlink traversal before extraction', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'control-package-archive-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = { schemaVersion: 1, kind: 'upgrade-control', version: 'v0.0.1-fixture', protocolVersion: 1,
    apiRevision: 'a'.repeat(40), projectRevision: 'b'.repeat(40), treeDigest: digest([]), executionEngineDigest: digest([]) };
  for (const kind of ['orphan', 'escape']) {
    const archivePath = join(root, kind + '.tgz');
    await command('python3', ['-c', `import io,tarfile,sys
with tarfile.open(sys.argv[1],'w:gz') as t:
 m=tarfile.TarInfo('missing-parent/file' if sys.argv[2]=='orphan' else 'link');m.mode=0o600
 if sys.argv[2]=='orphan': m.size=1;t.addfile(m,io.BytesIO(b'x'))
 else: m.type=tarfile.SYMTYPE;m.linkname='../outside';t.addfile(m)`, archivePath, kind]);
    await assert.rejects(verifyStagedControlArchive({ archivePath, manifest,
      expectedArchiveDigest: (await fileDigest(archivePath)).digest }), /CONTROL_ARCHIVE_UNSAFE/);
  }
});
