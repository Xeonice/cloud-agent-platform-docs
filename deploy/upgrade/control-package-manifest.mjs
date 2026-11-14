// Shared side-effect-free descriptor validation. Both release-manifest binding
// and installed Control verification use the same schema, without an import cycle.
const VERSION = /^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const SHA = /^[a-f0-9]{40}$/, HASH = /^sha256:[a-f0-9]{64}$/;
export function validateControlPackage(value) {
  if (!(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') ===
    'apiRevision,executionEngineDigest,kind,projectRevision,protocolVersion,schemaVersion,treeDigest,version' &&
    value.schemaVersion === 1 && value.kind === 'upgrade-control' && VERSION.test(value.version) && value.protocolVersion === 1 &&
    SHA.test(value.apiRevision) && SHA.test(value.projectRevision) && HASH.test(value.treeDigest) && HASH.test(value.executionEngineDigest)))
    throw Object.assign(new Error('CONTROL_PACKAGE_MANIFEST_INVALID'), { code: 'CONTROL_PACKAGE_MANIFEST_INVALID' });
  return value;
}
