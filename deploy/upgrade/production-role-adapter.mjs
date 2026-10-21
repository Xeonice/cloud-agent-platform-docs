import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { invariant, digest } from "./trust.mjs";
import { atomicJson, readJson, secureDirectory, inside } from "./io.mjs";
import { captureProcessIdentity } from "./supervisor-sampler.mjs";
import { createProtectedRoleLifecycle, fixedRoleName } from "./protected-role-lifecycle.mjs";
import { roleResourceFlags } from './role-resource-limits.mjs';
const CID = /^[a-f0-9]{64}$/;
const PROVIDER_ENV = [
  "SANDBOX_DEFAULT_IMAGE",
  "SANDBOX_DEFAULT_PROVIDER",
  "SANDBOX_BOXLITE_REGISTRY",
  "SANDBOX_AUTH_HELPER_IMAGE",
];
export function providerEnvironment(c) {
  const env = c?.providerEnv === undefined ? {} : c.providerEnv;
  invariant(
    env &&
      typeof env === "object" &&
      !Array.isArray(env) &&
      Object.getPrototypeOf(env) === Object.prototype &&
      Object.entries(env).every(
        ([key, value]) =>
          PROVIDER_ENV.includes(key) &&
          typeof value === "string" &&
          !/[\r\n]/.test(value),
      ) &&
      (!Object.hasOwn(env, "SANDBOX_DEFAULT_PROVIDER") ||
        env.SANDBOX_DEFAULT_PROVIDER === "boxlite"),
    "BOOTSTRAP_PROVIDER_ENV_INVALID",
  );
  return env;
}
export function roleEnvironment(c, kind, supplied) {
  const provider = providerEnvironment(c);
  return {
    ...supplied,
    ...(["owner", "coordinator"].includes(kind) ? provider : {}),
  };
}
export const bootstrapDataRoot = (c) =>
  c.kind === "idle-first-bootstrap-experiment"
    ? join(c.root, "business")
    : "/data";

export async function execute(program, args) {
  return new Promise((ok, fail) => {
    const child = spawn(program, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, settled = false;
    const reject = () => { if (!settled) { settled = true; fail(Object.assign(Error('Bootstrap command failed'), { code: 'BOOTSTRAP_COMMAND_FAILED' })); } };
    const timer = setTimeout(() => { reject(); try { child.kill('SIGKILL'); } catch {} }, 5000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8000000) { reject(); try { child.kill('SIGKILL'); } catch {} } else output += chunk; });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(); });
    child.once('close', status => { clearTimeout(timer); if (!settled) { settled = true; status === 0 ? ok(output) : fail(Object.assign(Error('Bootstrap command failed'), { code: 'BOOTSTRAP_COMMAND_FAILED' })); } });
  });
}

