import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  cleanupQualificationSdkImages,
  qualifyBusinessCleanup,
} from "../../e2e-contract/server/qualification-sdk-cache.mjs";

const Database = createRequire(
  new URL("../../api/package.json", import.meta.url),
)("better-sqlite3");
const activeTables = [
  "sandboxes",
  "projects",
  "agent_tasks",
  "automation_runs",
  "automation_launch_intents",
  "automations",
  "terminal_bookmarks",
  "retained_volumes",
  "sandbox_project_cleanup_jobs",
];

// Actual files and readonly SQLite connections prove the evidence collector;
// these small fixtures do not qualify Docker isolation, SDK or native workloads.
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "upg-history-proof-"));
  const paths = Object.fromEntries(
    ["business", "journal", "sdk"].map((name) => [
      name,
      join(root, name + ".sqlite"),
    ]),
  );
  const business = new Database(paths.business),
    journal = new Database(paths.journal),
    sdk = new Database(paths.sdk);
  for (const table of activeTables)
    business.exec("CREATE TABLE " + table + "(id TEXT PRIMARY KEY)");
  business.exec(
    "CREATE TABLE agent_task_start_intents(task_id TEXT PRIMARY KEY,sandbox_id TEXT NOT NULL,provider TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL)",
  );
  journal.exec(
    "CREATE TABLE owner_assignments(sandbox_id TEXT PRIMARY KEY,provider TEXT NOT NULL,provider_id TEXT NOT NULL,state TEXT NOT NULL)",
  );
  sdk.exec(
    "CREATE TABLE box_config(id TEXT PRIMARY KEY); CREATE TABLE box_state(id TEXT PRIMARY KEY)",
  );
  for (let i = 1; i <= 2; i++) {
    const payload = {
      version: 1,
      operation: { operationId: "agent-task-task-" + i },
      handle: {
        provider: "boxlite",
        providerSandboxId: "native-" + i,
        providerState: {
          runtimeOwner: {
            ownerId: "original-owner",
            sandboxId: "sandbox-" + i,
          },
        },
      },
      spec: {
        env: { EXAMPLE_PRIVATE_KEY: "fixture-secret-must-not-enter-receipts" },
      },
    };
    business
      .prepare("INSERT INTO agent_task_start_intents VALUES(?,?,?,?,?,?)")
      .run(
        "task-" + i,
        "sandbox-" + i,
        "boxlite",
        JSON.stringify(payload),
        "complete",
        i,
      );
    journal
      .prepare("INSERT INTO owner_assignments VALUES(?,?,?,?)")
      .run("sandbox-" + i, "boxlite", "native-" + i, "destroyed");
  }
  business.close();
  journal.close();
  sdk.close();
  const opened = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      db.exec("PRAGMA query_only=ON");
      return [name, db];
    }),
  );
  t.after(() => {
    for (const db of Object.values(opened)) db.close();
    fs.rmSync(root, { recursive: true });
  });
  const owners = [
    { ownerId: "original-owner", journal: opened.journal, sdk: opened.sdk },
  ];
  return {
    ...opened,
    owners,
    qualify: (proofs = owners) =>
      qualifyBusinessCleanup(opened.business, proofs),
    bytes: () =>
      Object.fromEntries(
        Object.entries(paths).map(([name, path]) => [
          name,
          fs.readFileSync(path),
        ]),
      ),
    rows: () =>
      opened.business
        .prepare("SELECT * FROM agent_task_start_intents ORDER BY task_id")
        .all(),
    change(name, sql, ...args) {
      const db = new Database(paths[name]);
      try {
        db.prepare(sql).run(...args);
      } finally {
        db.close();
      }
    },
  };
}

test("actual SQLite preserves two closed intents byte-for-byte with exact destroyed Owner and SDK absence proof", (t) => {
  const f = fixture(t),
    before = f.bytes(),
    rows = f.rows(),
    receipt = f.qualify();
  assert.deepEqual(receipt.businessCounts, {
    ...Object.fromEntries(activeTables.map((table) => [table, 0])),
    agent_task_start_intents: 2,
  });
  assert.deepEqual(receipt.startIntentHistory, {
    total: 2,
    complete: 2,
    pending: 0,
    parentsAbsent: true,
    preservedAsIdempotencyHistory: true,
    closureDigest: receipt.startIntentHistory.closureDigest,
  });
  assert.match(
    receipt.startIntentHistory.closureDigest,
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.deepEqual(f.bytes(), before);
  assert.deepEqual(f.rows(), rows);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /fixture-secret|native-1|sandbox-1|task-1|EXAMPLE_PRIVATE_KEY|payload/,
  );
  assert.deepEqual(f.qualify(), receipt);
});

test("actual pending and unknown intents remain unchanged and block cleanup despite destroyed assignments", (t) => {
  for (const state of ["pending", "unknown"]) {
    const f = fixture(t);
    f.change(
      "business",
      "UPDATE agent_task_start_intents SET state=? WHERE task_id=?",
      state,
      "task-1",
    );
    const before = f.bytes();
    assert.throws(f.qualify, { code: "QA_BUSINESS_CLEANUP_NOT_COMPLETE" });
    assert.deepEqual(f.bytes(), before);
  }
});

test("each of the original nine live tables still blocks cleanup, including surviving task and sandbox parents", (t) => {
  for (const table of activeTables) {
    const f = fixture(t);
    f.change(
      "business",
      "INSERT INTO " + table + " VALUES(?)",
      table === "sandboxes"
        ? "sandbox-1"
        : table === "agent_tasks"
          ? "task-1"
          : "live-row",
    );
    assert.throws(f.qualify, { code: "QA_BUSINESS_CLEANUP_NOT_COMPLETE" });
  }
});

