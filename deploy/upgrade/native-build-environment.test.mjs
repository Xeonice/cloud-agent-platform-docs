import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeBuildEnvironment } from './native-build-environment.mjs';

test('a matching Node ABI on a newer glibc host cannot qualify the Rocky 8 native closure', () => {
  for (const glibcVersion of ['2.29', '2.31', '2.36', null]) {
    assert.throws(() => nativeBuildEnvironment({
      platform: 'linux', arch: 'arm64', nodeVersion: '22.23.3', nodeABI: '127', glibcVersion,
    }), { code: 'LINUX_NATIVE_BUILD_REQUIRES_GLIBC_2_28' });
  }
});

test('the actual Linux build witness binds the deployment libc as well as Node and architecture', () => {
  assert.deepEqual(nativeBuildEnvironment({
    platform: 'linux', arch: 'arm64', nodeVersion: '22.23.3', nodeABI: '127', glibcVersion: '2.28',
  }), { platform: 'linux', arch: 'arm64', nodeMajor: 22, nodeABI: '127', glibcVersion: '2.28', nativeBuildFromSource: true });
});

test('Darwin has its own native closure and still requires Node 22', () => {
  assert.deepEqual(nativeBuildEnvironment({
    platform: 'darwin', arch: 'arm64', nodeVersion: '22.23.3', nodeABI: '127',
  }), { platform: 'darwin', arch: 'arm64', nodeMajor: 22, nodeABI: '127' });
  assert.throws(() => nativeBuildEnvironment({
    platform: 'darwin', arch: 'arm64', nodeVersion: '26.0.0', nodeABI: '145',
  }), { code: 'NODE22_REQUIRED' });
});
