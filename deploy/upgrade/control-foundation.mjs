import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { invariant } from './trust.mjs';
import { createControlPlaneClient } from './control-plane-client.mjs';
import { createPrivateControlRpc, privateLoopbackOrigin } from './control-rpc.mjs';
import { createCandidateSupervisor } from './candidate-supervisor.mjs';
import { createStableEntry } from './stable-entry.mjs';
import { createProductionRoleAdapter, bootstrapDataRoot } from './production-role-adapter.mjs';
import { createControlAgentLifecycle } from './control-agent-lifecycle.mjs';

/** Stable Foundation does not run an Installer or open private access state.
 * Its lifecycle is explicit infrastructure maintenance, separate from a normal
 * business release. Constructing it never starts/stops any business role. */
export async function createIndependentFoundation(c, {
  paths, keys, origin, bindingPath, ownerBindingPath, installedReleasePath,
  initialBinding, Database, adapterFactory = createProductionRoleAdapter,
}) {
  const stable = c.stableControl;
  invariant(!stable?.migratedArtifactPath || stable.migratedArtifactPath === join(c.root, 'bindings/migration-source.json'), 'CONTROL_FOUNDATION_MIGRATION_SOURCE_SCOPE_INVALID');
  const mode = c.foundationMode ?? 'both';
  invariant(['entry', 'supervisor', 'both'].includes(mode), 'CONTROL_FOUNDATION_MODE_INVALID');
  invariant(stable && initialBinding?.instanceId === c.instanceId && [0, 100].includes(initialBinding.weight), 'CONTROL_FOUNDATION_CONFIRMED_BINDING_REQUIRED');
  invariant(keys.privateEntry?.length >= 32 && keys.businessProbe?.length >= 32 && keys.accessAuthority?.length >= 32 &&
    keys.upgradeControl?.length >= 32 && stable.key === keys.upgradeControl &&
    Object.entries(keys).every(([name, key]) => name === 'upgradeControl' || key !== keys.upgradeControl) &&
    stable.accessKey === keys.accessAuthority && keys.privateEntry !== keys.controller && keys.businessProbe !== keys.controller,
    'CONTROL_FOUNDATION_ROLE_KEYS_REQUIRED');
  invariant(c.controlArtifactRoot && stable.controlDbPath === join(c.controlLedgerRoot, 'control.db') && stable.agentStartIdentity, 'CONTROL_FOUNDATION_INSTALLATION_REQUIRED');
  privateLoopbackOrigin(stable.origin);
  if (mode !== 'entry' && !Database) Database = createRequire(join(c.controlArtifactRoot, 'api/apps/api/package.json'))('better-sqlite3');
  const common = { NODE_ENV: 'production', PATH: '/usr/local/bin:/usr/bin:/bin', PLATFORM_INSTANCE_ID: c.instanceId, HOST: '127.0.0.1', ...c.runtimeEnv };
  const network = { API_ALLOWED_ORIGINS: (c.allowedOrigins || [c.publicOrigin]).join(',') };
  const controlEnv = { ...network, PLATFORM_INSTANCE_ID: c.instanceId, PLATFORM_CONTROL_RPC_KEY: keys.control,
    COORDINATOR_RPC_URL: origin('coordinator'), PLATFORM_COORDINATOR_BINDING_PATH: bindingPath,
    UPGRADE_ACCESS_AUTHORITY_ORIGIN: stable.origin, UPGRADE_ACCESS_AUTHORITY_KEY: stable.accessKey };
  const ownerEnv = { PLATFORM_INSTANCE_ID: c.instanceId, PLATFORM_COORDINATOR_RPC_KEY: keys.owner, SANDBOX_DEFAULT_PROVIDER: 'boxlite' };
  const coordinatorEnv = {
    ...network, PLATFORM_INSTANCE_ID: c.instanceId, PLATFORM_CONTROL_RPC_KEY: keys.control,
    PLATFORM_CONTROLLER_RPC_KEY: keys.controller, PLATFORM_COORDINATOR_RPC_KEY: keys.owner,
    PLATFORM_COORDINATOR_BINDING_PATH: bindingPath, PLATFORM_RUNTIME_OWNER_BINDING_PATH: ownerBindingPath,
    COORDINATOR_RPC_URL: origin('coordinator'), RUNTIME_OWNER_RPC_URL: origin('owner'),
    DATA_ROOT: bootstrapDataRoot(c), DATABASE_URL: '/data/platform.db', MIGRATIONS_DIR: join(c.artifactRoot, 'api/drizzle'),
    UPGRADE_TRUST_ROOT_PATH: c.trustRootPath, UPGRADE_CATALOG_FILE: c.catalogFile,
    UPGRADE_INITIAL_RELEASE_PATH: installedReleasePath, UPGRADE_INITIAL_ARTIFACT_ROOT: c.artifactRoot,
    UPGRADE_INSTALLER_ROOT: paths.installer, PLATFORM_ENTRY_ORIGIN: origin('entry'),
    PLATFORM_ENTRY_CONTROL_ORIGIN: origin('entryControl'), PLATFORM_ENTRY_CONTROL_KEY: keys.controller,
    PLATFORM_INSTALLER_SUPERVISOR_ORIGIN: origin('supervisor'), PLATFORM_INSTALLER_SUPERVISOR_KEY: keys.controller,
    UPGRADE_CONTROL_DATABASE_PATH: stable.controlDbPath, UPGRADE_CONTROL_ORIGIN: stable.origin,
    UPGRADE_ACCESS_AUTHORITY_ORIGIN: stable.origin, UPGRADE_ACCESS_AUTHORITY_KEY: stable.accessKey,
    UPGRADE_BUSINESS_PROBE_KEY: keys.businessProbe, SANDBOX_DEFAULT_PROVIDER: 'boxlite',
    ...(stable.migratedArtifactPath ? { UPGRADE_MIGRATED_ARTIFACT_PATH: stable.migratedArtifactPath } : {}),
    ...(c.kind === 'idle-first-bootstrap-experiment' ? { UPGRADE_QUALIFICATION_INSTALLATION_PATH: c.qualificationInstallationPath } : {}),
  };
  const coordinator = createControlPlaneClient({ controlOrigin: stable.origin, controlKey: stable.key,
    coordinatorOrigin: origin('coordinator'), coordinatorKey: keys.controller, coordinatorBindingPath: bindingPath, instanceId: c.instanceId });
  const verify = createPrivateControlRpc({ origin: stable.origin, instanceId: c.instanceId, key: stable.key });
  const adapter = mode === 'entry' ? null : await adapterFactory({ ...c, controlAgentArtifactRoot: c.controlArtifactRoot });
  const controlMaintenanceLifecycle = mode !== 'entry' && stable.maintenance ? await createControlAgentLifecycle({ config: c, packages: stable.maintenance.packages, adapter }) : null;
  let supervisor, entry;
  try {
    if (mode !== 'entry') supervisor = await createCandidateSupervisor({ root: paths.installer, instanceId: c.instanceId, key: keys.supervisor, businessObserverKey: keys.controller, coordinator,
      controlEnv, coordinatorEnv, ownerEnv, runtimeEnv: c.runtimeEnv || {}, runtimeOwnerRoot: paths.futureOwners,
      publicationRoot: join(c.root, 'supervisor-publication'),
      apiPort: c.ports.apiB, webPort: c.ports.webB, coordinatorPort: c.ports.coordinatorB,
      coordinatorAppPort: c.ports.coordinatorAppB, ownerPort: c.ports.ownerB,
      port: c.ports.supervisor, launchAdapter: adapter, stableControl: stable, Database, controlMaintenanceLifecycle });
    if (mode !== 'supervisor') entry = await createStableEntry({ root: paths.entry, instanceId: c.instanceId, controlKey: keys.entry, observerKey: keys.controller, stickyKey: keys.sticky,
      port: c.ports.entry, controlPort: c.ports.entryControl, initialBinding,
      controlOrigin: stable.origin, privateEntryKey: keys.privateEntry, businessProbeKey: keys.businessProbe,
      verifyControlAuthority: value => verify('/internal/control/authority/verify', { epoch: value.epoch, operationId: value.operationId, executorId: value.executorId }),
      verifyFence: ({ attemptId, fence }) => coordinator.assertFence(attemptId, fence),
      verifyContractFence: ({ contractAttemptId, fence }) => coordinator.assertContractFence(contractAttemptId, fence) });
  } catch (error) { await Promise.allSettled([supervisor?.close(), entry?.close()]); throw error; }
  let closing;
  const close = () => closing ??= Promise.all([entry?.close(), supervisor?.close()]).then(() => {});
  return { common, controlEnv, ownerEnv, coordinatorEnv, coordinator, adapter, supervisor, entry, close };
}

