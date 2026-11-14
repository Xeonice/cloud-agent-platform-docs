import { invariant } from './trust.mjs';

const METHODS = {
  sourceActual: (forRecovery = false) => ({ action: 'sourceActual', forRecovery }),
  installedProof: (release, binding) => ({ action: 'installedProof', release, ...(binding ? { binding } : {}) }),
  capture: () => ({ action: 'capture' }),
  bootstrapProof: (release, artifactRoot) => ({ action: 'bootstrapProof', release, artifactRoot }),
  entryBinding: () => ({ action: 'entryBinding' }),
  webBuild: binding => ({ action: 'webBuild', binding }),
  installerIdentity: () => ({ action: 'installerIdentity' }),
  controlIdentity: origin => ({ action: 'controlIdentity', origin }),
  processObserve: input => ({ action: 'processObserve', input }),
  verifySourceArtifact: (artifactRoot, expected) => ({ action: 'verifySourceArtifact', artifactRoot, expected }),
  validateSwitch: (attemptId, fence, input) => ({ action: 'validateSwitch', attemptId, fence, input }),
  authenticationContinuity: (attemptId, fence, origin) => ({ action: 'authenticationContinuity', attemptId, fence, origin }),
  continuity: (attemptId, fence) => ({ action: 'continuity', attemptId, fence }),
  fallbackEligibility: (attemptId, fence) => ({ action: 'fallbackEligibility', attemptId, fence }),
  commandStatus: input => ({ action: 'commandStatus', ...input }),
  writerIdentity: () => ({ action: 'writerIdentity' }),
  participantCommandStatus: input => ({ action: 'participantCommandStatus', ...input }),
};

/** Fixed semantic business RPCs. This port has no SQL, filesystem or SDK handle. */
export function createControlInspectorClient({ client, instanceId, clock = Date.now, metadataMaxAgeMs = 5000, proofTimeoutMs = 120000 }) {
  invariant(client && typeof client.inspection === 'function' && typeof instanceId === 'string' && proofTimeoutMs > 0 && proofTimeoutMs <= 120000, 'CONTROL_INSPECTOR_CONFIG_INVALID');
  let metadata = null, pending = null;
  const readMetadata = () => {
    const age = metadata ? clock() - Date.parse(metadata.observedAt) : Infinity;
    invariant(metadata && age >= 0 && age <= metadataMaxAgeMs, 'BUSINESS_METADATA_UNKNOWN_OR_STALE');
    return structuredClone(metadata);
  };
  async function invoke(body, timeoutMs) {
    const response = await client.inspection(body, { timeoutMs });
    invariant(response?.instanceId === instanceId && response.action === body.action && Number.isFinite(Date.parse(response.startedAt)) && Number.isFinite(Date.parse(response.completedAt)), 'BUSINESS_INSPECTION_RECEIPT_INVALID');
    // Do not re-date physical proof merely because an RPC returned successfully.
    return response.result;
  }
  const port = {
    async refreshMetadata() {
      pending ??= invoke({ action: 'metadata' }, 2000).then(value => {
        invariant(value && Number.isSafeInteger(value.schema) && value.schema >= 0 && Array.isArray(value.requiredDataFormats) && value.requiredDataFormats.every(v => v === 'project-name-v2-authority') && Array.isArray(value.defaultImagesSnapshot) && Number.isFinite(Date.parse(value.observedAt)), 'BUSINESS_METADATA_RECEIPT_INVALID');
        const age = clock() - Date.parse(value.observedAt);
        invariant(age >= 0 && age <= metadataMaxAgeMs, 'BUSINESS_METADATA_UNKNOWN_OR_STALE');
        metadata = structuredClone(value);
        return readMetadata();
      }).finally(() => { pending = null; });
      return pending;
    },
    metadata: readMetadata,
    schema: () => readMetadata().schema,
    requiresProjectNameV2: () => readMetadata().requiredDataFormats.includes('project-name-v2-authority'),
    defaultImagesSnapshot: () => readMetadata().defaultImagesSnapshot,
  };
  for (const [name, command] of Object.entries(METHODS)) port[name] = (...args) => invoke(command(...args), proofTimeoutMs);
  return Object.freeze(port);
}
