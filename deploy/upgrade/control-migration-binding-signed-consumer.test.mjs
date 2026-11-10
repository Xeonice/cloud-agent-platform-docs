import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire, Module } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationCoordinatorBinding } from "./control-migration-runtime.mjs";
import { atomicJson } from "./io.mjs";

const fixtures = fileURLToPath(new URL("../test-support/signed-consumers/", import.meta.url));
const apiRequire = createRequire(resolve("api/apps/api/package.json"));

// Execute the original signed CommonJS bytes. Only dependency resolution is
// adapted to this test checkout; neither the schema nor resolver is recreated.
async function originalSignedResolver() {
  const lineage = JSON.parse(await fs.readFile(join(fixtures, "a8deefe2-lineage.json"), "utf8"));
  assert.equal(lineage.archiveDigest, "sha256:a8deefe20db1bab43761c6f95c716e31b777662c5fdf7393bea1628f519df947");
  assert.equal(lineage.apiComponentDigest, "sha256:134ed8f0bd54a58caba698b251d266d4f4a2851888bc58894db31f2b3834b805");
  assert.equal(lineage.zodVersion, "3.25.76");
  assert.equal(apiRequire("zod/package.json").version, "3.25.76");
  assert.deepEqual(lineage.files, [
    {
      file: "a8deefe2-coordinator-routing.cjs",
      archiveMember: "api/apps/api/dist/platform/control-rpc/coordinator-routing.js",
      rawDigest: "sha256:07a261b04b9f6cee2ed134dd81ee728e00448f8c9b8fab1b08c065073e4573bc",
      bytes: 2578,
    },
    {
      file: "a8deefe2-system-clock.cjs",
      archiveMember: "api/apps/api/dist/platform/time/system-clock.js",
      rawDigest: "sha256:6a7632ae4aae7666223dab98c78874a4c33e5659d0caf991efca807a6ac2a1c6",
      bytes: 1165,
    },
  ]);
  async function load(file, overrides = {}) {
    const pin = lineage.files.find(row => row.file === file);
    assert.ok(pin);
    const filename = join(fixtures, file), bytes = await fs.readFile(filename);
    assert.equal(bytes.length, pin.bytes);
    assert.equal("sha256:" + createHash("sha256").update(bytes).digest("hex"), pin.rawDigest);
    const module = new Module(filename);
    module.filename = filename;
    module.require = name => Object.hasOwn(overrides, name) ? overrides[name] : apiRequire(name);
    module._compile(bytes.toString("utf8"), filename);
    return module.exports;
  }
  const clock = await load("a8deefe2-system-clock.cjs");
  return (await load("a8deefe2-coordinator-routing.cjs", { "../time/system-clock": clock })).createCoordinatorResolver;
}

const createSignedResolver = await originalSignedResolver();
const source = {
  instanceId: "signed-consumer-instance",
  origin: "http://127.0.0.1:37932",
  artifactDigest: "sha256:" + "a".repeat(64),
  generation: 19,
};

async function bindingFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "migration-binding-signed-consumer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "coordinator.json");
  return {
    path,
    resolve: createSignedResolver(new URL("http://127.0.0.1:1"), source.instanceId, path),
    publish: value => atomicJson(path, value),
  };
}

test("migration publishes a complete binding accepted by the original signed API resolver", async t => {
  const f = await bindingFixture(t);
  const published = migrationCoordinatorBinding(source);
  assert.deepEqual(published, { ...source, state: "ready" });
  await f.publish(published);
  assert.deepEqual(JSON.parse(await fs.readFile(f.path, "utf8")), published);
  assert.equal((await f.resolve()).origin, source.origin);
});

test("the original signed API rejects the pre-fix binding without state", async t => {
  const f = await bindingFixture(t);
  await f.publish(source);
  await assert.rejects(f.resolve(), error => error.name === "ZodError" && error.issues.some(issue => issue.path[0] === "state"));
});

for (const field of ["instanceId", "state", "origin", "generation", "artifactDigest"]) {
  test(`the original signed API requires the published ${field} field`, async t => {
    const f = await bindingFixture(t), binding = migrationCoordinatorBinding(source);
    delete binding[field];
    await f.publish(binding);
    await assert.rejects(f.resolve(), error => error.name === "ZodError" && error.issues.some(issue => issue.path[0] === field));
  });
}

for (const [name, patch] of [
  ["another instance", { instanceId: "different-instance" }],
  ["an external origin", { origin: "http://example.invalid:37932" }],
  ["a nonpositive generation", { generation: 0 }],
  ["a fractional generation", { generation: 19.5 }],
  ["a malformed artifact digest", { artifactDigest: "unqualified-digest" }],
  ["an unknown readiness state", { state: "starting" }],
]) {
  test(`the original signed API rejects ${name}`, async t => {
    const f = await bindingFixture(t);
    await f.publish({ ...migrationCoordinatorBinding(source), ...patch });
    await assert.rejects(f.resolve());
  });
}
