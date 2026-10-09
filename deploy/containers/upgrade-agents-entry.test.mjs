import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The agent upgrade script lives in deploy/ops, which the Jenkins contract
// does not scan yet (T30). It imports ./host-layout.mjs from this directory, so
// this thin entry test runs it from here: a change that breaks its imports,
// its self-test or its entry gate fails the contract the same day. Nothing
// here needs Docker, Jenkins, private files or a particular account; the
// self-test returns before the identity gate (Linux uid 1000 included).
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../ops/upgrade-agents.mjs",
);
const run = (args, env = {}) =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ...env },
    timeout: 30_000,
  });
// A stopped run prints one JSON line with the stage, a reason code and a
// redacted summary (T14).
function stopped(result) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  const report = JSON.parse(result.stderr);
  assert.equal(report.state, "stopped-for-operator-review");
  assert.equal(typeof report.reason, "string");
  return report;
}

test("upgrade-agents.mjs parses under the running Node", () => {
  const result = run(["--check", script]);
  assert.equal(result.status, 0, result.stderr);
});

test("upgrade-agents.mjs self-test resolves its imports and passes before the identity gate", () => {
  const result = run([script, "self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    state: "pure-self-tests-passed",
    cases: 19,
  });
});

test("usage errors stop with a reason code before any host check", () => {
  for (const args of [
    [],
    ["upgrade"],
    ["toString"],
    ["build", "/nonexistent/root"],
    ["apply"],
    ["apply", "/nonexistent/a", "/nonexistent/b"],
    ["self-test", "/nonexistent/path"],
  ]) {
    const report = stopped(run([script, ...args]));
    assert.equal(report.stage, "not-started", args.join(" "));
    assert.equal(report.code, "UA_REFUSED");
    assert.match(report.reason, /^(Use |Self-test takes no paths$)/);
  }
});

test("build and apply stop at the host-layout gate before touching any path", () => {
  const directory = mkdtempSync(join(tmpdir(), "upgrade-agents-entry-"));
  try {
    const out = join(directory, "out");
    for (const args of [
      ["build", join(directory, "root"), "a".repeat(40), out],
      ["apply", join(out, "plan.json")],
    ]) {
      // Linux stops at the platform; a Mac at COLIMA_HOME pointing elsewhere
      // (or earlier, for an account outside the operator policy).
      const report = stopped(
        run([script, ...args], { COLIMA_HOME: join(directory, "colima") }),
      );
      assert.equal(report.stage, "host-layout", args[0]);
      assert.match(report.code, /^HL_[A-Z_]+$/);
      assert.ok(!existsSync(out), args[0]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
