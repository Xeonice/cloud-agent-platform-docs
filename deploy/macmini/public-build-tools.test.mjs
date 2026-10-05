import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  VERCEL_DESTINATION,
  VERCEL_VERSION,
  verifyVercel,
  prepareVercel,
  verifyPublicVercelTree,
} from "./public-build-tools.mjs";

async function fixture(t) {
  const review = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "public-cli-review-")),
  );
  t.after(() => fs.rm(review, { recursive: true, force: true }));
  const directory = join(review, "vercel");
  await fs.mkdir(directory, { mode: 0o700 });
  const data = Buffer.from("public pinned distribution");
  const entries = {};
  for (const path of [
    "node_modules",
    "node_modules/vercel",
    "node_modules/vercel/dist",
  ]) {
    await fs.mkdir(join(directory, path), { mode: 0o700 });
    entries[path] = { type: "directory" };
  }
  await fs.writeFile(
    join(directory, "node_modules/vercel/dist/index.js"),
    data,
    { mode: 0o600 },
  );
  entries["node_modules/vercel/dist/index.js"] = {
    type: "file",
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    mode: 0o644,
  };
  await fs.symlink("dist/index.js", join(directory, "node_modules/vercel/cli"));
  entries["node_modules/vercel/cli"] = {
    type: "symlink",
    target: "dist/index.js",
  };
  return {
    review,
    directory,
    manifest: {
      version: VERCEL_VERSION,
      destination: VERCEL_DESTINATION,
      entries,
    },
  };
}
test("a complete private CLI snapshot with contained npm symlinks verifies", async (t) => {
  const f = await fixture(t);
  await verifyVercel(f.review, f.manifest, process.getuid());
});

async function publicFixture(t) {
  const f = await fixture(t);
  const target = join(f.review, "public-vercel");
  await fs.mkdir(target, { mode: 0o755 });
  await fs.chmod(target, 0o755);
  for (const [key, entry] of Object.entries(f.manifest.entries)) {
    const path = join(target, key);
    if (entry.type === "directory") {
      await fs.mkdir(path, { mode: 0o755 });
      await fs.chmod(path, 0o755);
    } else if (entry.type === "symlink") await fs.symlink(entry.target, path);
    else {
      await fs.copyFile(join(f.directory, key), path);
      await fs.chmod(path, entry.mode);
    }
  }
  return { ...f, target };
}

test("the installed-tree verifier accepts only the complete same manifest and expected ownership, without changing bytes", async (t) => {
  const f = await publicFixture(t);
  const file = join(f.target, "node_modules/vercel/dist/index.js");
  const before = await fs.readFile(file);
  const stat = await fs.stat(file);
  // UID is modelled by this unprivileged fixture. Production reuse always passes UID0.
  await verifyPublicVercelTree(f.target, f.manifest, process.getuid());
  await verifyPublicVercelTree(f.target, f.manifest, process.getuid());
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  await assert.rejects(
    verifyPublicVercelTree(f.target, f.manifest),
    /root-owned/,
  );
});

test("installed reuse rejects modified bytes, extra/missing entries and writable/wrong executable modes", async (t) => {
  const f = await publicFixture(t);
  const file = join(f.target, "node_modules/vercel/dist/index.js");
  const original = await fs.readFile(file);
  await fs.writeFile(file, "changed distribution");
  await assert.rejects(
    verifyPublicVercelTree(f.target, f.manifest, process.getuid()),
    /bytes/,
  );
  await fs.writeFile(file, original);
  for (const mode of [0o664, 0o755, 0o4644]) {
    await fs.chmod(file, mode);
    await assert.rejects(
      verifyPublicVercelTree(f.target, f.manifest, process.getuid()),
      /permissions/,
    );
  }
  await fs.chmod(file, 0o644);
  await fs.writeFile(join(f.target, "unreviewed"), "extra");
  await assert.rejects(
    verifyPublicVercelTree(f.target, f.manifest, process.getuid()),
    /Unreviewed/,
  );
  await fs.unlink(join(f.target, "unreviewed"));
  await fs.unlink(file);
  await assert.rejects(
    verifyPublicVercelTree(f.target, f.manifest, process.getuid()),
    /incomplete|ENOENT/,
  );
});

test("installed reuse rejects escaped/replaced links, hardlinked files and a symlink destination", async (t) => {
  const f = await publicFixture(t);
  const link = join(f.target, "node_modules/vercel/cli");
  await fs.unlink(link);
  await fs.symlink("/etc/passwd", link);
  await assert.rejects(
    verifyPublicVercelTree(f.target, f.manifest, process.getuid()),
    /symlink/,
  );
  await fs.unlink(link);
  await fs.symlink("dist/index.js", link);
  await fs.link(
    join(f.target, "node_modules/vercel/dist/index.js"),
    join(f.review, "external-hardlink"),
  );
  await assert.rejects(
    verifyPublicVercelTree(f.target, f.manifest, process.getuid()),
    /Unsafe/,
  );
  await fs.unlink(join(f.review, "external-hardlink"));
  const alias = join(f.review, "alias");
  await fs.symlink(f.target, alias);
  await assert.rejects(
    verifyPublicVercelTree(alias, f.manifest, process.getuid()),
    /root-owned/,
  );
});
test("altered bytes and extra entries reject the snapshot before privileged installation", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    join(f.directory, "node_modules/vercel/dist/index.js"),
    "different bytes",
  );
  await assert.rejects(
    verifyVercel(f.review, f.manifest, process.getuid()),
    /bytes changed/,
  );
  await fs.writeFile(join(f.directory, "injected"), "unreviewed", {
    mode: 0o600,
  });
  await assert.rejects(
    verifyVercel(f.review, f.manifest, process.getuid()),
    /Unreviewed|bytes changed/,
  );
});
test("an escaped symlink and hardlinked file reject the snapshot", async (t) => {
  const f = await fixture(t);
  await fs.unlink(join(f.directory, "node_modules/vercel/cli"));
  await fs.symlink("/etc/passwd", join(f.directory, "node_modules/vercel/cli"));
  await assert.rejects(
    verifyVercel(f.review, f.manifest, process.getuid()),
    /symlink changed/,
  );
  await fs.unlink(join(f.directory, "node_modules/vercel/cli"));
  await fs.symlink(
    "dist/index.js",
    join(f.directory, "node_modules/vercel/cli"),
  );
  await fs.link(
    join(f.directory, "node_modules/vercel/dist/index.js"),
    join(f.review, "hardlink"),
  );
  await assert.rejects(
    verifyVercel(f.review, f.manifest, process.getuid()),
    /Unsafe public/,
  );
});
test("a missing reviewed entry or unapproved destination cannot pass", async (t) => {
  const f = await fixture(t);
  f.manifest.entries["absent"] = { type: "file" };
  await assert.rejects(
    verifyVercel(f.review, f.manifest, process.getuid()),
    /Incomplete/,
  );
  f.manifest.destination = "/tmp/arbitrary";
  await assert.rejects(
    verifyVercel(f.review, f.manifest, process.getuid()),
    /Invalid fixed/,
  );
  await assert.rejects(prepareVercel("/tmp/arbitrary", f.review), /Unexpected/);
});