test("missing, wrong and ambiguous original Owner evidence never closes history", (t) => {
  const f = fixture(t);
  for (const proofs of [
    [],
    [{ ...f.owners[0], ownerId: "other-owner" }],
    [{ ...f.owners[0], sdk: null }],
    [f.owners[0], f.owners[0]],
  ]) {
    assert.throws(() => f.qualify(proofs), {
      code: "QA_HISTORY_OWNER_PROOF_UNKNOWN",
    });
  }
});

test("only exact provider, native ID and sandbox ID destroyed assignments qualify", (t) => {
  for (const [sql, args] of [
    [
      "UPDATE owner_assignments SET state=? WHERE sandbox_id=?",
      ["owned", "sandbox-1"],
    ],
    [
      "UPDATE owner_assignments SET provider=? WHERE sandbox_id=?",
      ["other-provider", "sandbox-1"],
    ],
    [
      "UPDATE owner_assignments SET provider_id=? WHERE sandbox_id=?",
      ["different-native", "sandbox-1"],
    ],
    [
      "UPDATE owner_assignments SET sandbox_id=? WHERE sandbox_id=?",
      ["different-sandbox", "sandbox-1"],
    ],
    ["DELETE FROM owner_assignments WHERE sandbox_id=?", ["sandbox-1"]],
  ]) {
    const f = fixture(t);
    f.change("journal", sql, ...args);
    assert.throws(f.qualify, {
      code: "QA_HISTORY_OWNER_DESTRUCTION_UNCONFIRMED",
    });
  }
});

test("an actual remaining SDK config or orphan state prevents closure even with an Owner destroyed tombstone", (t) => {
  for (const table of ["box_config", "box_state"]) {
    const f = fixture(t);
    f.change("sdk", "INSERT INTO " + table + " VALUES(?)", "native-1");
    assert.throws(f.qualify, { code: "QA_HISTORY_SDK_BOX_REMAINS" });
  }
});

test("malformed, absent, mismatched and unsupported original handle scopes do not get inferred", (t) => {
  for (const mutate of [
    (payload) => {
      payload.handle.providerSandboxId = "";
    },
    (payload) => {
      payload.handle.provider = "other";
    },
    (payload) => {
      payload.handle.providerState.runtimeOwner.sandboxId = "sandbox-2";
    },
    (payload) => {
      delete payload.handle.providerState.runtimeOwner;
    },
    (payload) => {
      payload.operation.operationId = "another-operation";
    },
    () => null,
    () => "malformed-json",
  ]) {
    const f = fixture(t),
      payload = JSON.parse(f.rows()[0].payload),
      replacement = mutate(payload);
    f.change(
      "business",
      "UPDATE agent_task_start_intents SET payload=? WHERE task_id=?",
      replacement === "malformed-json"
        ? "{invalid"
        : JSON.stringify(replacement === null ? null : payload),
      "task-1",
    );
    assert.throws(f.qualify, { code: "QA_HISTORY_HANDLE_UNCONFIRMED" });
  }
});

test("absence of history needs no invented Owner closure and still keeps all nine business gates", (t) => {
  const f = fixture(t);
  f.change("business", "DELETE FROM agent_task_start_intents");
  assert.deepEqual(f.qualify([]).startIntentHistory, {
    total: 0,
    complete: 0,
    pending: 0,
    parentsAbsent: true,
    preservedAsIdempotencyHistory: true,
    closureDigest: f.qualify([]).startIntentHistory.closureDigest,
  });
});

test("SDK cache cleanup leaves failed cases untouched even with the option enabled", async () => {
  assert.deepEqual(
    await cleanupQualificationSdkImages({ cleanupSdkImagesOnSuccess: true }),
    { preserved: true },
  );
});
test("SDK cache cleanup requires an explicit boolean opt-in on successful cases", async () => {
  for (const input of [
    {},
    { cleanupSdkImagesOnSuccess: false },
    { cleanupSdkImagesOnSuccess: "true" },
  ]) {
    assert.deepEqual(
      await cleanupQualificationSdkImages(input, { resourcesCleaned: true }),
      { preserved: true },
    );
  }
});
test("SDK cache cleanup rejects a production domain before any filesystem or command effect", async () => {
  for (const input of [
    {
      isolated: false,
      docker: { dedicated: true },
      instanceId: "upgrade-acceptance-unit",
    },
    {
      isolated: true,
      docker: { dedicated: false },
      instanceId: "upgrade-acceptance-unit",
    },
    { isolated: true, docker: { dedicated: true }, instanceId: "production" },
  ])
    await assert.rejects(
      cleanupQualificationSdkImages(
        { ...input, cleanupSdkImagesOnSuccess: true },
        { resourcesCleaned: true },
      ),
      (error) => error.code === "DEDICATED_QA_CACHE_CLEANUP_REQUIRED",
    );
});
test("SDK cache cleanup rejects a non-QA path or unpinned image without opening a database", async () => {
  const base = {
    cleanupSdkImagesOnSuccess: true,
    isolated: true,
    instanceId: "upgrade-acceptance-unit",
    root: "/tmp/upg-qa-test-work/case",
    docker: { dedicated: true, args: [], image: "sha256:" + "a".repeat(64) },
  };
  for (const input of [
    { ...base, root: "/tmp/production" },
    { ...base, docker: { ...base.docker, image: "latest" } },
    { ...base, root: "/tmp/upg-qa-test-work/case/../other" },
  ]) {
    await assert.rejects(
      cleanupQualificationSdkImages(input, { resourcesCleaned: true }),
      (error) =>
        error.code ===
        (process.platform === "linux" && process.arch === "arm64"
          ? "FIXED_QA_CACHE_SCOPE_REQUIRED"
          : "DEDICATED_QA_CACHE_CLEANUP_REQUIRED"),
    );
  }
});
