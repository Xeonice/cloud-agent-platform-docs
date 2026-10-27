import * as fs from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { invariant, canonical } from './trust.mjs';
export async function atomicJson(path, value) {
  const parent = dirname(path); await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const tmp = join(parent, '.' + randomUUID()); const h = await fs.open(tmp, 'wx', 0o600);
  try { await h.writeFile(canonical(value) + '\n'); await h.sync(); } finally { await h.close(); }
  await fs.rename(tmp, path); const dir = await fs.open(parent, 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
export async function readJson(path, fallback) { try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; } }
export async function fileDigest(path) { const hash = createHash('sha256'); let bytes = 0; for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); } return { digest: 'sha256:' + hash.digest('hex'), bytes }; }
export function inside(root, path) { const r = relative(resolve(root), resolve(path)); return !isAbsolute(r) && r !== '..' && !r.startsWith('../'); }
export async function secureDirectory(root) { const path = resolve(root); await fs.mkdir(path, { recursive: true, mode: 0o700 }); const s = await fs.lstat(path); invariant(s.isDirectory() && !s.isSymbolicLink() && await fs.realpath(path) === path && (s.mode & 0o022) === 0, 'INSECURE_INSTANCE_DIRECTORY'); return path; }
export async function treeManifest(root) {
  const files = [];
  async function visit(folder) {
    for (const name of (await fs.readdir(folder)).sort()) {
      const path = join(folder, name), stat = await fs.lstat(path), rel = relative(root, path).split('\\').join('/');
      invariant(!/\.(?:pem|key|p12)$|(?:^|\/)\.env(?:\.|$)/.test(rel), 'PRIVATE_FILE_IN_PACKAGE');
      if (stat.isSymbolicLink()) { const link = await fs.readlink(path); invariant(!isAbsolute(link) && inside(root, resolve(dirname(path), link)) && inside(root, await fs.realpath(path)), 'PACKAGE_LINK_ESCAPE'); files.push({ path: rel, mode: stat.mode & 0o777, link }); }
      else if (stat.isDirectory()) await visit(path);
      else { invariant(stat.isFile(), 'SPECIAL_FILE_IN_PACKAGE'); files.push({ path: rel, mode: stat.mode & 0o777, ...(await fileDigest(path)) }); }
    }
  }
  await visit(root); return files;
}
