import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPackagedWebReuse, packagePinnedInstance } from '../jenkins/instance-package.mjs';
import { digest, freezePlan } from '../upgrade/trust.mjs';
const revision = 'a'.repeat(40), files = [{ path: 'web/server.js', mode: 0o644, digest: digest('original-web'), bytes: 1 }];
const component = { artifactDigest: digest(files), inputFingerprint: digest('original-signed-input'), sourceRevision: revision, protocol: { min: 1, max: 1 } };
const input = { purpose: 'qualification', policy: 'retain-installed', revision, fingerprint: digest('different-fresh-source-fingerprint'),
  previousManifest: { components: { web: component } }, previousFiles: files };

test('explicit retention preserves the exact signed Web identity and produces no Web switch in the real upgrade plan', () => {
  const before = JSON.stringify(input);assert.equal(selectPackagedWebReuse(input), true);assert.equal(JSON.stringify(input), before);
  const changed = { ...component, artifactDigest: digest('new-api'), inputFingerprint: digest('new-api-input') };
  const components = { api: changed, coordinator: changed, web: component, installer: changed };
  const plan = freezePlan({ manifest: { releaseId: 'v1.0.1', components, policy: { weights: [100], minRequests: 10 } },
    manifestDigest: digest('manifest'), package: { name: 'native.tgz', bytes: 1 }, path: { targetSchema: 29 } },
  { schema: 29, generation: 1, apiDigest: digest('old-api'), apiInputFingerprint: digest('old-api-input'),
    webDigest: component.artifactDigest, webInputFingerprint: component.inputFingerprint, installerDigest: digest('old-installer'),
    installerInputFingerprint: digest('old-installer-input') });
  assert.equal(plan.webReused, true);assert.equal(plan.steps.some(s => s.kind === 'web'), false);
  assert.equal(plan.steps.some(s => s.kind === 'candidate'), true);
});

test('retention rejects relabeled source revisions, altered original Web bytes and formal release selection', () => {
  for (const patch of [{ purpose: 'release' }, { revision: 'b'.repeat(40) },
    { previousFiles: [{ ...files[0], digest: digest('changed') }] }, { previousManifest: null }])
    assert.throws(() => selectPackagedWebReuse({ ...input, ...patch }), /SIGNED_ARTIFACT_REQUIRED/);
  assert.equal(selectPackagedWebReuse({ ...input, policy: 'matching-input' }), false);
});

test('formal or unbound retention is rejected before build or source-fetch effects', async () => {
  let calls = 0;
  for (const args of [{ purpose: 'release', previousBundle: {} }, { purpose: 'qualification' }])
    await assert.rejects(packagePinnedInstance({ ...args, webPolicy: 'retain-installed', run() { calls++; } }), /INVALID_PACKAGE_WEB_POLICY/);
  assert.equal(calls, 0);
});
