import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { preflightRuntimeDockerDependency } from "./runtime-docker-dependency.mjs";
import { execute, safeCommandFailure } from "./production-role-adapter.mjs";

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "runtime-cli-")),
  );
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const path = join(root, "runtime-tools/docker");
  await fs.mkdir(join(root, "runtime-tools"), { mode: 0o700 });
  const elf = Buffer.alloc(120);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(elf);
  elf.writeUInt16LE(183, 18);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(1, 64);
  await fs.writeFile(path, elf, { mode: 0o755 });
  const config = {
    controlFoundationRoot: root,
    docker: { cli: path, args: ["--host", "unix:///var/run/docker.sock"] },
    trustedRuntimeDockerCli: {
      schemaVersion: 1,
      kind: "root-supplied-runtime-docker-cli",
      path,
      bytes: elf.length,
      rawDigest: "sha256:" + createHash("sha256").update(elf).digest("hex"),
      sourceImageDigest: "sha256:" + "a".repeat(64),
    },
  };
  const mounts = [
    { source: root, destination: root, rw: true },
    ...[
      ["/var/run/docker.sock", "/var/run/docker.sock", true],
      ["/proc", "/host/proc", false],
      ["/sys/fs/cgroup", "/host/cgroup", false],
    ].map(([source, destination, rw]) => ({ source, destination, rw })),
  ];
  // File contents, inode stability, modes and reads use actual owned files.
  // Model only the production root UID and Linux socket on the macOS test host.
  const owner = (s) =>
      Object.assign(Object.create(Object.getPrototypeOf(s)), s, {
        uid: 0,
        gid: 0,
      }),
    filesystem = {
      ...fs,
      lstat: async (p) =>
        p === "/var/run/docker.sock"
          ? { isSocket: () => true }
          : owner(await fs.lstat(p)),
      open: async (...args) => {
        const h = await fs.open(...args);
        return {
          read: (...a) => h.read(...a),
          stat: async () => owner(await h.stat()),
          createReadStream: (...a) => h.createReadStream(...a),
          close: () => h.close(),
        };
      },
    };
  const calls = [],
    run = async (program, args) => {
      calls.push({ program, args });
      return "Docker version 29.5.2, build 79eb04c\n";
    };
  return {
    config,
    mounts,
    run,
    filesystem,
    calls,
    path,
    elf,
    check: () =>
      preflightRuntimeDockerDependency({ config, mounts, run, filesystem }),
  };
}
test("initial migration checks exact supplied static ARM64 executable, same-path mount and daemon/host observation dependencies", async (t) => {
  const f = await fixture(t),
    proof = await f.check();
  assert.equal(proof.tamperProof, false);
  assert.equal(proof.directoryMountWritable, true);
  assert.deepEqual(f.calls, [{ program: f.path, args: ["--version"] }]);
});
test("missing CLI, altered hash, dynamic ELF, wrong arch/mode/mount and altered transport reject before command execution", async (t) => {
  for (const bad of [
    "missing",
    "hash",
    "interpreter",
    "arch",
    "mode",
    "mount",
    "transport",
    "descriptor",
  ]) {
    const f = await fixture(t);
    if (bad === "missing") await fs.unlink(f.path);
    if (bad === "hash")
      f.config.trustedRuntimeDockerCli.rawDigest = "sha256:" + "0".repeat(64);
    if (bad === "interpreter" || bad === "arch") {
      if (bad === "interpreter") f.elf.writeUInt32LE(3, 64);
      else f.elf.writeUInt16LE(62, 18);
      await fs.writeFile(f.path, f.elf);
    }
    if (bad === "mode") await fs.chmod(f.path, 0o777);
    if (bad === "mount") f.mounts.splice(1, 1);
    if (bad === "transport")
      f.config.docker.args = ["--host", "tcp://unrelated"];
    if (bad === "descriptor") delete f.config.trustedRuntimeDockerCli;
    await assert.rejects(f.check(), {
      code:
        bad === "missing"
          ? "CONTROL_RUNTIME_DOCKER_CLI_MISSING"
          : "CONTROL_RUNTIME_DOCKER_DEPENDENCY_UNPROVEN",
    });
    assert.deepEqual(f.calls, []);
  }
});
test("spawn failure diagnostics locate missing executable without arguments, stderr or environment values", async () => {
  let error;
  try {
    await execute("/missing-runtime-dependency/docker", [
      "--token=private-value",
    ]);
  } catch (e) {
    error = e;
  }
  const safe = safeCommandFailure(error);
  assert.deepEqual(safe, {
    code: "BOOTSTRAP_COMMAND_FAILED",
    commandFailure: {
      program: "/missing-runtime-dependency/docker",
      reason: "spawn",
      causeCode: "ENOENT",
    },
  });
  assert.equal(JSON.stringify(safe).includes("private-value"), false);
  assert.equal(safeCommandFailure({ code: "OTHER", commandFailure: {} }), null);
});
