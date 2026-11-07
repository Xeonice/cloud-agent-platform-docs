import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../test-support/control-migration-fixtures.mjs";
import { createClosedBusinessReadView, probeClosedBusinessReadView } from "./closed-business-read-view.mjs";

const sha = async path => createHash("sha256").update(await fs.readFile(path)).digest("hex");
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "closed-business-view-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "business"), { mode: 0o700 });
  await fs.mkdir(join(root, "operator"), { mode: 0o700 });
  const businessPath = join(root, "business", "platform.db"), db = new Database(businessPath);
  db.pragma("journal_mode=WAL");
  db.exec("CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES('last-committed')");
  db.close();
  return { root, businessPath, directory: join(root, "operator", "view"), Database, scope: { instanceId: "instance", migrationId: "original", configDigest: "frozen", phase: "final-source" }, assertClosed: async () => {} };
}
test("real last SQLite close leaves no WAL/SHM; derived DELETE view preserves rows without changing source, and reuses the exact receipt", async t => {
  const f = await fixture(t), before = await sha(f.businessPath);
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(fs.stat(f.businessPath + suffix), { code: "ENOENT" });
  const view = await createClosedBusinessReadView(f), reader = new Database(view.path, { readonly: true });
  try { assert.equal(reader.pragma("journal_mode", { simple: true }), "delete"); assert.equal(reader.prepare("SELECT value FROM facts").get().value, "last-committed"); }
  finally { reader.close(); }
  assert.equal(await sha(f.businessPath), before);
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(fs.stat(f.businessPath + suffix), { code: "ENOENT" });
  assert.deepEqual(await createClosedBusinessReadView(f), view);
});
test("before-stop probe exercises the closed-WAL path and accounts for two source-sized copies before any authority callback", async t => {
  const f = await fixture(t), result = await probeClosedBusinessReadView({ ...f, directory: join(f.root, "operator"), minFreeBytes: 12345 });
  assert.equal(result.closedWalProbe, "passed");
  assert.equal(result.requiredBytes, 2 * result.sourceBytes + 12345);
  assert.equal(result.reservedCopies, 2);
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});
test("authority rejects a live/unknown writer before source copying", async t => {
  const f = await fixture(t);
  await assert.rejects(createClosedBusinessReadView({ ...f, assertClosed: async () => { throw new Error("writer-live"); } }), /writer-live/);
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});
test("changed original source or view scope cannot reuse a prior snapshot", async t => {
  const f = await fixture(t); await createClosedBusinessReadView(f);
  await assert.rejects(createClosedBusinessReadView({ ...f, scope: { ...f.scope, configDigest: "changed" } }), /READ_VIEW_RECEIPT_CHANGED/);
  const db = new Database(f.businessPath); db.exec("INSERT INTO facts VALUES('new-writer')"); db.close();
  await assert.rejects(createClosedBusinessReadView(f), /READ_VIEW_SOURCE_CHANGED/);
});
test("a symlink substituted for a completed view is refused even if the bytes match", async t => {
  const f = await fixture(t), view = await createClosedBusinessReadView(f), other = join(f.root, "copied.db");
  await fs.copyFile(view.path, other); await fs.unlink(view.path); await fs.symlink(other, view.path);
  await assert.rejects(createClosedBusinessReadView(f), /READ_VIEW_FILE_CHANGED/);
});
