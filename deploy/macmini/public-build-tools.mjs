import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";

export const VERCEL_SOURCE = "/Users/Shared/agent-platform-build-tools/vercel";
export const VERCEL_DESTINATION =
  "/Library/Application Support/AgentPlatform/vercel";
export const VERCEL_VERSION = "62.2.0";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inside = (base, path) => path === base || path.startsWith(`${base}/`);
const safeRelative = (path) =>
  typeof path === "string" &&
  path !== "" &&
  !path.startsWith("/") &&
  path.split("/").every((part) => part && part !== "." && part !== "..") &&
  !/[\x00-\x1f\\]/.test(path);

async function regular(path, uid, publicNpmSource = false) {
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      (!publicNpmSource && stat.nlink !== 1) ||
      stat.size > 256 * 1024 * 1024
    )
      throw new Error("Unsafe public build-tool file");
    return {
      bytes: await file.readFile(),
      mode: stat.mode & 0o111 ? 0o755 : 0o644,
      permissions: stat.mode & 0o7777,
    };
  } finally {
    await file.close();
  }
}

// The root installer receives a complete reviewed snapshot of the pinned public
// npm distribution, never runs npm or package lifecycle code with privileges.
export async function prepareVercel(source, review, uid = 501) {
  if (source !== VERCEL_SOURCE)
    throw new Error("Unexpected Vercel distribution source");
  review = await fs.realpath(review);
  const root = join(review, "vercel");
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.uid !== uid)
    throw new Error("Unsafe Vercel source directory");
  const packageValue = JSON.parse(
    (await regular(join(source, "node_modules/vercel/package.json"), uid))
      .bytes,
  );
  if (packageValue.name !== "vercel" || packageValue.version !== VERCEL_VERSION)
    throw new Error("Vercel distribution is not the reviewed version");
  await fs.mkdir(root, { mode: 0o700 });
  const entries = {};
  let bytes = 0;
  let count = 0;
  async function walk(path) {
    for (const name of (await fs.readdir(path)).sort()) {
      const next = join(path, name),
        key = relative(source, next);
      if (!safeRelative(key) || ++count > 50_000)
        throw new Error("Invalid/oversized Vercel distribution");
      const stat = await fs.lstat(next);
      if (stat.uid !== uid)
        throw new Error("Vercel source has unexpected ownership");
      if (stat.isDirectory()) {
        entries[key] = { type: "directory" };
        await fs.mkdir(join(root, key), { mode: 0o700 });
        await walk(next);
      } else if (stat.isSymbolicLink()) {
        const target = await fs.readlink(next);
        if (
          !inside(source, resolve(dirname(next), target)) ||
          !inside(source, await fs.realpath(next))
        )
          throw new Error("Vercel distribution link escapes its tree");
        entries[key] = { type: "symlink", target };
        await fs.symlink(target, join(root, key));
      } else {
        const file = await regular(next, uid, true);
        bytes += file.bytes.length;
        if (bytes > 600 * 1024 * 1024)
          throw new Error("Vercel distribution exceeds reviewed size limit");
        entries[key] = {
          type: "file",
          sha256: hash(file.bytes),
          bytes: file.bytes.length,
          mode: file.mode,
        };
        await fs.writeFile(join(root, key), file.bytes, {
          flag: "wx",
          mode: 0o600,
        });
      }
    }
  }
  await walk(source);
  return {
    version: VERCEL_VERSION,
    destination: VERCEL_DESTINATION,
    bytes,
    entries,
  };
}

export async function verifyVercel(review, manifest, uid = 501) {
  if (
    !manifest ||
    manifest.version !== VERCEL_VERSION ||
    manifest.destination !== VERCEL_DESTINATION ||
    !manifest.entries ||
    Object.keys(manifest.entries).length > 50_000
  )
    throw new Error("Invalid fixed public CLI review");
  const root = join(await fs.realpath(review), "vercel");
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.uid !== uid || rootStat.mode & 0o077)
    throw new Error("Unsafe public CLI review directory");
  const observed = [];
  async function walk(path) {
    for (const name of await fs.readdir(path)) {
      const next = join(path, name),
        key = relative(root, next),
        expected = manifest.entries[key];
      if (!safeRelative(key) || !expected)
        throw new Error("Unreviewed CLI entry");
      observed.push(key);
      const stat = await fs.lstat(next);
      if (stat.uid !== uid) throw new Error("Reviewed CLI ownership changed");
      if (expected.type === "directory") {
        if (!stat.isDirectory() || stat.mode & 0o077)
          throw new Error("Unsafe reviewed CLI directory");
        await walk(next);
      } else if (expected.type === "symlink") {
        if (
          !stat.isSymbolicLink() ||
          (await fs.readlink(next)) !== expected.target ||
          !inside(root, resolve(dirname(next), expected.target)) ||
          !inside(root, await fs.realpath(next))
        )
          throw new Error("Reviewed CLI symlink changed");
      } else if (expected.type === "file") {
        const file = await regular(next, uid);
        if (
          stat.mode & 0o077 ||
          file.bytes.length !== expected.bytes ||
          hash(file.bytes) !== expected.sha256 ||
          ![0o644, 0o755].includes(expected.mode)
        )
          throw new Error("Reviewed CLI bytes changed");
      } else throw new Error("Invalid reviewed CLI entry type");
    }
  }
  await walk(root);
  if (
    observed.length !== Object.keys(manifest.entries).length ||
    !manifest.entries["node_modules/vercel/dist/index.js"]
  )
    throw new Error("Incomplete reviewed CLI distribution");
}

