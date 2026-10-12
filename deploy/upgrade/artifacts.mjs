import * as fs from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
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
  // Preflight every header. No absolute/traversal paths, devices or hardlinks; relative symlinks are checked again after extraction.
  const names = (await command('tar', ['-tzf', archive])).split('\n').filter(Boolean);
  invariant(names.length && names.every(n => !n.startsWith('/') && !n.includes('\\') && !n.split('/').some(x => x === '..') && !/^[A-Za-z]:/.test(n)), 'UNSAFE_ARCHIVE_PATH');
  const types = (await command('tar', ['-tvzf', archive])).split('\n').filter(Boolean);
  invariant(types.every(n => /^[-d]/.test(n)), 'UNSAFE_ARCHIVE_TYPE');
  const temp = target + '.unpack'; await fs.rm(temp, { recursive: true, force: true }); await secureDirectory(temp);
  try {
    await command('tar', ['-xzf', archive, '-C', temp, '--no-same-owner']);
    const bundle = await readJson(join(temp, 'upgrade-artifact.json')); invariant(bundle.schemaVersion === 1 && bundle.platform === pkg.platform && bundle.arch === pkg.arch && canonical(bundle.components) === canonical(expectedComponents), 'ARTIFACT_METADATA_MISMATCH');
    const files = await treeManifest(temp); const payload = files.filter(f => !['upgrade-artifact.json','installed.json'].includes(f.path));
    invariant(digest(payload) === bundle.treeDigest && canonical(payload) === canonical(bundle.files), 'ARTIFACT_TREE_MISMATCH');
    const apiFiles=payload.filter(f=>f.path.startsWith('api/')),webFiles=payload.filter(f=>f.path.startsWith('web/'));invariant(digest(apiFiles)===expectedComponents.api.artifactDigest&&digest(webFiles)===expectedComponents.web.artifactDigest&&digest(apiFiles)===expectedComponents.coordinator.artifactDigest&&(!expectedComponents.owner||digest(apiFiles)===expectedComponents.owner.artifactDigest)&&digest(payload.filter(f=>f.path.startsWith('installer/')))===expectedComponents.installer.artifactDigest,'COMPONENT_CONTENT_DIGEST_MISMATCH');
    if(pkg.unpackedBytes!==undefined)invariant(payload.reduce((n,f)=>n+(f.bytes||0),0)===pkg.unpackedBytes,'UNPACKED_BYTES_MISMATCH');
    const record = { packageDigest: pkg.digest, treeDigest: bundle.treeDigest, components: bundle.components, installedAt: new Date().toISOString() }; await atomicJson(join(temp, 'installed.json'), record); await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 }); await fs.rename(temp, target);
    return { root: target, ...record };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
