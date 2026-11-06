import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { digest, DIGEST, invariant } from './trust.mjs';
import { inside } from './io.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CID = /^[a-f0-9]{64}$/;

/** Existing legacy Coordinators already see installer/artifacts read-only.
 * This reserved non-package namespace supplies a single ledger directory, never
 * the installer parent, to the new Agent. It grants no adoption authority. */
export function legacyControlAttachmentLedgerRoot(instanceRoot, operationId) {
  invariant(typeof instanceRoot === 'string' && isAbsolute(instanceRoot) &&
    resolve(instanceRoot) === instanceRoot && !/[\r\n\0,]/.test(instanceRoot) && UUID.test(operationId ?? ''),
  'CONTROL_ADOPTION_LEDGER_LAYOUT_INVALID');
  return join(instanceRoot, 'installer', 'artifacts', '.control-adoption', operationId, 'ledger');
}

export function isLegacyControlAttachmentLedger(c) {
  if (c.legacyControlAttachmentOperationId === undefined) return false;
  invariant(c.controlLedgerRoot === legacyControlAttachmentLedgerRoot(c.root, c.legacyControlAttachmentOperationId),
    'CONTROL_ADOPTION_LEDGER_LAYOUT_INVALID');
  return true;
}

export async function assertLegacyControlAttachmentLedgerDirectory({ root, operationId, controlLedgerRoot }) {
  invariant(controlLedgerRoot === legacyControlAttachmentLedgerRoot(root, operationId), 'CONTROL_ADOPTION_LEDGER_LAYOUT_INVALID');
  const stat = await lstat(controlLedgerRoot);
  invariant(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(controlLedgerRoot) === controlLedgerRoot &&
    (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid() || stat.uid === 0),
  'CONTROL_ADOPTION_LEDGER_DIRECTORY_INSECURE');
  return { path: controlLedgerRoot, dev: String(stat.dev), ino: String(stat.ino) };
}

/** Read actual Docker identity/mounts without returning Env or keys. A deeper
 * writable overmount defeats the legacy parent RO mount and must be rejected.
 * This observation is a layout check, not settlement or an activation receipt. */
export async function observeLegacyControlAttachmentMount({ root, operationId, instanceId, coordinator,
  docker }, { run, clock = Date.now }) {
  const ledgerRoot = legacyControlAttachmentLedgerRoot(root, operationId);
  invariant(CID.test(coordinator?.containerId ?? '') && typeof coordinator.startIdentity === 'string' &&
    coordinator.startIdentity.length > 0 && DIGEST.test(coordinator.artifactDigest ?? '') &&
    typeof run === 'function' && docker && Array.isArray(docker.args), 'CONTROL_ADOPTION_COORDINATOR_IDENTITY_REQUIRED');
  // Historical launchers have no artifact label. Select only this one public
  // identity variable inside Docker's template; never return the full Env.
  const format = '{{ $artifact := "" }}{{range .Config.Env}}{{ $parts := split . "=" }}' +
    '{{if eq (index $parts 0) "PLATFORM_ARTIFACT_DIGEST"}}{{ $artifact = index $parts 1 }}{{end}}{{end}}' +
    '{"id":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},' +
    '"restartCount":{{json .RestartCount}},"labels":{{json .Config.Labels}},"artifactDigest":{{json $artifact}},"mounts":{{json .Mounts}}}';
  const row = JSON.parse(await run(docker.cli || 'docker', [...docker.args, 'inspect', '--format', format, coordinator.containerId]));
  invariant(row.id === coordinator.containerId && row.running === true && row.paused === false && row.restartCount === 0 &&
    row.labels?.['agent-platform.instance'] === instanceId && row.labels['agent-platform.role'] === 'coordinator' &&
    row.labels['agent-platform.start'] === coordinator.startIdentity && row.artifactDigest === coordinator.artifactDigest &&
    (!row.labels['agent-platform.artifact'] || row.labels['agent-platform.artifact'] === coordinator.artifactDigest),
  'CONTROL_ADOPTION_COORDINATOR_IDENTITY_CHANGED');
  invariant(Array.isArray(row.mounts), 'CONTROL_ADOPTION_LEDGER_READONLY_MOUNT_REQUIRED');
  invariant(!row.mounts.some(m => typeof m.Destination === 'string' && inside(ledgerRoot, m.Destination)),
    'CONTROL_ADOPTION_LEDGER_READONLY_MOUNT_REQUIRED');
  const mount = row.mounts.filter(m => typeof m.Destination === 'string' && inside(m.Destination, ledgerRoot))
    .sort((a, b) => b.Destination.length - a.Destination.length)[0];
  const parent = join(root, 'installer', 'artifacts');
  invariant(mount?.Type === 'bind' && mount.Source === parent && mount.Destination === parent && mount.RW === false,
    'CONTROL_ADOPTION_LEDGER_READONLY_MOUNT_REQUIRED');
  return { schemaVersion: 1, kind: 'legacy-coordinator-ledger-mount-observation', instanceId, operationId,
    ledgerRoot, coordinator: { ...coordinator }, mount: { type: mount.Type, source: mount.Source, destination: mount.Destination, readonly: true },
    mountsDigest: digest(row.mounts), observedAt: clock(), authorizesAdoption: false };
}
