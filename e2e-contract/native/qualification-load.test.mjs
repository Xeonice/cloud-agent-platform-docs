import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { maximumMigrationReceipt } from "./qualification-load.mjs";

const require = createRequire(
  new URL("../../api/package.json", import.meta.url),
);
const Database = require("better-sqlite3");

// Real SQLite and the actual readonly evidence collector. Small projection
// fixtures prove collection/rejection semantics, not native maximum-load
// execution, HTTP population, signed admission or RuntimeOwner continuity.
function fixture(t) {
  const database = new Database(":memory:");
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE automations(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE upg_shadow_projects(row_key TEXT PRIMARY KEY,tombstone INTEGER,display_name TEXT);
    CREATE TABLE upg_shadow_automations(row_key TEXT PRIMARY KEY,tombstone INTEGER,display_name TEXT);
    CREATE TABLE upgrade_projection_changes(plan_digest TEXT,projection TEXT,projected INTEGER);
    CREATE TABLE __drizzle_migrations(id INTEGER);
    CREATE TABLE upgrade_online_migrations(attempt_id TEXT,plan_digest TEXT,plan TEXT,stage TEXT,checkpoint TEXT,completed_work INTEGER,read_epoch INTEGER,degraded INTEGER);
  `);
  const plan = {
    projections: ["projects", "automations"].map((sourceTable) => ({
      sourceTable,
      primaryKey: "id",
      targetTable: "upg_shadow_" + sourceTable,
      fields: [{ name: "display_name", type: "text", source: "name" }],
    })),
  };
  for (const source of ["projects", "automations"]) {
    for (const [id, value] of [
      ["first", "name first"],
      ["second", null],
    ]) {
      database.prepare(`INSERT INTO ${source} VALUES(?,?)`).run(id, value);
      database
        .prepare(`INSERT INTO upg_shadow_${source} VALUES(?,0,?)`)
        .run(id, value);
    }
    database
      .prepare(`INSERT INTO upg_shadow_${source} VALUES(?,1,?)`)
      .run("previously-deleted", "old name");
  }
  const checkpoint = { phase: "complete", projection: 0, cursor: null };
  database
    .prepare("INSERT INTO upgrade_online_migrations VALUES(?,?,?,?,?,?,?,?)")
    .run(
      "fixture-attempt",
      "fixture-plan",
      JSON.stringify(plan),
      "complete",
      JSON.stringify(checkpoint),
      4,
      1,
      0,
    );
  database.prepare("INSERT INTO __drizzle_migrations VALUES(?)").run(1);
  const load = {
    measuredRows: { projects: 2, automations: 2 },
    populatedViaPublicHttp: false,
    inputFingerprint: "state-fixture-only",
  };
  return {
    database,
    plan,
    checkpoint,
    load,
    receipt: () =>
      maximumMigrationReceipt({ database }, "fixture-attempt", load),
    savePlan: () =>
      database
        .prepare("UPDATE upgrade_online_migrations SET plan=?")
        .run(JSON.stringify(plan)),
  };
}

test("actual SQLite confirms complete live rows, equal NULL values and retained tombstones without changing any source data", (t) => {
  const f = fixture(t);
  const before = f.database.prepare("SELECT * FROM projects ORDER BY id").all();
  const receipt = f.receipt();
  assert.equal(receipt.populatedViaPublicHttp, false);
  assert.equal(receipt.actualDrizzleCount, 1);
  assert.deepEqual(receipt.phaseReceipts[0].checkpoint, f.checkpoint);
  assert.deepEqual(
    receipt.phaseReceipts[0].projections,
    ["projects", "automations"].map((sourceTable) => ({
      sourceTable,
      targetTable: "upg_shadow_" + sourceTable,
      rows: 2,
      pendingChanges: 0,
      missingRows: 0,
      phantomRows: 0,
      differences: 0,
    })),
  );
  assert.deepEqual(
    f.database.prepare("SELECT * FROM projects ORDER BY id").all(),
    before,
  );
});

test("equal cardinality cannot conceal one missing original row and one phantom live row", (t) => {
  const f = fixture(t);
  for (const source of ["projects", "automations"]) {
    f.database
      .prepare(
        `UPDATE upg_shadow_${source} SET row_key='phantom' WHERE row_key='first'`,
      )
      .run();
    assert.equal(
      f.database
        .prepare(
          `SELECT count(*) n FROM upg_shadow_${source} WHERE tombstone=0`,
        )
        .get().n,
      2,
    );
  }
  assert.throws(f.receipt, { code: "MAXIMUM_PROJECTION_DIFFERENCE" });
});

test("a tombstone cannot stand in for a still-live original row, even with a compensating phantom live row", (t) => {
  const f = fixture(t);
  f.database
    .prepare("UPDATE upg_shadow_projects SET tombstone=1 WHERE row_key='first'")
    .run();
  f.database
    .prepare("INSERT INTO upg_shadow_projects VALUES('phantom',0,'name first')")
    .run();
  assert.throws(f.receipt, { code: "MAXIMUM_PROJECTION_DIFFERENCE" });
});

test("tombstones alone cannot satisfy the maximum live-row count", (t) => {
  const f = fixture(t);
  f.database.prepare("UPDATE upg_shadow_projects SET tombstone=1").run();
  assert.throws(f.receipt, { code: "MAXIMUM_PROJECTION_COUNT_CHANGED" });
});

test("unsupported primary keys are refused before evidence uses an assumed id join", (t) => {
  const f = fixture(t);
  f.plan.projections[0].primaryKey = "another_key";
  f.savePlan();
  assert.throws(f.receipt, { code: "MAXIMUM_PROJECTION_REQUIRED" });
});

test("changed original cardinality cannot be concealed by an unchanged shadow count", (t) => {
  const f = fixture(t);
  f.database.prepare("DELETE FROM projects WHERE id='first'").run();
  assert.throws(f.receipt, { code: "MAXIMUM_SOURCE_COUNT_CHANGED" });
});

test("different projected values and unprojected durable changes are rejected", (t) => {
  const f = fixture(t);
  f.database
    .prepare(
      "UPDATE upg_shadow_projects SET display_name='wrong' WHERE row_key='first'",
    )
    .run();
  assert.throws(f.receipt, { code: "MAXIMUM_PROJECTION_DIFFERENCE" });
  f.database
    .prepare(
      "UPDATE upg_shadow_projects SET display_name='name first' WHERE row_key='first'",
    )
    .run();
  f.database
    .prepare(
      "INSERT INTO upgrade_projection_changes VALUES('fixture-plan','upg_shadow_projects',0)",
    )
    .run();
  assert.throws(f.receipt, { code: "MAXIMUM_PROJECTION_PENDING" });
});

test("empty field mappings and an unconfirmed migration phase cannot emit completion receipts", (t) => {
  const f = fixture(t);
  f.plan.projections[0].fields = [];
  f.savePlan();
  assert.throws(f.receipt, { code: "MAXIMUM_PROJECTION_MAPPING_REQUIRED" });
  f.database
    .prepare("UPDATE upgrade_online_migrations SET stage='backfill'")
    .run();
  assert.throws(f.receipt, { code: "MAXIMUM_MIGRATION_NOT_CONFIRMED" });
});
