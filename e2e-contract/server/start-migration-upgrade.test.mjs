import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertMigrationNativeIdentity,
  frozenLegacyFoundationDriver,
  MIGRATION_LEGACY_SOURCE_PIN,
} from "./start-migration-upgrade.mjs";
import { digest } from "../../deploy/upgrade/trust.mjs";
const config = () => ({
  isolated: true,
  instanceId: "upgrade-acceptance-migration",
  root: "/var/lib/agent-independent-control-qa-20261020/instances/upgrade-acceptance-migration",
  uid: 502,
  gid: 20,
  targetAdapterUid: 502,
  targetAdapterGid: 20,
  adapter: { uid: 502, gid: 20 },
  docker: {
    dedicated: true,
    image: digest("fixed-image"),
    uid: 502,
    gid: 20,
    clientPath: "/usr/local/bin/docker",
    clientDigest: digest("client"),
    args: [],
  },
  keys: Object.fromEntries(
    [
      "owner",
      "control",
      "controller",
      "upgradeControl",
      "entry",
      "sticky",
      "supervisor",
      "upgradeSession",
      "privateEntry",
      "businessProbe",
      "accessAuthority",
      "cookie",
    ].map((k) => [k, k.padEnd(40, "-")]),
  ),
  source: { ...MIGRATION_LEGACY_SOURCE_PIN },
});
const actual = {
  platform: "linux",
  arch: "arm64",
  nodeMajor: 22,
  uid: 502,
  gid: 20,
};
test("Native preflight uses frozen target and runner UID/GID, not QA-root defaults, before any filesystem or lifecycle effect", () => {
  assert.equal(assertMigrationNativeIdentity(config(), actual), true);
  for (const patch of [
    { targetAdapterUid: 0 },
    { targetAdapterGid: 0 },
    { uid: 0 },
    { gid: 0 },
  ])
    assert.throws(
      () => assertMigrationNativeIdentity({ ...config(), ...patch }, actual),
      /MIGRATION_NATIVE_RUNNER_TARGET_UID_GID_MISMATCH/,
    );
  assert.throws(
    () =>
      assertMigrationNativeIdentity(config(), {
        ...actual,
        platform: "darwin",
      }),
    /MIGRATION_NATIVE_LINUX_ARM64_NODE22_REQUIRED/,
  );
  assert.throws(
    () =>
      assertMigrationNativeIdentity(
        { ...config(), root: "/var/lib/production" },
        actual,
      ),
    /MIGRATION_NATIVE_EXCLUSIVE_ROOT_REQUIRED/,
  );
  assert.throws(
    () =>
      assertMigrationNativeIdentity(
        {
          ...config(),
          source: {
            ...MIGRATION_LEGACY_SOURCE_PIN,
            archiveDigest: digest("different-bytes"),
          },
        },
        actual,
      ),
    /MIGRATION_NATIVE_REAL_V20_SOURCE_REQUIRED/,
  );
});
test("generated legacy Foundation bootstraps actual frozen old imports, has listener-only shutdown, and rollback resumes listeners without starting a second Owner", async (t) => {
  const source = await fs.readFile(
      new URL("./start-upgrade.mjs", import.meta.url),
      "utf8",
    ),
    driver = frozenLegacyFoundationDriver(source, "/var/lib/qa-immutable-v20");
  assert.equal(driver.includes("../../deploy/upgrade/"), false);
  assert.match(
    driver,
    /from '\/var\/lib\/qa-immutable-v20\/installer\/candidate-supervisor.mjs'/,
  );
  assert.match(driver, /const activation=await bootstrap.json\(\)/);
  assert.match(driver, /legacy-foundation\/runtime\/resume.json/);
  assert.match(
    driver,
    /if\(previous\).*createCoordinatorClient\(previous.coordinator\)/,
  );
  assert.match(driver, /else h=await startUpgradeHarness\(config\)/);
  assert.match(
    driver,
    /Promise.all\(\[h.supervisor.close\(\),h.entry.close\(\)\]\)/,
  );
  assert.equal(driver.includes("void harness.close().then"), false);
  const root = await fs.mkdtemp(join(tmpdir(), "migration-driver-syntax-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "driver.mjs");
  await fs.writeFile(path, driver, { mode: 0o600 });
  const parsed = spawnSync(process.execPath, ["--check", path], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
});
