import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupQualificationSdkImages } from '../../e2e-contract/server/qualification-sdk-cache.mjs';

test('SDK cache cleanup leaves failed cases untouched even with the option enabled', async () => {
  assert.deepEqual(await cleanupQualificationSdkImages({ cleanupSdkImagesOnSuccess: true }), { preserved: true });
});
test('SDK cache cleanup requires an explicit boolean opt-in on successful cases', async () => {
  for (const input of [{}, { cleanupSdkImagesOnSuccess: false }, { cleanupSdkImagesOnSuccess: 'true' }]) {
    assert.deepEqual(await cleanupQualificationSdkImages(input, { resourcesCleaned: true }), { preserved: true });
  }
});
test('SDK cache cleanup rejects a production domain before any filesystem or command effect', async () => {
  for (const input of [
    { isolated: false, docker: { dedicated: true }, instanceId: 'upgrade-acceptance-unit' },
    { isolated: true, docker: { dedicated: false }, instanceId: 'upgrade-acceptance-unit' },
    { isolated: true, docker: { dedicated: true }, instanceId: 'production' },
  ]) await assert.rejects(cleanupQualificationSdkImages({ ...input, cleanupSdkImagesOnSuccess: true },
    { resourcesCleaned: true }), error => error.code === 'DEDICATED_QA_CACHE_CLEANUP_REQUIRED');
});
test('SDK cache cleanup rejects a non-QA path or unpinned image without opening a database', async () => {
  const base = { cleanupSdkImagesOnSuccess: true, isolated: true, instanceId: 'upgrade-acceptance-unit',
    root: '/tmp/upg-qa-test-work/case', docker: { dedicated: true, args: [], image: 'sha256:' + 'a'.repeat(64) } };
  for (const input of [{ ...base, root: '/tmp/production' },
    { ...base, docker: { ...base.docker, image: 'latest' } }, { ...base, root: '/tmp/upg-qa-test-work/case/../other' }]) {
    await assert.rejects(cleanupQualificationSdkImages(input, { resourcesCleaned: true }), error =>
      error.code === (process.platform === 'linux' && process.arch === 'arm64'
        ? 'FIXED_QA_CACHE_SCOPE_REQUIRED' : 'DEDICATED_QA_CACHE_CLEANUP_REQUIRED'));
  }
});
