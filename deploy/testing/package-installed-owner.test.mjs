import test from 'node:test';
import assert from 'node:assert/strict';
import { packagedOwnerComponent, packagePinnedInstance } from '../jenkins/instance-package.mjs';
import { freezePlan, digest } from '../upgrade/trust.mjs';

const protocol = { min: 1, max: 1 };
const component = name => ({ artifactDigest: digest(name), inputFingerprint: digest(name + '-input'), protocol });
function plan(ownerPolicy) {
  const api = component('new-api'), components = { api, coordinator: api, web: component('web'), installer: component('installer') };
  const owner = packagedOwnerComponent(api, { api: protocol }, ownerPolicy);
  if (owner) components.owner = owner;
  const current = { schema: 29, generation: 8, apiDigest: digest('old-api'), apiInputFingerprint: digest('old-api-input'),
    webDigest: components.web.artifactDigest, webInputFingerprint: components.web.inputFingerprint,
    coordinatorDigest: digest('old-api'), coordinatorInputFingerprint: digest('old-api-input'),
    ownerDigest: digest('original-owner'), ownerInputFingerprint: digest('original-owner-input'),
    installerDigest: components.installer.artifactDigest, installerInputFingerprint: components.installer.inputFingerprint };
  return { components, result: freezePlan({ manifest: { releaseId: 'v1.0.1', components,
    policy: { weights: [100], minRequests: 10 } }, manifestDigest: digest('manifest'),
  package: { name: 'native.tgz', bytes: 1 }, path: { targetSchema: 29 } }, current), current };
}

test('explicit installed Owner policy changes the real signed-plan role selection while API and Coordinator still update', () => {
  const { components, result, current } = plan('reuse-installed');
  assert.equal(Object.hasOwn(components, 'owner'), false);
  assert.equal(result.ownerReused, true);assert.equal(result.sourceOwnerDigest, current.ownerDigest);
  assert.equal(result.steps.some(s => s.kind === 'owner-candidate'), false);
  assert.equal(result.steps.some(s => s.kind === 'candidate'), true);
  assert.equal(result.steps.some(s => s.kind === 'coordinator-handoff'), true);
});

test('default packaging preserves the existing explicit Owner update behavior', () => {
  const { components, result } = plan(undefined);
  assert.deepEqual(components.owner, components.api);
  assert.equal(result.ownerReused, false);
  assert.equal(result.steps.filter(s => s.kind === 'owner-candidate').length, 1);
});

test('unknown Owner policy is rejected before source fetch, build or filesystem effects', async () => {
  let called = 0;
  await assert.rejects(packagePinnedInstance({ ownerPolicy: 'guess', run() { called++; } }), /INVALID_PACKAGE_OWNER_POLICY/);
  assert.equal(called, 0);
});
