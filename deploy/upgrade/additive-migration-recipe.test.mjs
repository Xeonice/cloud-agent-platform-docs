import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  IMAGE_RUNTIME_VERSIONS_MIGRATION as recipe,
  IMAGE_RUNTIME_VERSIONS_MIGRATION_DIGEST as expected,
  permitsImageRuntimeVersionsPath,
} from "./additive-migration-recipe.mjs";
import { digest } from "./trust.mjs";
import { validateMigrationPlan } from "./migration-plan.mjs";

test("only the fixed committed additive operation is accepted; arbitrary SQL and changed recipes fail closed", () => {
  assert.equal(digest(recipe), expected);
  const sql = readFileSync(
    new URL(
      "../../api/drizzle/0028_image_runtime_versions.sql",
      import.meta.url,
    ),
  );
  assert.equal(
    createHash("sha256").update(sql).digest("hex"),
    recipe.migrationHash,
  );
  assert.deepEqual(validateMigrationPlan(recipe), {
    plan: recipe,
    planDigest: expected,
  });
  for (const bad of [
    { ...recipe, sql: "DROP TABLE images" },
    { ...recipe, migrationHash: "a".repeat(64) },
    { ...recipe, targetSchema: 30 },
    { ...recipe, kind: "arbitrary-additive" },
    { ...recipe, oldRepresentationRetained: false },
  ])
    assert.throws(() => validateMigrationPlan(bad));
});
test("schema exceptions cover exactly the signed 28→29 recipe and never unknown future schema", () => {
  const path = {
    minSchema: 28,
    maxSchema: 29,
    targetSchema: 29,
    migrationPlanDigest: expected,
  };
  assert.equal(permitsImageRuntimeVersionsPath(path, 28), true);
  for (const [candidate, schema] of [
    [path, 27],
    [path, 30],
    [{ ...path, migrationPlanDigest: null }, 28],
    [{ ...path, targetSchema: 30 }, 28],
    [{ ...path, maxSchema: 99 }, 28],
  ])
    assert.equal(permitsImageRuntimeVersionsPath(candidate, schema), false);
});