export async function startIndependentFoundation(configPath, { signal } = {}) {
  invariant(Number(process.versions.node.split('.')[0]) === 22 && process.env.PLATFORM_PROCESS_ROLE === 'control-foundation', 'CONTROL_FOUNDATION_NODE22_ROLE_REQUIRED');
  invariant(isAbsolute(configPath), 'CONTROL_FOUNDATION_CONFIG_REQUIRED');
  const stat = await lstat(configPath);
  invariant(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size <= 262144 && await realpath(configPath) === resolve(configPath), 'CONTROL_FOUNDATION_CONFIG_INSECURE');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  invariant(config.schemaVersion === 1 && Object.keys(config).sort().join(',') === 'c,context,schemaVersion' && config.c && config.context &&
    !['verified', 'authEnv', 'adapterFactory', 'Database', 'origin'].some(name => Object.hasOwn(config.context, name)), 'CONTROL_FOUNDATION_CONFIG_INVALID');
  const { c, context } = config;
  invariant(c.ports && ['entry', 'supervisor'].includes(c.foundationMode) && !signal?.aborted, 'CONTROL_FOUNDATION_SEPARATE_PROCESS_REQUIRED');
  if (c.foundationMode === 'supervisor') invariant(isAbsolute(c.stableControl?.capacityCollectorConfigPath ?? '') && isAbsolute(c.stableControl?.capacityTransitionRoot ?? ''), 'CONTROL_FOUNDATION_CAPACITY_RUNTIME_REQUIRED');
  const origin = name => { const port = c.ports[name]; invariant(Number.isInteger(port) && port > 0 && port < 65536, 'CONTROL_FOUNDATION_FIXED_PORT_REQUIRED'); return `http://127.0.0.1:${port}`; };
  const runtime = await createIndependentFoundation(c, { ...context, origin });
  signal?.addEventListener('abort', () => { void runtime.close(); }, { once: true });
  if (signal?.aborted) await runtime.close();
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stop = new AbortController(); process.once('SIGTERM', () => stop.abort()); process.once('SIGINT', () => stop.abort());
  startIndependentFoundation(process.argv[2], { signal: stop.signal })
    .then(() => process.stdout.write(JSON.stringify({ kind: 'control-foundation-ready' }) + '\n'))
    .catch(error => { process.stderr.write((/^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'CONTROL_FOUNDATION_START_FAILED') + '\n'); process.exitCode = 1; });
}
