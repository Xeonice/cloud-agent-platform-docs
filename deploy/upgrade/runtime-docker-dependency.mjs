import * as nativeFs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { digest, invariant } from "./trust.mjs";

// The file is an explicitly supplied runtime dependency, outside signed code.
// Its parent Foundation mount is writable: this is a point-in-time preflight,
// not a claim that the executable cannot subsequently be replaced.
export async function preflightRuntimeDockerDependency({
  config: c,
  mounts,
  run,
  filesystem = nativeFs,
}) {
  const fs = filesystem;
  const proof = c.trustedRuntimeDockerCli,
    path = c.docker?.cli;
  const need = (value) =>
    invariant(value, "CONTROL_RUNTIME_DOCKER_DEPENDENCY_UNPROVEN");
  need(
    proof?.schemaVersion === 1 &&
      proof.kind === "root-supplied-runtime-docker-cli" &&
      path === join(c.controlFoundationRoot, "runtime-tools/docker") &&
      proof.path === path &&
      /^sha256:[a-f0-9]{64}$/.test(proof.rawDigest || "") &&
      /^sha256:[a-f0-9]{64}$/.test(proof.sourceImageDigest || "") &&
      Number.isSafeInteger(proof.bytes) &&
      proof.bytes > 64 &&
      proof.bytes <= 128 * 1024 * 1024 &&
      digest(c.docker.args) ===
        digest(["--host", "unix:///var/run/docker.sock"]) &&
      mounts.some(
        (m) =>
          m.source === c.controlFoundationRoot &&
          m.destination === m.source &&
          m.rw === true,
      ) &&
      [
        ["/var/run/docker.sock", "/var/run/docker.sock", true],
        ["/proc", "/host/proc", false],
        ["/sys/fs/cgroup", "/host/cgroup", false],
      ].every(([source, destination, rw]) =>
        mounts.some(
          (m) =>
            m.source === source && m.destination === destination && m.rw === rw,
        ),
      ),
  );
  for (const folder of [
    c.controlFoundationRoot,
    join(c.controlFoundationRoot, "runtime-tools"),
  ]) {
    const s = await fs.lstat(folder);
    need(
      s.isDirectory() &&
        !s.isSymbolicLink() &&
        s.uid === 0 &&
        (s.mode & 0o022) === 0 &&
        (await fs.realpath(folder)) === folder,
    );
  }
  const handle = await fs
    .open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    .catch((error) => {
      if (error.code === "ENOENT")
        throw Object.assign(Error("Runtime Docker executable is missing"), {
          code: "CONTROL_RUNTIME_DOCKER_CLI_MISSING",
        });
      throw error;
    });
  let original;
  try {
    original = await handle.stat();
    need(
      original.isFile() &&
        original.uid === 0 &&
        original.gid === 0 &&
        original.nlink === 1 &&
        (original.mode & 0o777) === 0o755 &&
        original.size === proof.bytes &&
        (await fs.realpath(path)) === path,
    );
    const elf = Buffer.alloc(64);
    need(
      (await handle.read(elf, 0, 64, 0)).bytesRead === 64 &&
        elf.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) &&
        elf.readUInt16LE(18) === 183,
    );
    const offset = Number(elf.readBigUInt64LE(32)),
      size = elf.readUInt16LE(54),
      count = elf.readUInt16LE(56);
    need(
      Number.isSafeInteger(offset) &&
        size >= 56 &&
        count > 0 &&
        count <= 1024 &&
        offset + size * count <= original.size,
    );
    const headers = Buffer.alloc(size * count);
    need(
      (await handle.read(headers, 0, headers.length, offset)).bytesRead ===
        headers.length,
    );
    need(
      Array.from({ length: count }, (_, i) =>
        headers.readUInt32LE(i * size),
      ).every((type) => type !== 3),
    ); // no ELF interpreter
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
    }))
      hash.update(chunk);
    need("sha256:" + hash.digest("hex") === proof.rawDigest);
    const current = await handle.stat();
    need(
      [
        "dev",
        "ino",
        "size",
        "mtimeMs",
        "ctimeMs",
        "mode",
        "uid",
        "gid",
        "nlink",
      ].every((k) => current[k] === original[k]),
    );
  } finally {
    await handle.close();
  }
  need((await fs.lstat("/var/run/docker.sock")).isSocket());
  const version = (await run(path, ["--version"])).trim();
  need(/^Docker version [0-9][A-Za-z0-9., +_-]{1,100}$/.test(version));
  const after = await fs.lstat(path);
  need(
    [
      "dev",
      "ino",
      "size",
      "mtimeMs",
      "ctimeMs",
      "mode",
      "uid",
      "gid",
      "nlink",
    ].every((k) => after[k] === original[k]),
  );
  return {
    kind: proof.kind,
    path,
    rawDigest: proof.rawDigest,
    bytes: proof.bytes,
    sourceImageDigest: proof.sourceImageDigest,
    version,
    directoryMountWritable: mounts.some(
      (m) => path.startsWith(m.source + "/") && m.rw,
    ),
    tamperProof: false,
  };
}
