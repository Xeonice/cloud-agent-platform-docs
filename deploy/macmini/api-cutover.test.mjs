import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dedicatedApiExited,
  waitDedicatedApiExit,
  restoreApiAfterExit,
} from "./install-system-services.mjs";

const identity = Object.freeze({
  pid: 64657,
  supervisorPid: 64656,
  uid: 501,
  node: process.execPath,
  domain: "gui/501",
  sha: "a".repeat(40),
  lock: Object.freeze({
    dev: 1,
    ino: 200,
    ownerDev: 1,
    ownerIno: 201,
    ownerSha256: "b".repeat(64),
  }),
});
const ownershipError =
  /Dedicated API process, job, listener or lock ownership changed/;

function snapshot(overrides = {}) {
  return {
    job: {
      pid: identity.supervisorPid,
      program: identity.node,
      state: "running",
    },
    supervisor: {
      pid: identity.supervisorPid,
      ppid: 1,
      uid: identity.uid,
      command: identity.node,
    },
    child: {
      pid: identity.pid,
      ppid: identity.supervisorPid,
      uid: identity.uid,
      command: identity.node,
    },
    listeners: [{ pid: identity.pid, uid: identity.uid, command: "node" }],
    lock: { ...identity.lock },
    runtime: {
      pid: identity.pid,
      supervisorPid: identity.supervisorPid,
      sha: identity.sha,
    },
    ...overrides,
  };
}
function exited(overrides = {}) {
  return snapshot({
    job: null,
    supervisor: null,
    child: null,
    listeners: [],
    lock: null,
    ...overrides,
  });
}
function timer() {
  let time = 0;
  return {
    get time() {
      return time;
    },
    options: {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
  };
}
async function barrier(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "api-cutover-barrier-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "admission");
  await fs.writeFile(path, "installer-owned", { mode: 0o600 });
  return {
    path,
    owns: async () =>
      (await fs.readFile(path, "utf8").catch(() => null)) === "installer-owned",
  };
}

test("bootout registry removal alone cannot declare a still-serving API child exited", () => {
  assert.equal(dedicatedApiExited(identity, snapshot({ job: null })), false);
  assert.equal(
    dedicatedApiExited(
      identity,
      snapshot({
        job: null,
        supervisor: null,
        child: { ...snapshot().child, ppid: 1 },
      }),
    ),
    false,
  );
  assert.equal(
    dedicatedApiExited(identity, exited()),
    true,
    "the original runtime record intentionally remains as stale provenance",
  );
});

test("every original job, process, listener and lock must release regardless of shutdown order", async () => {
  for (const component of ["job", "supervisor", "child", "listeners", "lock"]) {
    const clock = timer();
    const samples = [];
    await waitDedicatedApiExit(
      identity,
      async () => {
        samples.push(clock.time);
        const state = exited();
        if (clock.time < 3000) {
          state[component] = snapshot()[component];
          if (component === "child") state.child.ppid = 1;
        }
        return state;
      },
      async () => true,
      clock.options,
    );
    assert.equal(clock.time, 3000, component);
    assert.ok(samples.includes(0), component);
    assert.ok(samples.includes(2000), component);
  }
});

test("sixty-second API shutdown may outlive launchd registry removal before lock cleanup permits replacement", async () => {
  const clock = timer();
  let sampledPastGrace = false;
  await waitDedicatedApiExit(
    identity,
    async () => {
      if (clock.time >= 60_000) sampledPastGrace = true;
      return snapshot({
        job: null,
        supervisor: clock.time < 60_000 ? snapshot().supervisor : null,
        child: clock.time < 59_000 ? snapshot().child : null,
        listeners: clock.time < 58_000 ? snapshot().listeners : [],
        lock: clock.time < 61_000 ? { ...identity.lock } : null,
      });
    },
    async () => true,
    clock.options,
  );
  assert.equal(sampledPastGrace, true);
  assert.equal(clock.time, 61_000);
});

test("the same empty lock directory during fs.rm is still a blocker, not permission to steal the lock", () => {
  const empty = {
    dev: identity.lock.dev,
    ino: identity.lock.ino,
    ownerDev: null,
    ownerIno: null,
    ownerSha256: null,
  };
  assert.equal(dedicatedApiExited(identity, exited({ lock: empty })), false);
  for (const change of [
    { ino: identity.lock.ino + 1 },
    { dev: identity.lock.dev + 1 },
    { ownerDev: identity.lock.ownerDev },
    { ownerIno: identity.lock.ownerIno },
    { ownerSha256: identity.lock.ownerSha256 },
  ])
    assert.throws(
      () =>
        dedicatedApiExited(identity, exited({ lock: { ...empty, ...change } })),
      ownershipError,
    );
});

test("PID reuse, changed parent or executable, foreign listener and replaced lock are rejected without signalling anything", () => {
  const modifications = [
    { job: { ...snapshot().job, pid: 99999 } },
    { job: { ...snapshot().job, program: "/bin/other" } },
    { supervisor: { ...snapshot().supervisor, pid: 99999 } },
    { supervisor: { ...snapshot().supervisor, uid: 0 } },
    { supervisor: { ...snapshot().supervisor, ppid: 99999 } },
    { supervisor: { ...snapshot().supervisor, command: "/bin/other" } },
    { child: { ...snapshot().child, pid: 99999 } },
    { child: { ...snapshot().child, uid: 0 } },
    { child: { ...snapshot().child, ppid: 99999 } },
    { child: { ...snapshot().child, command: "/bin/other" } },
    { listeners: [{ ...snapshot().listeners[0], pid: 99999 }] },
    { listeners: [{ ...snapshot().listeners[0], uid: 0 }] },
    { listeners: [{ ...snapshot().listeners[0], command: "other" }] },
    { lock: { ...identity.lock, ino: 99999 } },
    { lock: { ...identity.lock, dev: 2 } },
    { lock: { ...identity.lock, ownerIno: 99999 } },
    { lock: { ...identity.lock, ownerDev: 2 } },
    { lock: { ...identity.lock, ownerSha256: "c".repeat(64) } },
    { lock: { ...identity.lock, pid: 99999 } },
    { runtime: null },
    { runtime: { ...snapshot().runtime, pid: 99999 } },
    { runtime: { ...snapshot().runtime, supervisorPid: 99999 } },
    { runtime: { ...snapshot().runtime, sha: "c".repeat(40) } },
  ];
  for (const change of modifications)
    assert.throws(
      () => dedicatedApiExited(identity, snapshot(change)),
      ownershipError,
      Object.keys(change)[0],
    );
});

test("a real lock owner record belongs to the original supervisor, and another identity cannot borrow its exit proof", () => {
  assert.equal(
    dedicatedApiExited(
      identity,
      snapshot({ lock: { ...identity.lock, pid: identity.supervisorPid } }),
    ),
    false,
  );
  for (const change of [
    { uid: 0 },
    { pid: identity.supervisorPid },
    { supervisorPid: identity.pid },
    { node: "relative/node" },
    { domain: "gui/401" },
    { sha: "main" },
  ])
    assert.throws(
      () => dedicatedApiExited({ ...identity, ...change }, exited()),
      ownershipError,
    );
});

test("a still-registered original job without a PID also blocks, while another process cannot masquerade as an adopted child", () => {
  assert.equal(
    dedicatedApiExited(
      identity,
      exited({ job: { ...snapshot().job, pid: null, state: "not running" } }),
    ),
    false,
  );
  assert.throws(
    () =>
      dedicatedApiExited(
        identity,
        snapshot({ child: { ...snapshot().child, ppid: 1 } }),
      ),
    ownershipError,
  );
});

test("missing or malformed observation cannot be treated as an empty machine", () => {
  for (const state of [
    null,
    {},
    exited({ job: undefined }),
    exited({ supervisor: undefined }),
    exited({ child: undefined }),
    exited({ listeners: null }),
    exited({ lock: undefined }),
    exited({ runtime: undefined }),
  ])
    assert.throws(() => dedicatedApiExited(identity, state), ownershipError);
});

test("timeout preserves the real admission marker and does not bootstrap another API", async (t) => {
  const held = await barrier(t),
    clock = timer(),
    effects = [];
  await assert.rejects(
    restoreApiAfterExit({
      waitForExit: () =>
        waitDedicatedApiExit(
          identity,
          async () => snapshot({ job: null }),
          held.owns,
          clock.options,
        ),
      bootstrap: async () => effects.push("unexpected bootstrap"),
      ready: async () => effects.push("unexpected readiness"),
    }),
    /Old production API has not fully exited within ninety seconds/,
  );
  assert.ok(clock.time >= 90_000);
  assert.ok(clock.time < 92_000);
  assert.equal(await held.owns(), true);
  assert.deepEqual(effects, []);
});

test("barrier replacement during the final exit sample refuses recovery and preserves the replacement marker", async (t) => {
  const held = await barrier(t),
    effects = [];
  await assert.rejects(
    restoreApiAfterExit({
      waitForExit: () =>
        waitDedicatedApiExit(
          identity,
          async () => {
            await fs.writeFile(held.path, "manual replacement", {
              mode: 0o600,
            });
            return exited();
          },
          held.owns,
        ),
      bootstrap: async () => effects.push("unexpected bootstrap"),
      ready: async () => effects.push("unexpected readiness"),
    }),
    /ownership changed/,
  );
  assert.equal(await fs.readFile(held.path, "utf8"), "manual replacement");
  assert.deepEqual(effects, []);
});

test("recovery waits for old child, listener and lock removal before one bootstrap and authenticated readiness", async () => {
  const clock = timer(),
    events = [];
  await restoreApiAfterExit({
    waitForExit: () =>
      waitDedicatedApiExit(
        identity,
        async () => {
          events.push("sample:" + clock.time);
          return clock.time < 2000 ? snapshot({ job: null }) : exited();
        },
        async () => true,
        clock.options,
      ),
    bootstrap: async () => {
      assert.equal(clock.time, 2000);
      events.push("bootstrap");
    },
    ready: async () => {
      assert.equal(events.at(-1), "bootstrap");
      events.push("authenticated-ready");
    },
  });
  assert.deepEqual(events.slice(-2), ["bootstrap", "authenticated-ready"]);
  assert.equal(events.filter((e) => e === "bootstrap").length, 1);
});

test("unknown replacement or unavailable process evidence never reaches bootstrap/readiness", async () => {
  for (const probe of [
    async () => snapshot({ child: { ...snapshot().child, pid: 99999 } }),
    async () => {
      throw new Error("Process evidence unavailable");
    },
  ]) {
    const effects = [];
    await assert.rejects(
      restoreApiAfterExit({
        waitForExit: () =>
          waitDedicatedApiExit(identity, probe, async () => true),
        bootstrap: async () => effects.push("unexpected bootstrap"),
        ready: async () => effects.push("unexpected readiness"),
      }),
      /ownership changed|Process evidence unavailable/,
    );
    assert.deepEqual(effects, []);
  }
});
