import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  qualificationBusinessDatabasePath,
  verifyQualificationBusinessDatabaseFilesystem,
  createInstallerFilesystem,
  createBusinessDatabaseFilesystem,
} from "../../e2e-contract/server/installer-filesystem.mjs";

// Claimed evidence below is input-validation data, never a mounted-filesystem
// receipt. Verification uses real temporary directories/lstat/realpath/statfs;
// no Docker daemon, mount, native role or statfs replacement is used here.
const instanceId = "upgrade-acceptance-filesystem-helper";
function claimedLayout(root) {
  return {
    isolated: true,
    instanceId,
    root,
    docker: { dedicated: true },
    businessDatabasePath: join(root, "business/db/platform.sqlite"),
    businessDatabaseFilesystemEvidence: {
      instanceId,
      kind: "independent-business-db-filesystem",
      qualified: true,
      mountpoint: join(root, "business/db"),
      sharedParentDev: 1,
      filesystem: { type: 0xef53, dev: 2, totalBytes: 1024 ** 3 },
    },
  };
}
async function temporaryRoot(t) {
  const root = await fs.mkdtemp(
    join(tmpdir(), "upg-qualification-filesystem-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("ordinary database layout remains fixed and a read-only layout check creates no files", async (t) => {
  const root = await temporaryRoot(t),
    input = { root },
    expected = join(root, "business/platform.sqlite");
  assert.equal(qualificationBusinessDatabasePath(input), expected);
  assert.equal(
    await verifyQualificationBusinessDatabaseFilesystem(input),
    expected,
  );
  assert.deepEqual(await fs.readdir(root), []);
});

test("ordinary layout accepts only its matching explicit database path", () => {
  const root = "/tmp/upg-qa-helper-work/ordinary";
  assert.equal(
    qualificationBusinessDatabasePath({
      root,
      businessDatabasePath: join(root, "business/platform.sqlite"),
    }),
    join(root, "business/platform.sqlite"),
  );
  for (const path of [
    join(root, "business/db/platform.sqlite"),
    join(root, "other.sqlite"),
    "/tmp/unrelated/platform.sqlite",
    "relative/platform.sqlite",
    root + "/business/../platform.sqlite",
  ]) {
    assert.throws(
      () =>
        qualificationBusinessDatabasePath({ root, businessDatabasePath: path }),
      { code: "QUALIFICATION_DB_PATH_SCOPE_MISMATCH" },
    );
  }
});

test("an explicit business-db layout selects only the fixed leaf after structural evidence validation", () => {
  const input = claimedLayout("/tmp/upg-qa-helper-work/claimed");
  assert.equal(
    qualificationBusinessDatabasePath(input),
    input.businessDatabasePath,
  );
  // This assertion is deliberately only structural. A real mount is separately
  // checked by verifyQualificationBusinessDatabaseFilesystem before startup.
});

const invalidClaims = [
  [
    "not isolated",
    (input) => {
      input.isolated = false;
    },
  ],
  [
    "not dedicated",
    (input) => {
      input.docker.dedicated = false;
    },
  ],
  [
    "another instance",
    (input) => {
      input.businessDatabaseFilesystemEvidence.instanceId =
        "upgrade-acceptance-other";
    },
  ],
  [
    "installer scope",
    (input) => {
      input.businessDatabaseFilesystemEvidence.kind =
        "independent-installer-filesystem";
    },
  ],
  [
    "unqualified",
    (input) => {
      input.businessDatabaseFilesystemEvidence.qualified = false;
    },
  ],
  [
    "foreign mountpoint",
    (input) => {
      input.businessDatabaseFilesystemEvidence.mountpoint =
        "/tmp/foreign/business/db";
    },
  ],
  [
    "parent mountpoint",
    (input) => {
      input.businessDatabaseFilesystemEvidence.mountpoint = join(
        input.root,
        "business",
      );
    },
  ],
  [
    "ordinary db under business-db proof",
    (input) => {
      input.businessDatabasePath = join(input.root, "business/platform.sqlite");
    },
  ],
  [
    "outside database path",
    (input) => {
      input.businessDatabasePath = "/tmp/foreign/platform.sqlite";
    },
  ],
  [
    "relative database path",
    (input) => {
      input.businessDatabasePath = "business/db/platform.sqlite";
    },
  ],
  [
    "root does not match evidence",
    (input) => {
      input.root = "/tmp/upg-qa-helper-work/other";
    },
  ],
  [
    "wrong filesystem type",
    (input) => {
      input.businessDatabaseFilesystemEvidence.filesystem.type = 0x01021994;
    },
  ],
  [
    "fractional device",
    (input) => {
      input.businessDatabaseFilesystemEvidence.filesystem.dev = 1.5;
    },
  ],
  [
    "unknown device",
    (input) => {
      input.businessDatabaseFilesystemEvidence.filesystem.dev = NaN;
    },
  ],
  [
    "same parent device",
    (input) => {
      input.businessDatabaseFilesystemEvidence.filesystem.dev =
        input.businessDatabaseFilesystemEvidence.sharedParentDev;
    },
  ],
  [
    "missing filesystem",
    (input) => {
      delete input.businessDatabaseFilesystemEvidence.filesystem;
    },
  ],
];
for (const [name, change] of invalidClaims) {
  test("business-db path rejects " + name, () => {
    const input = claimedLayout("/tmp/upg-qa-helper-work/claimed");
    change(input);
    assert.throws(() => qualificationBusinessDatabasePath(input), {
      code: "QUALIFICATION_DB_PATH_SCOPE_MISMATCH",
    });
  });
}

test("a forged claim cannot qualify a real ordinary directory as a separate database filesystem", async (t) => {
  const root = await fs.realpath(await temporaryRoot(t)),
    directory = join(root, "business/db");
  await fs.mkdir(directory, { recursive: true });
  const actual = await fs.lstat(directory),
    parent = await fs.stat(root),
    input = claimedLayout(root);
  assert.equal(actual.dev, parent.dev);
  input.businessDatabaseFilesystemEvidence.filesystem.dev = actual.dev;
  // A dishonest parent-device claim passes the shape check, but the actual
  // filesystem verifier must reject it rather than trusting qualified=true.
  input.businessDatabaseFilesystemEvidence.sharedParentDev = parent.dev + 1;
  await assert.rejects(verifyQualificationBusinessDatabaseFilesystem(input), {
    code: "QUALIFICATION_DB_FILESYSTEM_CHANGED",
  });
});

test("verification rejects a real symlink instead of following it to a different database directory", async (t) => {
  const root = await fs.realpath(await temporaryRoot(t));
  await fs.mkdir(join(root, "business"));
  await fs.mkdir(join(root, "other"));
  await fs.symlink(join(root, "other"), join(root, "business/db"));
  assert.equal(
    (await fs.lstat(join(root, "business/db"))).isSymbolicLink(),
    true,
  );
  await assert.rejects(
    verifyQualificationBusinessDatabaseFilesystem(claimedLayout(root)),
    { code: "QUALIFICATION_DB_FILESYSTEM_CHANGED" },
  );
});

test("verification rejects a non-directory database leaf", async (t) => {
  const root = await fs.realpath(await temporaryRoot(t));
  await fs.mkdir(join(root, "business"));
  await fs.writeFile(join(root, "business/db"), "ordinary file", {
    mode: 0o600,
  });
  await assert.rejects(
    verifyQualificationBusinessDatabaseFilesystem(claimedLayout(root)),
  );
});

test("verification preserves an actual missing-directory error and does not create a substitute", async (t) => {
  const root = await temporaryRoot(t);
  await assert.rejects(
    verifyQualificationBusinessDatabaseFilesystem(claimedLayout(root)),
    { code: "ENOENT" },
  );
  assert.deepEqual(await fs.readdir(root), []);
});

for (const [name, create] of [
  ["installer", createInstallerFilesystem],
  ["business-db", createBusinessDatabaseFilesystem],
]) {
  const unsupported = process.platform !== "linux" || process.arch !== "arm64";
  test(
    name +
      " creation refuses " +
      (unsupported
        ? "this actual unsupported platform"
        : "an unisolated caller") +
      " before creating any files",
    async (t) => {
      const parent = await temporaryRoot(t),
        root = join(parent, "fresh-case"),
        spec = {
          kind: "loop-ext4",
          bytes: 1536 * 1024 * 1024,
          managerImage: "sha256:" + "a".repeat(64),
        },
        input = {
          isolated: unsupported,
          instanceId,
          root,
          docker: { dedicated: true, cli: "/nonexistent/docker", args: [] },
          installerFilesystem: spec,
          businessDatabaseFilesystem: spec,
        };
      await assert.rejects(create(input), {
        code: "ISOLATED_FILESYSTEM_ADMIN_REQUIRED",
      });
      await assert.rejects(fs.lstat(root), { code: "ENOENT" });
      assert.deepEqual(await fs.readdir(parent), []);
    },
  );
}
