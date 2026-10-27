import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, unpackVerified } from './artifacts.mjs';
import { atomicJson, fileDigest, treeManifest } from './io.mjs';
import { digest } from './trust.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'artifact-permissions-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  for (const [path, mode] of [
    ['api/code.js', 0o644],
    ['api/cli', 0o755],
    ['web/server.js', 0o644],
    ['installer/controller-main.mjs', 0o755],
  ]) {
    await fs.mkdir(join(source, path.split('/')[0]), { recursive: true });
    await fs.writeFile(join(source, path), 'export const fixture = true;\n');
    await fs.chmod(join(source, path), mode);
  }
  await fs.symlink('cli', join(source, 'api/cli-link'));
  const files = await treeManifest(source);
  const apiDigest = digest(files.filter(file => file.path.startsWith('api/')));
  const components = {
    api: { artifactDigest: apiDigest },
    coordinator: { artifactDigest: apiDigest },
    owner: { artifactDigest: apiDigest },
    web: { artifactDigest: digest(files.filter(file => file.path.startsWith('web/'))) },
    installer: { artifactDigest: digest(files.filter(file => file.path.startsWith('installer/'))) },
  };
  await atomicJson(join(source, 'upgrade-artifact.json'), {
    schemaVersion: 1, platform: 'linux', arch: 'arm64',
    components, files, treeDigest: digest(files),
  });
  async function archive(name, override = null) {
    const path = join(root, name + '.tgz');
    await command('python3', ['-c', `
import gzip,json,sys,tarfile
override=json.loads(sys.argv[3])
with tarfile.open(sys.argv[2], 'w:gz', format=tarfile.USTAR_FORMAT) as archive:
 archive.add(sys.argv[1], arcname='.')
if override:
 with tarfile.open(sys.argv[2], 'r:gz') as archive:
  member=next(m for m in archive.getmembers() if m.name.removeprefix('./') == override['path'])
  offset=member.offset
 with gzip.open(sys.argv[2], 'rb') as archive:
  raw=bytearray(archive.read())
 # Patch actual tar bytes: TarInfo.tobuf masks non-permission bits itself.
 raw[offset+100:offset+108]=('%07o\\0' % override['mode']).encode('ascii')
 raw[offset+148:offset+156]=b'        '
 checksum=sum(raw[offset:offset+512])
 raw[offset+148:offset+156]=('%06o\\0 ' % checksum).encode('ascii')
 with gzip.open(sys.argv[2], 'wb') as archive:
  archive.write(raw)
`, source, path, JSON.stringify(override)]);
    return { path, pkg: { ...await fileDigest(path), platform: 'linux', arch: 'arm64',
      unpackedBytes: files.reduce((sum, file) => sum + (file.bytes || 0), 0) } };
  }
  return { root, source, files, components, archive };
}

for (const mask of [0o022, 0o077]) {
  test(`real verified extraction preserves signed file modes under umask ${mask.toString(8)}`, async t => {
    const f = await fixture(t), archive = await f.archive('safe');
    const installationRoot = join(f.root, 'installation');
    await fs.mkdir(installationRoot);
    // Isolate the process-global umask from concurrent tests. The child invokes
    // the actual production extractor, Python header parser and system tar.
    const result = JSON.parse(await command(process.execPath, ['--input-type=module', '-e', `
      import { unpackVerified } from ${JSON.stringify(new URL('./artifacts.mjs', import.meta.url).href)};
      import { treeManifest } from ${JSON.stringify(new URL('./io.mjs', import.meta.url).href)};
      process.umask(${mask});
      const input=JSON.parse(process.argv[1]);
      const installed=await unpackVerified(input.archive,input.pkg,input.root,input.components);
      const payload=(await treeManifest(installed.root)).filter(file=>!['upgrade-artifact.json','installed.json'].includes(file.path));
      process.stdout.write(JSON.stringify({packageDigest:installed.packageDigest,payload}));
    `, JSON.stringify({ archive: archive.path, pkg: archive.pkg, root: installationRoot, components: f.components })]));
    assert.equal(result.packageDigest, archive.pkg.digest);
    assert.deepEqual(result.payload, f.files);
    assert.equal(result.payload.find(file => file.path === 'api/cli').mode, 0o755);
    assert.equal(result.payload.find(file => file.path === 'api/code.js').mode, 0o644);
  });
}

for (const [label, path, mode] of [
  ['setuid file', 'api/cli', 0o4755],
  ['setgid file', 'api/cli', 0o2755],
  ['sticky file', 'api/cli', 0o1755],
  ['setuid directory', 'api', 0o4700],
  ['setgid directory', 'api', 0o2700],
  ['sticky directory', 'api', 0o1700],
  ['special symlink', 'api/cli-link', 0o4777],
  ['non-permission mode bits', 'api/cli', 0o10755],
]) {
  test(`rejects ${label} in real tar headers before extraction`, async t => {
    const f = await fixture(t), archive = await f.archive('unsafe', { path, mode });
    const installationRoot = join(f.root, 'installation');
    await fs.mkdir(installationRoot);
    // The outer package SHA is valid and signed payload permissions remain
    // ordinary. Masking the header mode would wrongly admit this archive.
    assert.deepEqual(await fileDigest(archive.path), { digest: archive.pkg.digest, bytes: archive.pkg.bytes });
    await assert.rejects(unpackVerified(archive.path, archive.pkg, installationRoot, f.components), { code: 'UNSAFE_ARCHIVE_MODE' });
    assert.deepEqual(await fs.readdir(installationRoot), []);
  });
}