export function roleMounts(c, { kind, artifactRoot, cwd, ownerHome, env }) {
  const mounts = new Map();
  const bind = (source, destination = source, rw = false) => {
    invariant(
      isAbsolute(source) &&
        isAbsolute(destination) &&
        !/[\r\n,]/.test(source + destination),
      "FIXED_BOOTSTRAP_MOUNT_REQUIRED",
    );
    mounts.set(destination, { source, destination, rw });
  };
  const installer = join(c.root, "installer"),
    bindings = join(c.root, "bindings");
  if (['control-entry', 'control-supervisor'].includes(kind)) {
    const mode = kind === 'control-entry' ? 'entry' : 'supervisor', installation = c.controlFoundationEntries?.[mode];
    invariant(installation && c.controlFoundationRoot && inside(c.controlFoundationRoot, installation.configPath) && c.controlArtifactRoot === artifactRoot &&
      !inside(c.controlPrivateRoot, c.controlFoundationRoot) && !inside(c.controlLedgerRoot, c.controlFoundationRoot), 'CONTROL_FOUNDATION_MOUNT_SCOPE_REQUIRED');
    const protectedRoots = [c.controlPrivateRoot, ...(c.existingRuntimeRoots ?? [])];
    const allowed = (path) => isAbsolute(path) && protectedRoots.every(protectedPath => !inside(path, protectedPath) && !inside(protectedPath, path));
    invariant(Array.isArray(c.existingRuntimeRoots) && c.existingRuntimeRoots.length > 0 && c.existingRuntimeRoots.every(isAbsolute), 'CONTROL_FOUNDATION_EXISTING_RUNTIME_ROOTS_REQUIRED');
    bind(artifactRoot); bind(installation.configPath);
    if (mode === 'entry') {
      invariant(allowed(c.controlEntryRoot) && Array.isArray(c.controlEntryWebRoots) && c.controlEntryWebRoots.length > 0 && c.controlEntryWebRoots.length <= 128 && c.controlEntryWebRoots.every(allowed), 'CONTROL_ENTRY_MOUNT_SCOPE_REQUIRED');
      bind(c.controlEntryRoot, c.controlEntryRoot, true);
      for (const path of c.controlEntryWebRoots) bind(path);
    } else {
      invariant(allowed(c.controlFoundationRoot) && allowed(installer) && allowed(bindings) && allowed(c.controlFutureOwnerRoot), 'CONTROL_SUPERVISOR_MOUNT_SCOPE_REQUIRED');
      bind(c.controlFoundationRoot, c.controlFoundationRoot, true); bind(installer, installer, true); bind(bindings, bindings, true);
      bind(join(c.root, 'supervisor-publication'), join(c.root, 'supervisor-publication'), true);
      bind(join(c.root, 'supervisor-container-records'), join(c.root, 'supervisor-container-records'), true);
      bind(c.controlFutureOwnerRoot, c.controlFutureOwnerRoot, true);
      invariant(allowed(c.capacityStateRoot), 'CONTROL_CAPACITY_STATE_MOUNT_SCOPE_REQUIRED'); bind(c.capacityStateRoot, c.capacityStateRoot, true);
      invariant(allowed(c.controlLedgerRoot) && c.stableControl?.controlDbPath === join(c.controlLedgerRoot, 'control.db'), 'CONTROL_REFERENCE_LEDGER_SCOPE_REQUIRED');
      bind(c.controlLedgerRoot);
      if (c.stableControl?.maintenance) {
        invariant(allowed(c.controlLedgerRoot) && c.stableControl.controlDbPath === join(c.controlLedgerRoot, 'control.db'), 'CONTROL_MAINTENANCE_LEDGER_SCOPE_REQUIRED');
        bind(c.controlLedgerRoot, c.controlLedgerRoot, true);
        for (const fixed of Object.values(c.stableControl.maintenance.packages)) {
          invariant(allowed(fixed.artifactRoot) && isAbsolute(fixed.manifestPath) && isAbsolute(fixed.configPath) &&
            fixed.configPath !== join(c.controlPrivateRoot, 'access.db') && fixed.configPath.endsWith('.json'), 'CONTROL_MAINTENANCE_FIXED_MOUNT_REQUIRED');
          bind(fixed.artifactRoot); bind(fixed.manifestPath); bind(fixed.configPath);
        }
      }
      bind(c.businessHostPath, '/data'); if (c.kind === 'idle-first-bootstrap-experiment') bind(c.businessHostPath, bootstrapDataRoot(c));
      bind(c.catalogFile); bind(c.trustRootPath); bind('/var/run/docker.sock', '/var/run/docker.sock', true);
      invariant(c.procRoot === '/host/proc' && c.cgroupRoot === '/host/cgroup', 'CONTROL_SUPERVISOR_HOST_OBSERVATION_SCOPE_REQUIRED');
      bind('/proc', c.procRoot); bind('/sys/fs/cgroup', c.cgroupRoot);
    }
    invariant(!Object.keys(env).some(name => /^(?:ACCESS_PASSCODE|PASSCODE_COOKIE_SECRET|UPGRADE_SESSION_SECRET|DATA_ROOT|DATABASE_URL|BOXLITE_HOME|RUNTIME_OWNER_HOME)$/.test(name)), 'CONTROL_FOUNDATION_EXCESS_AUTHORITY');
  } else if (kind === 'control-agent') {
    invariant(c.controlAgentArtifactRoot === artifactRoot && c.controlPrivateRoot && c.controlLedgerRoot && c.controlPrivateRoot && !inside(c.controlPrivateRoot, c.controlLedgerRoot) && !inside(c.controlLedgerRoot, c.controlPrivateRoot) && !inside(c.controlPrivateRoot, c.businessHostPath) && !inside(c.businessHostPath, c.controlPrivateRoot) && !inside(installer, artifactRoot), 'CONTROL_AGENT_MOUNT_SCOPE_REQUIRED');
    invariant(Array.isArray(c.runtimeRoots) && c.runtimeRoots.length > 0 && c.runtimeRoots.length <= 128 && c.runtimeRoots.every(isAbsolute), 'CONTROL_AGENT_RUNTIME_ROOTS_REQUIRED');
    const controlPaths = [artifactRoot, c.controlPrivateRoot, c.controlLedgerRoot, c.controlDownloadRoot];
    const protectedPaths = [c.businessHostPath, ...c.runtimeRoots, '/var/run/docker.sock'];
    invariant(controlPaths.every(path => isAbsolute(path) && protectedPaths.every(protectedPath => !inside(path, protectedPath) && !inside(protectedPath, path))) && controlPaths.every((path, i) => controlPaths.every((other, j) => i === j || !inside(path, other))) && [artifactRoot, c.controlPrivateRoot, c.controlLedgerRoot].every(path => !inside(path, installer) && !inside(installer, path)), 'CONTROL_AGENT_EXCESS_MOUNT');
    invariant(c.controlDownloadRoot === join(installer, 'downloads') && [artifactRoot, c.controlPrivateRoot, c.controlLedgerRoot].every(path => !inside(path, c.controlDownloadRoot) && !inside(c.controlDownloadRoot, path)), 'CONTROL_DOWNLOAD_MOUNT_SCOPE_REQUIRED');
    bind(c.controlDownloadRoot, c.controlDownloadRoot, true);
    invariant(isAbsolute(c.capacityStateRoot) && [artifactRoot, c.controlPrivateRoot, c.controlLedgerRoot, c.controlDownloadRoot, ...protectedPaths].every(path => !inside(path, c.capacityStateRoot) && !inside(c.capacityStateRoot, path)), 'CONTROL_CAPACITY_STATE_MOUNT_SCOPE_REQUIRED');
    bind(c.capacityStateRoot);
    bind(artifactRoot); bind(c.controlPrivateRoot, c.controlPrivateRoot, true); bind(c.controlLedgerRoot, c.controlLedgerRoot, true); bind(bindings); bind(c.trustRootPath);
    invariant(!Object.keys(env).some(k => /^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|BOXLITE_RUNTIME_DIR|RUNTIME_OWNER_HOME)$/.test(k)), 'CONTROL_AGENT_EXCESS_AUTHORITY');
  } else if (kind === "installer") {
    bind(join(artifactRoot, "installer"));
    bind(installer);
    bind(join(installer, "journals"), join(installer, "journals"), true);
    bind(join(installer, "downloads"), join(installer, "downloads"), true);
    bind(bindings);
    bind(c.trustRootPath);
    invariant(
      !Object.keys(env).some((k) =>
        /^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|RUNTIME_OWNER_HOME|PLATFORM_COORDINATOR_RPC_KEY|PLATFORM_CONTROL_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_LEGACY_AUTH_CONTINUITY_KEY|UPGRADE_SESSION_SECRET)$/.test(
          k,
        ),
      ),
      "BOOTSTRAP_INSTALLER_EXCESS_AUTHORITY",
    );
  } else if (kind === "web") {
    bind(cwd);
    bind(join(cwd, ".next/cache"), join(cwd, ".next/cache"), true);
    invariant(
      !Object.keys(env).some((k) =>
        /KEY|SECRET|PASSCODE|DATABASE|DATA_ROOT|BOXLITE|RUNTIME_OWNER_HOME|UPGRADE_/.test(
          k,
        ),
      ),
      "BOOTSTRAP_WEB_EXCESS_AUTHORITY",
    );
  } else {
    bind(artifactRoot);
    if (kind === "api") {
      bind(bindings);
      invariant(
        !Object.keys(env).some((k) =>
          /^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|RUNTIME_OWNER_HOME|PLATFORM_COORDINATOR_RPC_KEY|PLATFORM_CONTROLLER_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_LEGACY_AUTH_CONTINUITY_KEY|UPGRADE_SESSION_SECRET|ACCESS_PASSCODE|PASSCODE_COOKIE_SECRET)$/.test(
            k,
          ),
        ),
        "BOOTSTRAP_CONTROL_EXCESS_AUTHORITY",
      );
    } else if (kind === "coordinator") {
      if (env.UPGRADE_CONTROL_DATABASE_PATH) {
        invariant(c.stableControl?.controlDbPath === env.UPGRADE_CONTROL_DATABASE_PATH && c.controlLedgerRoot && join(c.controlLedgerRoot, 'control.db') === env.UPGRADE_CONTROL_DATABASE_PATH && c.controlPrivateRoot && !inside(c.controlPrivateRoot, c.controlLedgerRoot) && !inside(c.controlLedgerRoot, c.controlPrivateRoot), 'CONTROL_LEDGER_MOUNT_SCOPE_REQUIRED');
        bind(c.controlLedgerRoot);
      }
      bind(c.businessHostPath, "/data", true);
      if (c.kind === "idle-first-bootstrap-experiment") {
        bind(c.businessHostPath, bootstrapDataRoot(c), true);
        bind(c.qualificationInstallationPath);
      }
      bind(bindings, bindings, true);
      bind(join(installer, "artifacts"));
      bind(c.trustRootPath);
      bind(c.catalogFile);
    } else if (kind === "owner") {
      invariant(
        ownerHome &&
          inside(c.root, ownerHome) &&
          !inside(installer, ownerHome) &&
          !inside(c.businessHostPath, ownerHome),
        "BOOTSTRAP_OWNER_HOME_REQUIRED",
      );
      bind(ownerHome, ownerHome, true);
      bind(join(c.businessHostPath, "workspaces"), "/data/workspaces", true);
      if (c.kind === "idle-first-bootstrap-experiment")
        bind(
          join(c.businessHostPath, "workspaces"),
          join(bootstrapDataRoot(c), "workspaces"),
          true,
        );
      invariant(
        !Object.keys(env).some((k) =>
          /^(?:DATA_ROOT|DATABASE_URL|PLATFORM_CONTROLLER_RPC_KEY|PLATFORM_CONTROL_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_LEGACY_AUTH_CONTINUITY_KEY|UPGRADE_SESSION_SECRET)$/.test(
            k,
          ),
        ),
        "BOOTSTRAP_OWNER_EXCESS_AUTHORITY",
      );
    } else invariant(false, "FIXED_BOOTSTRAP_ROLE_REQUIRED");
  }
  for (const key of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"])
    if (env[key]) bind(env[key]);
  return [...mounts.values()];
}

