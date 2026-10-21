import * as fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { canonical, digest, invariant } from "./trust.mjs";

const absent = async (path) => {
  try { await fs.lstat(path); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
};
const metadata = (s) => ({ dev: String(s.dev), ino: String(s.ino), bytes: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const same = (a, b) => canonical(a) === canonical(b);
async function regular(path) {
  const s = await fs.lstat(path);
  invariant(s.isFile() && !s.isSymbolicLink() && await fs.realpath(path) === resolve(path), "CONTROL_MIGRATION_READ_VIEW_FILE_CHANGED");
  return metadata(s);
}
async function hash(path) {
  const h = createHash("sha256");
  for await (const bytes of createReadStream(path)) h.update(bytes);
  return "sha256:" + h.digest("hex");
}
async function sourceFiles(path) {
  const rows = [{ path, name: "view.db", ...await regular(path) }];
  if (!await absent(path + "-wal")) rows.push({ path: path + "-wal", name: "view.db-wal", ...await regular(path + "-wal") });
  // SHM is a rebuildable index, never source data and never copied or created here.
  if (!await absent(path + "-shm")) await regular(path + "-shm");
  return rows;
}
async function privateDirectory(path) {
  const s = await fs.lstat(path);
  invariant(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0 && await fs.realpath(path) === resolve(path), "CONTROL_MIGRATION_READ_VIEW_PRIVATE_DIRECTORY_REQUIRED");
}
async function syncDirectory(path) {
  const h = await fs.open(path, "r");
  try { await h.sync(); } finally { await h.close(); }
}
async function copySource(row, target) {
  const source = await fs.open(row.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    output = await fs.open(target, "wx", 0o600), h = createHash("sha256");
  try {
    const initial = metadata(await source.stat());
    invariant(same(initial, Object.fromEntries(Object.keys(initial).map(k => [k, row[k]]))), "CONTROL_MIGRATION_READ_VIEW_SOURCE_CHANGED");
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const bytes = buffer.subarray(0, bytesRead); h.update(bytes);
      let offset = 0;
      while (offset < bytesRead) offset += (await output.write(bytes, offset, bytesRead - offset, null)).bytesWritten;
    }
    await output.sync();
    invariant(same(metadata(await source.stat()), await regular(row.path)), "CONTROL_MIGRATION_READ_VIEW_SOURCE_CHANGED");
    return "sha256:" + h.digest("hex");
  } finally { await source.close(); await output.close(); }
}
async function checkSource(path, expected) {
  const actual = await sourceFiles(path);
  invariant(same(actual, expected.map(({ sha256, ...row }) => row)), "CONTROL_MIGRATION_READ_VIEW_SOURCE_CHANGED");
  for (const row of expected) invariant(await hash(row.path) === row.sha256, "CONTROL_MIGRATION_READ_VIEW_SOURCE_CHANGED");
}

/** The real database is read through file descriptors only. SQLite recovery and
 * journal-mode changes occur exclusively on an owned copy after all writers stop. */
export async function createClosedBusinessReadView({ Database, businessPath, directory, scope, assertClosed, clock = Date.now }) {
  invariant(typeof assertClosed === "function" && resolve(directory) === directory && resolve(businessPath) === businessPath && !directory.startsWith(dirname(businessPath) + "/"), "CONTROL_MIGRATION_READ_VIEW_SCOPE_REQUIRED");
  await privateDirectory(dirname(directory));
  await assertClosed();
  const receiptPath = join(directory, "receipt.json"), viewPath = join(directory, "view.db");
  if (!await absent(directory)) {
    await privateDirectory(directory);
    const s = await fs.lstat(receiptPath);
    invariant(s.isFile() && !s.isSymbolicLink() && s.size <= 65536 && (s.mode & 0o077) === 0, "CONTROL_MIGRATION_READ_VIEW_RECEIPT_REQUIRED");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")), { receiptDigest, ...facts } = receipt;
    invariant(receiptDigest === digest(facts) && same(receipt.scope, scope) && receipt.source.path === businessPath && receipt.snapshot.path === viewPath, "CONTROL_MIGRATION_READ_VIEW_RECEIPT_CHANGED");
    await checkSource(businessPath, receipt.source.files);
    await regular(viewPath);
    const snapshot = await fs.lstat(viewPath);
    invariant(snapshot.uid === process.getuid() && (snapshot.mode & 0o077) === 0 && await hash(viewPath) === receipt.snapshot.sha256, "CONTROL_MIGRATION_READ_VIEW_BYTES_CHANGED");
    await assertClosed();
    return { path: viewPath, receipt };
  }
  const work = await fs.mkdtemp(directory + ".pending-");
  try {
    const files = await sourceFiles(businessPath);
    for (const row of files) row.sha256 = await copySource(row, join(work, row.name));
    await assertClosed();
    await checkSource(businessPath, files);
    // A leftover WAL contains committed rows. Opening only the copy normally
    // replays it; immutable mode against the live/original file is never used.
    const db = new Database(join(work, "view.db"), { fileMustExist: true });
    try {
      db.pragma("busy_timeout=50");
      invariant(db.pragma("journal_mode=DELETE", { simple: true }) === "delete", "CONTROL_MIGRATION_READ_VIEW_JOURNAL_UNKNOWN");
      invariant(db.pragma("quick_check", { simple: true }) === "ok", "CONTROL_MIGRATION_READ_VIEW_CORRUPT");
    } finally { db.close(); }
    invariant(await absent(join(work, "view.db-wal")) && await absent(join(work, "view.db-shm")), "CONTROL_MIGRATION_READ_VIEW_NOT_CLOSED");
    await fs.chmod(join(work, "view.db"), 0o400);
    const reader = new Database(join(work, "view.db"), { readonly: true, fileMustExist: true });
    try { reader.pragma("query_only=ON"); reader.prepare("SELECT count(*) FROM sqlite_master").get(); }
    finally { reader.close(); }
    await assertClosed(); await checkSource(businessPath, files);
    const facts = { schemaVersion: 1, kind: "closed-business-read-view", scope, source: { path: businessPath, files }, snapshot: { path: viewPath, sha256: await hash(join(work, "view.db")), bytes: (await fs.stat(join(work, "view.db"))).size, journalMode: "delete" }, recordedAt: clock() },
      receipt = { ...facts, receiptDigest: digest(facts) }, out = await fs.open(join(work, "receipt.json"), "wx", 0o600);
    try { await out.writeFile(canonical(receipt) + "\n"); await out.sync(); } finally { await out.close(); }
    await syncDirectory(work);
    invariant(await absent(directory), "CONTROL_MIGRATION_READ_VIEW_ALREADY_PUBLISHED");
    await fs.rename(work, directory); await syncDirectory(dirname(directory));
    return { path: viewPath, receipt };
  } catch (error) {
    // Only this invocation's new private directory is removable; never source files.
    await fs.rm(work, { recursive: true, force: true }); throw error;
  }
}

export async function verifyClosedBusinessReadView({ Database, businessPath, view, assertClosed }) {
  invariant(view?.receipt?.snapshot?.path === view.path && !await absent(dirname(view.path)), "CONTROL_MIGRATION_READ_VIEW_RECEIPT_REQUIRED");
  const actual = await createClosedBusinessReadView({ Database, businessPath, directory: dirname(view.path), scope: view.receipt.scope, assertClosed });
  invariant(actual.receipt.receiptDigest === view.receipt.receiptDigest, "CONTROL_MIGRATION_READ_VIEW_RECEIPT_CHANGED");
  return actual;
}

/** Runs before any stop: exercise the exact closed-WAL copy/DELETE/RO path with
 * this native addon and check the real source can be read and the target has space. */
export async function probeClosedBusinessReadView({ Database, businessPath, directory, scope, minFreeBytes = 0 }) {
  await privateDirectory(directory);
  invariant(Number.isSafeInteger(minFreeBytes) && minFreeBytes >= 0, "CONTROL_MIGRATION_READ_VIEW_DISK_POLICY_REQUIRED");
  const files = await sourceFiles(businessPath), sourceBytes = files.reduce((n, f) => n + f.bytes, 0),
    requiredBytes = sourceBytes * 2 + minFreeBytes, space = await fs.statfs(directory, { bigint: true });
  invariant(BigInt(requiredBytes) < space.bavail * space.bsize, "CONTROL_MIGRATION_READ_VIEW_DISK_SHORTAGE");
  const probe = await fs.mkdtemp(join(directory, "read-view-probe-"));
  try {
    await fs.mkdir(join(probe, "source"), { mode: 0o700 });
    const path = join(probe, "source", "source.db"), db = new Database(path);
    try { db.pragma("journal_mode=WAL"); db.exec("CREATE TABLE probe(n INTEGER); INSERT INTO probe VALUES(937)"); }
    finally { db.close(); }
    invariant(await absent(path + "-wal") && await absent(path + "-shm"), "CONTROL_MIGRATION_READ_VIEW_PROBE_NOT_CLOSED");
    const view = await createClosedBusinessReadView({ Database, businessPath: path, directory: join(probe, "result"), scope, assertClosed: async () => {} }), reader = new Database(view.path, { readonly: true, fileMustExist: true });
    try { invariant(reader.prepare("SELECT n FROM probe").get().n === 937, "CONTROL_MIGRATION_READ_VIEW_PROBE_FAILED"); }
    finally { reader.close(); }
    return { kind: "closed-business-read-view-preflight", scopeDigest: digest(scope), sourceIdentity: files.map(({ path, name, ...file }) => file), sourceBytes, reservedCopies: 2, minFreeBytes, requiredBytes, availableBytes: String(space.bavail * space.bsize), closedWalProbe: "passed" };
  } finally { await fs.rm(probe, { recursive: true, force: true }); }
}
