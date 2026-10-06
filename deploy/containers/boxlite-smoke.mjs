import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

// Run only inside the disposable Linux ARM64 proof container. The Docker caller
// supplies a fresh named /data volume and KVM; no production or host paths.
const phase = process.argv[2];
if (
  process.platform !== "linux" ||
  process.arch !== "arm64" ||
  process.versions.node.split(".")[0] !== "22" ||
  process.env.BOXLITE_HOME !== "/data/boxlite" ||
  !["create", "resume", "cleanup"].includes(phase)
)
  throw new Error("Use the isolated Node22 Linux ARM64 proof container");

const require = createRequire(import.meta.url);
const sdkVersion = require("@boxlite-ai/boxlite/package.json").version;
if (sdkVersion !== "0.9.7")
  throw new Error("The production SDK pin is required");
const { JsBoxlite } = await import("@boxlite-ai/boxlite");
const kvm = spawnSync(
  "/usr/bin/python3",
  [
    "-c",
    'import os,fcntl,json;fd=os.open("/dev/kvm",os.O_RDWR);api=fcntl.ioctl(fd,0xAE00,0);vm=fcntl.ioctl(fd,0xAE01,0);print(json.dumps({"api":api,"createVm":vm>=0}));os.close(vm);os.close(fd)',
  ],
  { encoding: "utf8", timeout: 5000 },
);
if (kvm.status !== 0 || kvm.error)
  throw new Error("Container KVM ioctl failed");
const kvmProof = JSON.parse(kvm.stdout);
if (kvmProof.api !== 12 || !kvmProof.createVm)
  throw new Error("Container KVM VM creation failed");

