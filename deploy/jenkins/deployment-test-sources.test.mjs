import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deploymentTestSources,
  REQUIRED_DEPLOYMENT_TEST_DIRECTORIES,
} from "./deployment-test-sources.mjs";

async function fixture(t) {
  const source = await fs.mkdtemp(join(tmpdir(), "deployment-test-discovery-"));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  for (const directory of REQUIRED_DEPLOYMENT_TEST_DIRECTORIES) {
    const path = join(source, "deploy", directory);
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(join(path, "boundary.test.mjs"), "");
  }
  return source;
}

test("deployment discovery covers existing boundaries and new nested source directories", async (t) => {
  const source = await fixture(t);
  const extra = join(source, "deploy", "future-role", "nested");
  await fs.mkdir(extra, { recursive: true });
  await fs.writeFile(join(extra, "continuity.test.mjs"), "");
  await fs.writeFile(join(extra, "helper.mjs"), "");
  assert.deepEqual(await deploymentTestSources(source), [
    "deploy/containers/boundary.test.mjs",
    "deploy/future-role/nested/continuity.test.mjs",
    "deploy/host/boundary.test.mjs",
    "deploy/jenkins/boundary.test.mjs",
    "deploy/ops/boundary.test.mjs",
    "deploy/upgrade/boundary.test.mjs",
  ]);
});

test("removing a required regression directory cannot silently shrink the CI suite", async (t) => {
  const source = await fixture(t);
  await fs.rm(join(source, "deploy", "upgrade"), { recursive: true });
  await assert.rejects(deploymentTestSources(source), /sources are missing: deploy\/upgrade/);
});

test("an emptied required regression directory fails even when other tests remain", async (t) => {
  const source = await fixture(t);
  await fs.unlink(join(source, "deploy", "host", "boundary.test.mjs"));
  await assert.rejects(deploymentTestSources(source), /sources are missing: deploy\/host is empty/);
});
