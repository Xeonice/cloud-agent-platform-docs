import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { invariant, digest } from "./trust.mjs";
import { atomicJson, readJson, secureDirectory, inside } from "./io.mjs";
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
    const child = spawn(program, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8_000_000) child.kill();
      else out += chunk;
    });
    // Never forward Docker stderr: env-file paths and authentication details belong in private evidence.
    child.stderr.resume();
    child.once("error", () =>
      fail(
        Object.assign(Error("Bootstrap command failed"), {
          code: "BOOTSTRAP_COMMAND_FAILED",
        }),
      ),
    );
    child.once("close", (code) =>
      code === 0 && bytes <= 8_000_000
        ? ok(out)
        : fail(
            Object.assign(Error("Bootstrap command failed"), {
              code: "BOOTSTRAP_COMMAND_FAILED",
            }),
          ),
    );
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
  if (kind === "installer") {
    bind(join(artifactRoot, "installer"));
    bind(installer);
    bind(join(installer, "journals"), join(installer, "journals"), true);
    bind(join(installer, "downloads"), join(installer, "downloads"), true);
    bind(bindings);
    bind(c.trustRootPath);
    invariant(
      !Object.keys(env).some((k) =>
        /^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|RUNTIME_OWNER_HOME|PLATFORM_COORDINATOR_RPC_KEY|PLATFORM_CONTROL_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_SESSION_SECRET)$/.test(
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
          /^(?:DATA_ROOT|DATABASE_URL|BOXLITE_HOME|RUNTIME_OWNER_HOME|PLATFORM_COORDINATOR_RPC_KEY|PLATFORM_CONTROLLER_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_SESSION_SECRET|ACCESS_PASSCODE|PASSCODE_COOKIE_SECRET)$/.test(
            k,
          ),
        ),
        "BOOTSTRAP_CONTROL_EXCESS_AUTHORITY",
      );
    } else if (kind === "coordinator") {
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
          /^(?:DATA_ROOT|DATABASE_URL|PLATFORM_CONTROLLER_RPC_KEY|PLATFORM_CONTROL_RPC_KEY|UPGRADE_ADMIN_KEY|UPGRADE_SESSION_SECRET)$/.test(
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
    return {
      containerId: id,
      imageDigest: row.Image,
      pid: 1,
      hostPid: row.State.Pid,
      startedAt: row.State.StartedAt,
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
    invariant(
      ["api", "web", "coordinator", "owner", "installer"].includes(kind) &&
        isAbsolute(entry) &&
        args[0] === entry &&
        args.length === (kind === "installer" ? 2 : 1) &&
        (inside(artifactRoot, entry) ||
          (kind === "web" && inside(c.root, entry))) &&
        record.startIdentity,
      "FIXED_BOOTSTRAP_PROCESS_REQUIRED",
    );
    const name =
      "upg-" +
      digest({
        instance: c.instanceId,
        start: record.startIdentity,
        kind,
      }).slice(7, 35);
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
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--workdir",
      cwd,
    ];
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
  return {
    launch,
    inspect,
    signal,
    restartInstaller,
    imageDigest: image.Id,
    isolation: "containers",
  };
}
