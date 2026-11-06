import { createPublicKey, verify } from 'node:crypto';
import { join, resolve } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { invariant, canonical, digest, DIGEST, loadTrustRoot } from './trust.mjs';
import { treeManifest, inside } from './io.mjs';

import { validateControlPackage } from './control-package-manifest.mjs';
export { validateControlPackage };
export function verifyControlPackageSignature(envelope, roots, now = Date.now()) {
  const manifest = validateControlPackage(envelope?.manifest);
  invariant(envelope.manifestDigest === digest(manifest) && envelope.signature?.algorithm === 'Ed25519' && typeof envelope.signature.value === 'string', 'CONTROL_PACKAGE_SIGNATURE_INVALID');
  const trusted = roots.keys?.find(k => k.id === envelope.signature.keyId && k.revoked !== true && (!k.notBefore || Date.parse(k.notBefore) <= now) && (!k.notAfter || Date.parse(k.notAfter) >= now));
  invariant(trusted, 'CONTROL_PACKAGE_KEY_UNTRUSTED');
  const key = createPublicKey(trusted.publicKey);
  invariant(key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonical(manifest)), key, Buffer.from(envelope.signature.value, 'base64')), 'CONTROL_PACKAGE_SIGNATURE_INVALID');
  return manifest;
}
/** Invoked only at explicit installation/startup, never in authority/renew RPCs. */
export async function verifyInstalledControlPackage({ artifactRoot, manifestPath, trustRootPath, engineIdentity, clock = Date.now }) {
  const roots = await loadTrustRoot(trustRootPath), stat = await lstat(manifestPath);
  invariant(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0 && stat.size <= 16384, 'CONTROL_PACKAGE_MANIFEST_INSECURE');
  const envelope = JSON.parse(await readFile(manifestPath, 'utf8')), manifest = verifyControlPackageSignature(envelope, roots, clock());
  // The external signed descriptor is not part of its own tree. No descriptor
  // may be silently excluded from a path inside the immutable code directory.
  invariant(!inside(resolve(artifactRoot), resolve(manifestPath)), 'CONTROL_PACKAGE_DESCRIPTOR_MUST_BE_EXTERNAL');
  const files = await treeManifest(artifactRoot);
  invariant(digest(files) === manifest.treeDigest && engineIdentity.artifactDigest === manifest.executionEngineDigest, 'CONTROL_PACKAGE_ACTUAL_CODE_CHANGED');
  invariant(files.some(f => f.path === 'installer/control-main.mjs') && files.some(f => f.path === 'api/apps/api/dist/platform/upgrade/control-store-factory.js'), 'CONTROL_PACKAGE_ENTRY_MISSING');
  return Object.freeze({ version: manifest.version, protocolVersion: manifest.protocolVersion, packageDigest: envelope.manifestDigest,
    treeDigest: manifest.treeDigest, executionEngineDigest: manifest.executionEngineDigest, apiRevision: manifest.apiRevision, projectRevision: manifest.projectRevision,
    artifactRoot: resolve(artifactRoot), apiRoot: join(resolve(artifactRoot), 'api'), verifiedAt: new Date(clock()).toISOString() });
}