export async function createProductionRoleAdapter(c, { run = execute } = {}) {
  providerEnvironment(c);
  const docker = (args) =>
    run(c.docker.cli || "docker", [...c.docker.args, ...args]);
  const image = JSON.parse(
    await docker(["image", "inspect", c.runtimeImage]),
  )[0];
  invariant(
    image.Id === c.runtimeImage &&
      image.Os === "linux" &&
      image.Architecture === "arm64" &&
      !(image.Config.Env || []).some((v) =>
        /KEY|SECRET|TOKEN|PASSWORD|PASSCODE|DATABASE|DATA_ROOT|RUNTIME_OWNER_HOME|PLATFORM_/.test(
          v.split("=", 1)[0],
        ),
      ),
    "BOOTSTRAP_RUNTIME_IMAGE_INVALID",
  );
  const records = await secureDirectory(
    join(c.root, "supervisor-container-records"),
  );
  async function inspect(id) {
    invariant(CID.test(id), "FIXED_BOOTSTRAP_CONTAINER_REQUIRED");
    const row = JSON.parse(await docker(["inspect", id]))[0];
    invariant(
      row.Id === id &&
        row.Image === c.runtimeImage &&
        row.Config.Labels?.["agent-platform.instance"] === c.instanceId &&
        row.Config.Labels?.["agent-platform.installation"] === digest(c.root),
      "BOOTSTRAP_CONTAINER_IDENTITY_CHANGED",
    );
    let birth = {};
    if (row.State.Running) try { birth = await captureProcessIdentity({ hostPid: row.State.Pid, containerId: id, procRoot: c.procRoot || '/proc' }); } catch {}
    return {
      ...birth, artifactDigest: row.Config.Labels['agent-platform.artifact'] || null, attemptId: row.Config.Labels['agent-platform.attempt'] || null, operationId: row.Config.Labels['agent-platform.operation'] || null, commandId: row.Config.Labels['agent-platform.command'] || null,
      paused: row.State.Paused ?? null, restartPolicy: row.HostConfig.RestartPolicy?.Name || 'no', restartCount: row.RestartCount ?? null, oomKilled: row.State.OOMKilled ?? null, exitCode: row.State.ExitCode ?? null,
      containerId: id,
      imageDigest: row.Image,
      pid: 1,
      hostPid: row.State.Pid,
      startedAt: row.State.StartedAt,
      finishedAt: row.State.FinishedAt,
      running: row.State.Running,
      startIdentity: row.Config.Labels["agent-platform.start"],
      role: row.Config.Labels["agent-platform.role"],
      entrypoint: row.Config.Entrypoint,
      command: row.Config.Cmd,
      environmentNames: (row.Config.Env || []).map((v) => v.split("=", 1)[0]),
      workingDirectory: row.Config.WorkingDir,
      pidNamespace: row.HostConfig.PidMode || "private",
      network: row.HostConfig.NetworkMode,
      privileged: row.HostConfig.Privileged,
      mounts: row.Mounts.map((m) => ({
        type: m.Type,
        source: m.Source,
        destination: m.Destination,
        rw: m.RW,
      })),
      capabilities: row.HostConfig.CapAdd || [],
    };
  }
  async function launch(spec) {
    const {
      kind,
      args,
      entry,
      cwd,
      artifactRoot,
      ownerHome,
      record,
      env: suppliedEnv,
    } = spec;
    const env = roleEnvironment(c, kind, suppliedEnv);
    if (['control-entry', 'control-supervisor'].includes(kind)) {
      const mode = kind === 'control-entry' ? 'entry' : 'supervisor', expected = c.controlFoundationEntries?.[mode];
      invariant(expected && spec.stableBootstrap === true && record.commandId && record.startIdentity === expected.startIdentity && artifactRoot === c.controlArtifactRoot &&
        entry === join(artifactRoot, 'installer/control-foundation.mjs') && args[1] === expected.configPath && env.PLATFORM_PROCESS_ROLE === 'control-foundation', 'CONTROL_FOUNDATION_BOOTSTRAP_IDENTITY_REQUIRED');
    } else if(kind === 'control-agent') invariant(record.startIdentity === c.controlAgentStartIdentity && artifactRoot === c.controlAgentArtifactRoot && spec.stableBootstrap === true, 'CONTROL_AGENT_BOOTSTRAP_IDENTITY_REQUIRED');
    else if(c.stableControl) invariant(kind !== 'installer' && record.commandId && typeof spec.assertBeforeDispatch === 'function', 'STABLE_ROLE_FIXED_COMMAND_REQUIRED');
    invariant(
      ["api", "web", "coordinator", "owner", "installer", "control-agent", "control-entry", "control-supervisor"].includes(kind) &&
        isAbsolute(entry) &&
        args[0] === entry &&
        args.length === (["installer", "control-agent", "control-entry", "control-supervisor"].includes(kind) ? 2 : 1) &&
        (inside(artifactRoot, entry) ||
          (kind === "web" && inside(c.root, entry))) &&
        record.startIdentity,
      "FIXED_BOOTSTRAP_PROCESS_REQUIRED",
    );
    const name = fixedRoleName(c.instanceId, {...record, kind});
    const argv = [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      "host",
      "--read-only",
      "--user",
      `${c.uid}:${c.gid}`,
      "--label",
      "agent-platform.instance=" + c.instanceId,
      "--label",
      "agent-platform.installation=" + digest(c.root),
      "--label",
      "agent-platform.start=" + record.startIdentity,
      "--label",
      "agent-platform.role=" + kind,
      "--label", "agent-platform.artifact=" + record.artifactDigest,
      ...(record.attemptId ? ["--label", "agent-platform.attempt=" + record.attemptId] : []),
      ...(record.commandId ? ['--label', 'agent-platform.command=' + record.commandId, '--label', 'agent-platform.operation=' + record.operationId] : []),
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--workdir",
      cwd,
    ];
    if (kind === 'control-supervisor') argv.push('--cgroupns', 'host');
    if (['control-agent', 'control-entry', 'control-supervisor'].includes(kind)) {
      const resources = kind === 'control-agent' ? c.controlAgentResources : c.controlFoundationEntries[kind === 'control-entry' ? 'entry' : 'supervisor'].resources;
      invariant(resources && Number.isSafeInteger(resources.memoryBytes) && resources.memoryBytes >= 64 * 1024 * 1024 && Number.isSafeInteger(resources.cpuMilliCores) && resources.cpuMilliCores > 0 && Number.isSafeInteger(resources.pidsLimit) && resources.pidsLimit > 0 && resources.pidsLimit <= 65536, 'CONTROL_ROLE_RESOURCE_LIMITS_REQUIRED');
      argv.push(...roleResourceFlags({ resources, pidsLimit: resources.pidsLimit, ioDevices: c.capacityIoDevices }));
    } else if (c.stableControl) {
      argv.push(...roleResourceFlags({ resources: spec.resources, pidsLimit: c.rolePidsLimits?.[kind], ioDevices: c.capacityIoDevices }));
    }
    if (kind === "owner") argv.push("--device", "/dev/kvm", "--privileged");
    else argv.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
    if (kind !== "owner")
      for (const v of image.Config.Env || [])
        if (v.startsWith("BOXLITE_"))
          argv.push("--env", v.split("=", 1)[0] + "=");
    for (const mount of roleMounts(c, spec))
      argv.push(
        "--mount",
        `type=bind,src=${mount.source},dst=${mount.destination}${mount.rw ? "" : ",readonly"}`,
      );
    const envFile = join(records, name + ".env");
    await fs.writeFile(
      envFile,
      Object.entries(env)
        .map(([key, value]) => {
          invariant(
            /^[A-Z_][A-Z0-9_]*$/.test(key) &&
              typeof value === "string" &&
              !/[\r\n]/.test(value),
            "INVALID_BOOTSTRAP_ROLE_ENV",
          );
          return key + "=" + value;
        })
        .join("\n") + "\n",
      { mode: 0o600, flag: "wx" },
    );
    let id;
    try {
      if(record.commandId) await lifecycle.prepareStart(record);
      if(spec.assertBeforeDispatch) await spec.assertBeforeDispatch();
      id = (
        await docker([
          ...argv,
          "--env-file",
          envFile,
          "--entrypoint",
          "/usr/local/bin/node",
          c.runtimeImage,
          ...args,
        ])
      ).trim();
    } finally {
      await fs.rm(envFile, { force: true });
    }
    const proof = await inspect(id);
    invariant(
      proof.running &&
        proof.pidNamespace === "private" &&
        proof.network === "host" &&
        proof.startIdentity === record.startIdentity,
      "BOOTSTRAP_ROLE_NOT_ISOLATED",
    );
    await atomicJson(join(records, id + ".json"), {
      ...proof,
      kind,
      instanceId: c.instanceId,
    });
    await lifecycle.completeStart(record, proof);
    return proof;
  }
  async function signal(id, signal = "SIGTERM") {
    invariant(signal === "SIGTERM", "BOOTSTRAP_FORCE_STOP_FORBIDDEN");
    const receipt = await readJson(join(records, id + ".json"));
    invariant(
      receipt.instanceId === c.instanceId,
      "BOOTSTRAP_CONTAINER_NOT_OWNED",
    );
    const before = await inspect(id);
    if(c.stableControl) invariant(!['owner', 'control-agent', 'control-entry', 'control-supervisor'].includes(before.role), 'PROTECTED_ROLE_STOP_FORBIDDEN');
    if (!before.running) return before;
    await docker(["kill", "--signal", "SIGTERM", id]);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const after = await inspect(id);
      invariant(
        after.startIdentity === before.startIdentity &&
          after.startedAt === before.startedAt,
        "BOOTSTRAP_CONTAINER_INCARNATION_CHANGED",
      );
      if (!after.running && after.hostPid === 0) return after;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    invariant(false, "BOOTSTRAP_PROCESS_STOP_UNCONFIRMED");
  }
  async function restartInstaller(id) {
    const receipt = await readJson(join(records, id + ".json"));
    invariant(
      receipt.kind === "installer" && !(await inspect(id)).running,
      "ONLY_ABSENT_OWNED_INSTALLER_MAY_RESTART",
    );
    await docker(["start", id]);
    return inspect(id);
  }
  const lifecycle = createProtectedRoleLifecycle({instanceId: c.instanceId, registryRoot: records, inspect, signalTerm: signal, findByName: async name => { const ids = (await docker(['ps', '--all', '--no-trunc', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'])).trim().split(/\s+/).filter(Boolean); invariant(ids.length <= 1 && ids.every(id => CID.test(id)), 'ROLE_START_LOOKUP_UNKNOWN'); return ids[0] || null; }});
  return {
    ...lifecycle, launchControlAgent: spec => launch({...spec, kind: 'control-agent', stableBootstrap: true}),
    launchIndependentFoundation: spec => { invariant(['entry', 'supervisor'].includes(spec.mode), 'CONTROL_FOUNDATION_MODE_INVALID'); return launch({...spec, kind: 'control-' + spec.mode, stableBootstrap: true}); }, procRoot: c.procRoot || '/proc', cgroupRoot: c.cgroupRoot || '/sys/fs/cgroup',
    launch,
    inspect,
    signal,
    restartInstaller,
    imageDigest: image.Id,
    isolation: "containers",
  };
}
