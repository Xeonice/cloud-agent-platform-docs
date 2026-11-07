import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Opt-in native fixture. Requires Linux root with mount capability and the actual
// Node 22 better-sqlite3 closure. No Docker, SDK, product DB, or remote operations.
const packageJson =
  process.env.CLOSED_BUSINESS_SQLITE_PACKAGE_JSON ??
  fileURLToPath(new URL("../../api/apps/api/package.json", import.meta.url));
const preboundRoot = process.env.CLOSED_BUSINESS_PREBOUND_FIXTURE_ROOT;
const outputRoot = process.env.CLOSED_BUSINESS_VIEW_OUTPUT_ROOT;
const linux = process.platform === "linux" && process.getuid?.() === 0;
const initialSkip = linux
  ? false
  : "requires Linux root and a real read-only bind mount";

async function metadata(path) {
  try {
    const s = await fs.lstat(path);
    return {
      exists: true,
      dev: s.dev,
      ino: s.ino,
      bytes: s.size,
      mode: s.mode,
      mtimeMs: s.mtimeMs,
      ctimeMs: s.ctimeMs,
      sha256: createHash("sha256")
        .update(await fs.readFile(path))
        .digest("hex"),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
}
async function sourceFacts(path) {
  return Promise.all([path, path + "-wal", path + "-shm"].map(metadata));
}
function command(name, args) {
  return spawnSync(name, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
  });
}

async function readonlyBind(t, source, target) {
  if (source !== null) {
    const first = command("mount", ["--bind", source, target]);
    if (first.status !== 0) {
      if (
        first.error?.code === "ENOENT" ||
        /permission denied|operation not permitted/i.test(first.stderr ?? "")
      ) {
        t.skip(
          "real bind mount unavailable: requires mount utility and CAP_SYS_ADMIN",
        );
        return false;
      }
      assert.fail(
        `bind mount failed (${first.status}, ${first.error?.code ?? "no-code"})`,
      );
    }
    const second = command("mount", ["-o", "remount,bind,ro", target]);
    if (second.status !== 0) {
      command("umount", [target]);
      assert.fail(`read-only bind remount failed (${second.status})`);
    }
    const [a, b] = await Promise.all([fs.stat(source), fs.stat(target)]);
    assert.equal(a.dev, b.dev);
    assert.equal(a.ino, b.ino);
  }
  const escaped = target.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
  const line = (await fs.readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .filter((row) => {
      const m = row.split(" ")[4];
      return m && (escaped === m || escaped.startsWith(m + "/"));
    })
    .sort((a, b) => b.split(" ")[4].length - a.split(" ")[4].length)[0];
  assert.ok(
    line,
    "the actual kernel mount table must identify the read-only bind",
  );
  assert.ok(line.split(" ")[5].split(",").includes("ro"));
  await assert.rejects(
    fs.open(join(target, "read-only-enforcement-probe"), "wx"),
    (error) => error.code === "EROFS",
  );
  return true;
}

async function writer(path, { leaveWal }) {
  const source = `
    import { createRequire } from 'node:module';
    const Database=createRequire(process.env.FIXTURE_SQLITE_PACKAGE_JSON)('better-sqlite3');
    const db=new Database(process.env.FIXTURE_DB);
    db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('wal_autocheckpoint=0');
    db.exec('CREATE TABLE witness(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare('INSERT INTO witness VALUES(?,?)').run(1,'checkpointed');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.prepare('INSERT INTO witness VALUES(?,?)').run(2,'last-committed-row');
    if(process.env.FIXTURE_LEAVE_WAL==='yes'){
      process.stdout.write('COMMITTED\\n');setInterval(()=>{},1000);
    }else{db.close();process.stdout.write('CLOSED\\n');}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      FIXTURE_SQLITE_PACKAGE_JSON: resolve(packageJson),
      FIXTURE_DB: path,
      FIXTURE_LEAVE_WAL: leaveWal ? "yes" : "no",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    stderrBytes = 0;
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    stderrBytes += bytes.length;
  });
  const closed = once(child, "close");
  try {
    const expected = leaveWal ? "COMMITTED\n" : "CLOSED\n";
    const end = Date.now() + 5000;
    while (
      !output.includes(expected) &&
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() < end
    )
      await new Promise((ok) => setTimeout(ok, 10));
    assert.ok(
      output.includes(expected),
      `owned writer did not acknowledge commit/close (stderr bytes=${stderrBytes})`,
    );
    if (leaveWal) {
      // Deliberate isolated crash to preserve a genuine, committed WAL. This is
      // not a normal-exit or production-shutdown claim.
      assert.equal(child.kill("SIGKILL"), true);
      const [code, signal] = await closed;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
    } else {
      const [code, signal] = await closed;
      assert.equal(code, 0);
      assert.equal(signal, null);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
}

async function exercise(t, leaveWal) {
  const root = await fs.mkdtemp(
    join(outputRoot ?? tmpdir(), "closed-business-linux-"),
  );
  const sourceDir = preboundRoot
    ? join(preboundRoot, leaveWal ? "wal" : "normal")
    : join(root, "source");
  const readonlyDir = preboundRoot ? sourceDir : join(root, "readonly"),
    directory = join(root, "view");
  if (!preboundRoot)
    await Promise.all(
      [sourceDir, readonlyDir].map((path) => fs.mkdir(path, { mode: 0o700 })),
    );
  const source = join(sourceDir, "platform.db");
  let mounted = false;
  try {
    const Database = createRequire(resolve(packageJson))("better-sqlite3");
    if (preboundRoot) {
      const proof = JSON.parse(
        await fs.readFile(join(sourceDir, "writer-proof.json"), "utf8"),
      );
      assert.equal(proof.kind, "isolated-closed-business-writer-fixture");
      assert.equal(
        proof.case,
        leaveWal ? "committed-residual-wal" : "normal-last-close",
      );
      assert.equal(proof.committed, true);
      assert.equal(proof.exitCode, leaveWal ? null : 0);
      assert.equal(proof.signal, leaveWal ? "SIGKILL" : null);
    } else await writer(source, { leaveWal });
    if (leaveWal) {
      assert.ok(
        (await fs.stat(source + "-wal")).size > 32,
        "real committed WAL must remain",
      );
      if (!preboundRoot) await fs.rm(source + "-shm", { force: true });
      assert.equal((await metadata(source + "-shm")).exists, false);
    } else {
      assert.equal((await metadata(source + "-wal")).exists, false);
      assert.equal((await metadata(source + "-shm")).exists, false);
    }
    const readOnly = await readonlyBind(
      t,
      preboundRoot ? null : sourceDir,
      readonlyDir,
    );
    mounted = !preboundRoot && readOnly;
    if (!readOnly) return;
    const businessPath = join(readonlyDir, "platform.db"),
      before = await sourceFacts(businessPath);
    let originalFailure = null;
    let original;
    try {
      original = new Database(businessPath, {
        readonly: true,
        fileMustExist: true,
      });
      original.prepare("SELECT count(*) n FROM witness").get();
    } catch (error) {
      originalFailure = error.code;
    } finally {
      original?.close();
    }
    assert.deepEqual(await sourceFacts(businessPath), before);
    assert.ok(
      [
        "SQLITE_CANTOPEN",
        "SQLITE_READONLY",
        "SQLITE_READONLY_RECOVERY",
        "SQLITE_READONLY_CANTINIT",
      ].includes(originalFailure),
      `actual pinned SQLite must demonstrate the closed-WAL read-only failure, got ${originalFailure}`,
    );
    let closureChecks = 0;
    const { createClosedBusinessReadView } =
      await import("./closed-business-read-view.mjs");
    const view = await createClosedBusinessReadView({
      Database,
      businessPath,
      directory,
      scope: {
        kind: "isolated-linux-readonly-fixture",
        case: leaveWal ? "committed-residual-wal" : "normal-last-close",
      },
      assertClosed: async () => {
        closureChecks++;
        assert.deepEqual(await sourceFacts(businessPath), before);
      },
    });
    assert.ok(
      closureChecks >= 2,
      "closed-source authority must be checked around the copy",
    );
    assert.ok(resolve(view.path).startsWith(resolve(directory) + sep));
    assert.equal((await fs.lstat(view.path)).isFile(), true);
    assert.equal((await fs.stat(view.path)).mode & 0o077, 0);
    assert.ok(view.receipt && typeof view.receipt === "object");
    const db = new Database(view.path, { readonly: true, fileMustExist: true });
    try {
      db.pragma("query_only=ON");
      assert.equal(db.pragma("journal_mode", { simple: true }), "delete");
      assert.equal(db.pragma("quick_check", { simple: true }), "ok");
      assert.deepEqual(
        db.prepare("SELECT id,value FROM witness ORDER BY id").all(),
        [
          { id: 1, value: "checkpointed" },
          { id: 2, value: "last-committed-row" },
        ],
      );
    } finally {
      db.close();
    }
    assert.deepEqual(
      await sourceFacts(businessPath),
      before,
      "source DB/WAL/SHM bytes and identities must be unchanged",
    );
    t.diagnostic(
      JSON.stringify({
        nativeFixture: true,
        realReadonlyBind: true,
        externallyPreparedBind: Boolean(preboundRoot),
        originalFailure,
        normalWriterExit: !leaveWal,
        committedWalRecovered: leaveWal,
        sourceUnchanged: true,
        closureChecks,
        sdk: false,
        productDatabase: false,
        remote: false,
      }),
    );
  } finally {
    if (mounted) {
      const result = command("umount", [readonlyDir]);
      assert.equal(
        result.status,
        0,
        "must release only this fixture's own bind mount",
      );
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

test(
  "Linux real RO bind: last normal writer closes and sidecars disappear",
  { skip: initialSkip, timeout: 30000 },
  (t) => exercise(t, false),
);
test(
  "Linux real RO bind: coherent residual WAL preserves its final committed row",
  { skip: initialSkip, timeout: 30000 },
  (t) => exercise(t, true),
);