// Read-only verifier shared by root installation and temporary, unprivileged
// regression fixtures. Only installVercel can mutate the fixed public destination.
export async function verifyPublicVercelTree(root, manifest, uid = 0) {
  if (
    !manifest ||
    manifest.version !== VERCEL_VERSION ||
    manifest.destination !== VERCEL_DESTINATION ||
    !manifest.entries ||
    Array.isArray(manifest.entries) ||
    Object.keys(manifest.entries).length > 50_000 ||
    !manifest.entries["node_modules/vercel/dist/index.js"]
  )
    throw new Error("Invalid fixed public CLI review");
  const rootStat = await fs.lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.uid !== uid ||
    (rootStat.mode & 0o7777) !== 0o755 ||
    (await fs.realpath(root)) !== resolve(root)
  )
    throw new Error(
      "Installed public CLI must be a root-owned fixed directory",
    );
  let observed = 0;
  async function walk(path) {
    for (const name of await fs.readdir(path)) {
      const next = join(path, name),
        key = relative(root, next),
        expected = manifest.entries[key];
      if (!safeRelative(key) || !expected)
        throw new Error("Unreviewed installed CLI entry");
      observed++;
      const stat = await fs.lstat(next);
      if (stat.uid !== uid) throw new Error("Installed CLI ownership differs");
      if (expected.type === "directory") {
        if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o755)
          throw new Error("Installed CLI directory permissions differ");
        await walk(next);
      } else if (expected.type === "symlink") {
        if (
          !stat.isSymbolicLink() ||
          (await fs.readlink(next)) !== expected.target ||
          !inside(root, resolve(dirname(next), expected.target)) ||
          !inside(root, await fs.realpath(next))
        )
          throw new Error("Installed CLI symlink differs");
      } else if (expected.type === "file") {
        const file = await regular(next, uid);
        if (
          ![0o644, 0o755].includes(expected.mode) ||
          file.permissions !== expected.mode ||
          file.bytes.length !== expected.bytes ||
          hash(file.bytes) !== expected.sha256
        )
          throw new Error("Installed CLI bytes or permissions differ");
      } else throw new Error("Invalid installed CLI entry type");
    }
  }
  await walk(root);
  if (observed !== Object.keys(manifest.entries).length)
    throw new Error("Installed CLI distribution is incomplete");
}

export async function installVercel(review, manifest, rootDirectory) {
  if (process.getuid() !== 0)
    throw new Error(
      "Public CLI installation requires administrator authentication",
    );
  await verifyVercel(review, manifest);
  const target = VERCEL_DESTINATION;
  await rootDirectory(dirname(target));
  const installed = await fs.lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (installed) {
    await verifyPublicVercelTree(target, manifest);
    return { state: "reused", destination: target };
  }
  const staging = `${target}.${randomUUID()}.installing`;
  await fs.mkdir(staging, { mode: 0o755 });
  await fs.chmod(staging, 0o755);
  try {
    for (const [key, entry] of Object.entries(manifest.entries)) {
      const path = join(staging, key);
      if (entry.type === "directory") {
        await fs.mkdir(path, { mode: 0o755 });
        await fs.chmod(path, 0o755);
      } else if (entry.type === "symlink") await fs.symlink(entry.target, path);
      else {
        // Re-read and check the same buffer that is installed. A modified review
        // cannot exploit the time between the preflight and copy.
        const file = await regular(join(review, "vercel", key), 501);
        if (
          hash(file.bytes) !== entry.sha256 ||
          file.bytes.length !== entry.bytes
        )
          throw new Error("CLI snapshot changed during installation");
        await fs.writeFile(path, file.bytes, { flag: "wx", mode: entry.mode });
        await fs.chmod(path, entry.mode);
      }
    }
    await fs.rename(staging, target);
    await verifyPublicVercelTree(target, manifest);
    return { state: "installed", destination: target };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
