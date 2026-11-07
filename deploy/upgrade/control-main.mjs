import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { invariant } from './trust.mjs';
import { inside } from './io.mjs';
import { actualInstallerIdentity } from './installer-identity.mjs';
import { verifyInstalledControlPackage } from './control-package.mjs';
import { assembleControlRuntime } from './control-runtime.mjs';
import { createControlParticipants } from './control-participants.mjs';
import { createSupervisorClient } from './candidate-supervisor.mjs';
import { privateLoopbackOrigin } from './control-rpc.mjs';
import { createControlExecution, createControlContractBusinessFactory } from './control-execution.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,180}$/;
const PATHS = ['controlArtifactRoot', 'controlManifestPath', 'trustRootPath', 'catalogFile', 'controlRoot', 'controlLedgerRoot', 'downloadRoot', 'coordinatorBindingPath', 'capacityPlanPath', 'capacityStateRoot'];

export function validateControlConfig(c) {
  invariant(c && Object.getPrototypeOf(c) === Object.prototype && ID.test(c.instanceId) && ID.test(c.startIdentity), 'CONTROL_CONFIG_IDENTITY_REQUIRED');
  invariant(PATHS.every(name => typeof c[name] === 'string' && isAbsolute(c[name]) && !/[\r\n\0]/.test(c[name]) && resolve(c[name]) === c[name]), 'CONTROL_CONFIG_ABSOLUTE_PATH_REQUIRED');
  const roots = [c.controlArtifactRoot, c.controlRoot, c.controlLedgerRoot, c.downloadRoot, c.capacityStateRoot];
  invariant(roots.every((path, i) => roots.every((other, j) => i === j || !inside(path, other))), 'CONTROL_CONFIG_ROOTS_OVERLAP');
  invariant(!inside(c.controlArtifactRoot, c.controlManifestPath) && !inside(c.controlLedgerRoot, c.controlManifestPath), 'CONTROL_CONFIG_DESCRIPTOR_SCOPE_INVALID');
  invariant(c.root === undefined || c.root === c.controlRoot, 'CONTROL_CONFIG_PRIVATE_ROOT_MISMATCH');
  invariant(inside(c.capacityStateRoot, c.capacityPlanPath) && c.capacityStateRoot !== c.capacityPlanPath &&
    (c.qualificationInstallationPath === undefined || isAbsolute(c.qualificationInstallationPath) && !/[\r\n\0]/.test(c.qualificationInstallationPath)), 'CONTROL_CONFIG_CAPACITY_OR_QUALIFICATION_SCOPE_INVALID');
  invariant(['controllerKey', 'businessKey', 'supervisorKey', 'entryKey', 'privateEntryKey', 'accessAuthorityKey'].every(name => typeof c[name] === 'string' && c[name].length >= 32 && c[name].length <= 4096 && !/[\r\n\0]/.test(c[name])), 'CONTROL_CONFIG_PRIVATE_KEYS_REQUIRED');
  invariant(c.businessKey !== c.controllerKey && c.accessAuthorityKey !== c.controllerKey && c.privateEntryKey !== c.controllerKey && c.privateEntryKey !== c.accessAuthorityKey, 'CONTROL_CONFIG_ROLE_KEYS_MUST_BE_SEPARATE');
  for (const name of ['coordinatorOrigin', 'supervisorOrigin', 'entryOrigin']) privateLoopbackOrigin(c[name]);
  invariant(Number.isInteger(c.controlPort) && c.controlPort > 0 && c.controlPort <= 65535, 'CONTROL_CONFIG_FIXED_PORT_REQUIRED');
  invariant(Array.isArray(c.allowedOrigins) && c.allowedOrigins.length > 0 && c.allowedOrigins.length <= 16 && c.allowedOrigins.every(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password; } catch { return false; }
  }), 'CONTROL_CONFIG_PUBLIC_ORIGINS_REQUIRED');
  invariant(!['businessDatabasePath', 'databaseUrl', 'ownerHome', 'boxliteHome', 'docker', 'dockerSocket', 'providerEnv', 'runtimeEnv', 'authEnv'].some(name => Object.hasOwn(c, name)), 'CONTROL_CONFIG_EXCESS_AUTHORITY');
  return { ...c, root: c.controlRoot, controllerId: c.controllerId ?? c.startIdentity };
}

export async function readControlConfig(configPath) {
  invariant(typeof configPath === 'string' && isAbsolute(configPath), 'CONTROL_CONFIG_PATH_REQUIRED');
  const stat = await lstat(configPath);
  invariant(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size <= 65536 && await realpath(configPath) === resolve(configPath), 'CONTROL_CONFIG_INSECURE');
  return validateControlConfig(JSON.parse(await readFile(configPath, 'utf8')));
}

/** Starts only the independent Agent. Foundation owns Entry and Supervisor;
 * this process has no provider registry, Docker socket or business database. */
export async function startControl(configPath, { signal, onEvent } = {}) {
  invariant(Number(process.versions.node.split('.')[0]) === 22 && process.env.PLATFORM_PROCESS_ROLE === 'upgrade-control', 'CONTROL_NODE22_PROCESS_ROLE_REQUIRED');
  const c = await readControlConfig(configPath), codeRoot = dirname(fileURLToPath(import.meta.url));
  invariant(await realpath(codeRoot) === resolve(c.controlArtifactRoot, 'installer'), 'CONTROL_CONFIG_RUNNING_CODE_MISMATCH');
  const identity = await actualInstallerIdentity({ instanceId: c.instanceId, startIdentity: c.startIdentity, root: codeRoot });
  const verifiedPackage = await verifyInstalledControlPackage({ artifactRoot: c.controlArtifactRoot, manifestPath: c.controlManifestPath, trustRootPath: c.trustRootPath, engineIdentity: identity });
  process.env.UPGRADE_TRUST_ROOT_PATH = c.trustRootPath;
  process.env.UPGRADE_CATALOG_FILE = c.catalogFile;
  process.env.UPGRADE_CONTROL_ROOT = c.controlRoot;
  if (c.qualificationInstallationPath) process.env.UPGRADE_QUALIFICATION_INSTALLATION_PATH = c.qualificationInstallationPath;
  else delete process.env.UPGRADE_QUALIFICATION_INSTALLATION_PATH;
  const runtimeConfig = { ...c, controllerId: 'control-' + randomUUID() };
  return assembleControlRuntime({ config: runtimeConfig, verifiedPackage, engineIdentity: identity, signal, onEvent,
    participantsFactory: ({ authority, business }) => createControlParticipants({ instanceId: c.instanceId, authority, business,
      entryOrigin: c.entryOrigin, entryKey: c.entryKey, entryControllerKey: c.privateEntryKey,
      supervisor: createSupervisorClient({ origin: c.supervisorOrigin, instanceId: c.instanceId, key: c.supervisorKey }) }),
    contractBusinessFactory: createControlContractBusinessFactory,
    executionFactory: createControlExecution,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort()); process.once('SIGINT', () => stop.abort());
  startControl(process.argv[2], { signal: stop.signal, onEvent: event => process.stdout.write(JSON.stringify(event) + '\n') })
    .then(runtime => { process.stdout.write(JSON.stringify({ kind: 'control-ready', instanceId: runtime.identity.instanceId, controlVersion: runtime.identity.controlSystem.version }) + '\n'); })
    .catch(error => { process.stderr.write((/^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'CONTROL_START_FAILED') + '\n'); process.exitCode = 1; });
}