const report = {
  kind: "actual-boxlite-0.9.7-in-linux-arm64-docker",
  phase,
  sdkVersion,
  node: process.version,
  uid: process.getuid(),
  kvm: kvmProof,
  startedAt: new Date().toISOString(),
  checks: [],
  productionTouched: false,
};
await fs.mkdir("/data/proof", { recursive: true, mode: 0o700 });
await fs.mkdir("/data/shared", { recursive: true, mode: 0o700 });
const runtime = new JsBoxlite({ homeDir: "/data/boxlite" });
const ownedIds = [];
async function execute(box, command, args, tty = false) {
  const execution = await box.exec(command, args, null, tty, null, 20, null);
  await (await execution.stdin()).close();
  const collect = async (stream) => {
    let value = "";
    for (;;) {
      const next = await stream.next();
      if (next === null) return value;
      value += next;
      if (value.length > 8192) throw new Error("Unexpected proof output size");
    }
  };
  const [stdout, stderr, result] = await Promise.all([
    collect(await execution.stdout()),
    tty ? Promise.resolve("") : collect(await execution.stderr()),
    execution.wait(),
  ]);
  if (result.exitCode !== 0) throw new Error("MicroVM proof command failed");
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
}
async function verifyJailer(id) {
  const own = Object.fromEntries(
    await Promise.all(
      ["pid", "mnt", "user"].map(async (kind) => [
        kind,
        await fs.readlink("/proc/self/ns/" + kind),
      ]),
    ),
  );
  for (const pid of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const args = (
        await fs.readFile("/proc/" + pid + "/cmdline", "utf8")
      ).split("\0");
      if (args[0] !== "/data/boxlite/boxes/" + id + "/bin/boxlite-shim")
        continue;
      const separated = Object.fromEntries(
        await Promise.all(
          ["pid", "mnt", "user"].map(async (kind) => [
            kind,
            (await fs.readlink("/proc/" + pid + "/ns/" + kind)) !== own[kind],
          ]),
        ),
      );
      if (!Object.values(separated).every(Boolean))
        throw new Error("BoxLite jailer namespace separation failed");
      return separated;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Running jailed BoxLite shim not found");
}
try {
  if (phase === "create") {
    if ((await runtime.listInfo()).length)
      throw new Error("Creation requires an empty dedicated BoxLite home");
    const marker = randomUUID();
    const ids = [];
    const hostKernel = spawnSync("/bin/uname", ["-r"], {
      encoding: "utf8",
    }).stdout.trim();
    for (let i = 0; i < 2; i++) {
      const box = await runtime.create(
        {
          image: "docker.io/library/alpine:3.22.2",
          cpus: 1,
          memoryMib: 256,
          diskSizeGb: 1,
          detach: true,
          autoRemove: false,
          volumes: [{ hostPath: "/data/shared", guestPath: "/proof-shared" }],
        },
        "docker-proof-" + i,
      );
      const id = box.id;
      ids.push(id);
      ownedIds.push(id);
      await fs.writeFile(
        "/data/proof/boxes.json",
        JSON.stringify({ ids, marker }),
        { mode: 0o600 },
      );
      const kernel = await execute(box, "/bin/uname", ["-r"]);
      if (kernel.stdout === hostKernel)
        throw new Error("Guest must have its own VM kernel");
      await execute(box, "/bin/sh", [
        "-c",
        "printf '%s' '" + marker + "' > /root/persistent-proof",
      ]);
      await execute(box, "/bin/sh", [
        "-c",
        "printf '%s' '" + marker + "' > /proof-shared/box-" + i,
      ]);
      if ((await fs.readFile("/data/shared/box-" + i, "utf8")) !== marker)
        throw new Error("Container-to-microVM shared volume failed");
      const pty = await execute(
        box,
        "/bin/sh",
        ["-c", "test -t 1 && echo PTY_OK"],
        true,
      );
      if (!pty.stdout.includes("PTY_OK")) throw new Error("PTY not verified");
      await box.stop();
      // SDK 0.9.7 invalidates a JsBox handle after stop().
      const restarted = await runtime.get(id);
      if (!restarted) throw new Error("Stopped microVM not found");
      await restarted.start();
      const restored = await execute(restarted, "/bin/cat", [
        "/root/persistent-proof",
      ]);
      if (restored.stdout !== marker)
        throw new Error("Stop/start lost the disk");
      report.checks.push({
        id,
        ownKernel: true,
        hostKernel,
        guestKernel: kernel.stdout,
        exec: true,
        pty: true,
        sharedVolume: true,
        stopStartDiskPreserved: true,
      });
      await restarted.stop();
    }
  } else {
    const saved = JSON.parse(
      await fs.readFile("/data/proof/boxes.json", "utf8"),
    );
    const running = [];
    for (const id of saved.ids) {
      ownedIds.push(id);
      const box = await runtime.get(id);
      if (!box || box.id !== id) throw new Error("Persisted microVM not found");
      await box.start();
      running.push({ id, box });
    }
    const active = await runtime.listInfo();
    if (
      saved.ids.length !== 2 ||
      !saved.ids.every((id) =>
        active.some((info) => info.id === id && info.state.running),
      )
    )
      throw new Error("Both proof microVMs must run concurrently");
    report.twoMicroVMsRunningConcurrently = true;
    for (const { id, box } of running) {
      const restored = await execute(box, "/bin/cat", [
        "/root/persistent-proof",
      ]);
      if (restored.stdout !== saved.marker)
        throw new Error("Container replacement lost the microVM disk");
      report.checks.push({
        id,
        sameBoxId: true,
        containerRecreationDiskPreserved: true,
        jailerNamespaces: await verifyJailer(id),
      });
      await box.stop();
      if (phase === "cleanup") await runtime.remove(id, false);
    }
    if (phase === "cleanup" && (await runtime.listInfo()).length)
      throw new Error("Owned proof microVMs were not removed");
  }
  report.state = "passed";
} catch (error) {
  report.state = "failed";
  report.error = error.message;
  for (const id of ownedIds) {
    try {
      const box = await runtime.get(id);
      if (box) await box.stop();
    } catch (stopError) {
      report.cleanupError = stopError.message;
    }
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    "/data/proof/" + phase + ".json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  runtime.close();
  console.log(JSON.stringify(report));
}
