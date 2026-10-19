import * as fs from 'node:fs/promises';
import { join, dirname, resolve, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { invariant, canonical, digest } from './trust.mjs';
import { fileDigest, atomicJson, readJson, treeManifest, secureDirectory } from './io.mjs';
export async function command(program, args, options = {}) {
  return new Promise((accept, reject) => { const child = spawn(program, args, { ...options, stdio: ['ignore','pipe','pipe'], shell: false }); let out = ''; let overflow = false;
    child.stdout.on('data', c => { out += c; if (out.length > 8_000_000) { overflow = true; child.kill(); } }); child.stderr.resume();
    child.once('error', reject); child.once('close', code => code === 0 && !overflow ? accept(out) : reject(Object.assign(new Error('Artifact command failed'), { code: 'ARTIFACT_COMMAND_FAILED' })));
  });
}
export async function downloadVerified(pkg, root, { fetcher = fetch, assertFence, onProgress, signal, allowedRedirectOrigins = [] } = {}) {
  invariant(typeof assertFence === 'function', 'FENCE_CHECK_REQUIRED'); await assertFence();
  const cache = await secureDirectory(join(root, 'downloads')), final = join(cache, pkg.digest.slice(7) + '.tgz'), partial = final + '.partial', receiptPath = final + '.progress.json';
  const prior = await fs.lstat(final).catch(() => null);
  if (prior) { const actual = await fileDigest(final); invariant(actual.digest === pkg.digest && actual.bytes === pkg.bytes, 'CACHED_PACKAGE_CORRUPT'); return { path: final, ...actual }; }
  let offset = (await fs.lstat(partial).catch(() => null))?.size || 0; invariant(offset <= pkg.bytes, 'PARTIAL_PACKAGE_OVERFLOW');
  const checkpoint = await readJson(receiptPath, { digest: pkg.digest, completed: 0 }); invariant(checkpoint.digest === pkg.digest && offset >= checkpoint.completed, 'DOWNLOAD_CHECKPOINT_REGRESSION');
  let url = pkg.url, response;
  for(let redirects=0;redirects<6;redirects++) { response = await fetcher(url, { headers: offset ? { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity' }, redirect: 'manual', signal });
    if (![301,302,303,307,308].includes(response.status)) break;
    const next = new URL(response.headers.get('location'),url); invariant(next.protocol==='https:' && allowedRedirectOrigins.includes(next.origin), 'UNTRUSTED_DOWNLOAD_REDIRECT'); url=next.href;
    invariant(redirects<5,'TOO_MANY_DOWNLOAD_REDIRECTS');
  }
  if (offset && response.status === 200) { await fs.truncate(partial, 0); offset = 0; } // Remote does not support ranges: restart bytes, retain committed work projection until verified catch-up.
  invariant(response.status === 200 || response.status === 206, 'PACKAGE_DOWNLOAD_FAILED');
  if (response.status === 206) invariant(response.headers.get('content-range')?.startsWith(`bytes ${offset}-`) && response.headers.get('content-range')?.endsWith('/' + pkg.bytes), 'INVALID_CONTENT_RANGE');
  invariant(response.body, 'EMPTY_DOWNLOAD_BODY'); const h = await fs.open(partial, offset ? 'a' : 'w', 0o600); let done = offset, last = checkpoint.completed;
  try { for await (const chunk of response.body) { await assertFence(); invariant(done + chunk.length <= pkg.bytes, 'PACKAGE_SIZE_OVERFLOW'); await h.write(chunk); done += chunk.length;
      if (done >= last && (done - last >= 1024 * 1024 || done === pkg.bytes)) { await h.sync(); await atomicJson(receiptPath, { digest: pkg.digest, completed: done }); await onProgress?.(done, pkg.bytes, { bytesDigest: pkg.digest, durableFile: partial }); last = done; }
    } await h.sync(); } finally { await h.close(); }
  await assertFence(); const actual = await fileDigest(partial); invariant(actual.digest === pkg.digest && actual.bytes === pkg.bytes, 'PACKAGE_DIGEST_OR_SIZE_INVALID');
  await fs.rename(partial, final); await atomicJson(receiptPath, { digest: pkg.digest, completed: pkg.bytes, verified: true }); return { path: final, ...actual };
}
export async function unpackVerified(archive, pkg, root, expectedComponents) {
  const actual = await fileDigest(archive); invariant(actual.digest === pkg.digest && actual.bytes === pkg.bytes, 'PACKAGE_DIGEST_OR_SIZE_INVALID');
  const target = join(root, 'artifacts', pkg.digest.slice(7)), existing = await readJson(join(target, 'installed.json'), null);
  if (existing) { invariant(existing.packageDigest === pkg.digest, 'ARTIFACT_IDENTITY_CHANGED'); return { root: target, ...existing }; }
  const capacity=await fs.statfs(root);if(pkg.unpackedBytes!==undefined)invariant(capacity.bavail*capacity.bsize>pkg.unpackedBytes,'INSUFFICIENT_UNPACK_CAPACITY');
  // Read actual headers rather than parsing human-readable tar output. pnpm's
  // contained links preserve shared DI module identity; only those links are
  // allowed. Validate every chain before extraction can follow any link.
  const script="import tarfile,json,sys\nwith tarfile.open(sys.argv[1], 'r:gz') as archive:\n members=archive.getmembers()\n if len(members)>100000: raise ValueError('too many entries')\n print(json.dumps([{'name':m.name,'mode':m.mode,'type':'file' if m.isfile() else 'dir' if m.isdir() else 'symlink' if m.issym() else 'other','target':m.linkname} for m in members]))";
  const entries=JSON.parse(await command('python3',['-c',script,archive])),named=new Map();
  const safe=n=>typeof n==='string'&&!n.startsWith('/')&&!/[\\\r\n\0]/.test(n)&&!n.split('/').some(x=>x==='..')&&!/^[A-Za-z]:/.test(n);
  invariant(entries.length>0,'UNSAFE_ARCHIVE_PATH');
  for(const entry of entries){invariant(safe(entry.name),'UNSAFE_ARCHIVE_PATH');invariant(Number.isInteger(entry.mode)&&entry.mode>=0&&entry.mode<=0o777,'UNSAFE_ARCHIVE_MODE');const name=posix.normalize(entry.name).replace(/^\.\//,'').replace(/\/+$/,'');invariant(!named.has(name),'DUPLICATE_ARCHIVE_ENTRY');invariant(['file','dir','symlink'].includes(entry.type),'UNSAFE_ARCHIVE_TYPE');if(entry.type==='symlink')invariant(typeof entry.target==='string'&&!posix.isAbsolute(entry.target)&&!/[\\\r\n\0]/.test(entry.target)&&!/^[A-Za-z]:/.test(entry.target),'UNSAFE_ARCHIVE_TYPE');named.set(name,{...entry,name});}
  function resolveLink(path,chain=new Set()){invariant(safe(path),'UNSAFE_ARCHIVE_TYPE');const parts=path.split('/');for(let i=1;i<=parts.length;i++){const prefix=parts.slice(0,i).join('/'),entry=named.get(prefix);if(entry?.type!=='symlink')continue;invariant(!chain.has(prefix),'UNSAFE_ARCHIVE_TYPE');const next=new Set(chain);next.add(prefix);return resolveLink(posix.normalize(posix.join(posix.dirname(prefix),entry.target,...parts.slice(i))),next);}invariant(named.has(path),'DANGLING_ARCHIVE_LINK');return path;}
  for(const [name,entry] of named)if(entry.type==='symlink'){const target=posix.normalize(posix.join(posix.dirname(name),entry.target));resolveLink(target,new Set([name]));}
  const temp = target + '.unpack'; await fs.rm(temp, { recursive: true, force: true }); await secureDirectory(temp);
  try {
    // Signed file modes must survive a private operator umask. Header checks
    // above reject all special permission bits before preserving permissions.
    await command('tar', ['-xzpf', archive, '-C', temp, '--no-same-owner']);
    const bundle = await readJson(join(temp, 'upgrade-artifact.json')); invariant(bundle.schemaVersion === 1 && bundle.platform === pkg.platform && bundle.arch === pkg.arch && canonical(bundle.components) === canonical(expectedComponents), 'ARTIFACT_METADATA_MISMATCH');
    const files = await treeManifest(temp); const payload = files.filter(f => !['upgrade-artifact.json','installed.json'].includes(f.path));
    invariant(digest(payload) === bundle.treeDigest && canonical(payload) === canonical(bundle.files), 'ARTIFACT_TREE_MISMATCH');
    const apiFiles=payload.filter(f=>f.path.startsWith('api/')),webFiles=payload.filter(f=>f.path.startsWith('web/'));invariant(digest(apiFiles)===expectedComponents.api.artifactDigest&&digest(webFiles)===expectedComponents.web.artifactDigest&&digest(apiFiles)===expectedComponents.coordinator.artifactDigest&&(!expectedComponents.owner||digest(apiFiles)===expectedComponents.owner.artifactDigest)&&digest(payload.filter(f=>f.path.startsWith('installer/')))===expectedComponents.installer.artifactDigest,'COMPONENT_CONTENT_DIGEST_MISMATCH');
    if(pkg.unpackedBytes!==undefined)invariant(payload.reduce((n,f)=>n+(f.bytes||0),0)===pkg.unpackedBytes,'UNPACKED_BYTES_MISMATCH');
    const record = { packageDigest: pkg.digest, treeDigest: bundle.treeDigest, components: bundle.components, installedAt: new Date().toISOString() }; await atomicJson(join(temp, 'installed.json'), record); await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 }); await fs.rename(temp, target);
    return { root: target, ...record };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
