import { invariant } from './trust.mjs';

// Dockerfile.api builds and runs the Linux native closure on Rocky 8. A smoke
// test on a newer build host does not establish that the deployed roles can
// load that closure, even when Node's module ABI and CPU architecture match.
export function nativeBuildEnvironment({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  nodeABI = process.versions.modules,
  glibcVersion = platform === 'linux'
    ? process.report.getReport().header.glibcVersionRuntime
    : undefined,
} = {}) {
  invariant(Number(nodeVersion.split('.')[0]) === 22, 'NODE22_REQUIRED');
  invariant(platform !== 'linux' || glibcVersion === '2.28',
    'LINUX_NATIVE_BUILD_REQUIRES_GLIBC_2_28');
  return {
    platform, arch, nodeMajor: 22, nodeABI,
    ...(platform === 'linux' ? { glibcVersion, nativeBuildFromSource: true } : {}),
  };
}
