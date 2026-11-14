import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { digest } from "./trust.mjs";
import {
  publishInitialRoleInventory,
  readInitialRoleInventory,
  createInitialRoleIdentityReader,
} from "./initial-role-inventory.mjs";
function fixture() {
  const instanceId = "own-cold-install",
    at = new Date().toISOString(),
    kinds = ["api", "coordinator", "web", "installer"];
  const activation = {
    releaseId: "v0.0.1-fixture",
    activationGeneration: 1,
    activatedAt: at,
    components: Object.fromEntries(
      kinds.map((kind, i) => [
        kind,
        {
          artifactDigest: digest(kind),
          inputFingerprint: digest("input" + kind),
          ...(kind === "web" ? { webRevision: "web-fixture-revision" } : {}),
        },
      ]),
    ),
  };
  const records = kinds.map((kind, i) => ({
    kind,
    instanceId,
    containerId: String(i + 1).repeat(64),
    startIdentity: "actual-own-bootstrap-" + kind,
    artifactDigest: activation.components[kind].artifactDigest,
    inputFingerprint: activation.components[kind].inputFingerprint,
    artifactRoot: "/own/artifacts",
    origin: "http://127.0.0.1:" + (42000 + i),
  }));
  const physical = Object.fromEntries(
    records.map((r, i) => [
      r.containerId,
      {
        ...r,
        pid: 1,
        hostPid: 100 + i,
        startedAt: at,
        birthTicks: String(400 + i),
        cgroupDigest: digest("own-cgroup-" + i),
        running: true,
        paused: false,
        restartPolicy: "no",
        restartCount: 0,
        role: r.kind,
      },
    ]),
  );
  const metadata = (r) => ({
    instanceId,
    role: r.kind === "api" ? "control" : r.kind === "web" ? undefined : r.kind,
    pid: 1,
    startIdentity: r.startIdentity,
    artifactDigest: r.artifactDigest,
    ...(r.kind === "web"
      ? { webRevision: activation.components.web.webRevision }
      : {}),
  });
  return {
    instanceId,
    activation,
    records,
    physical,
    inspect: async (id) => physical[id],
    readIdentity: async (r) => metadata(r),
  };
}
test("bootstrap receipt binds four actual processes to gen1 activation, has no forged attempt, and is idempotent", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "initial-roles-")),
  );
  try {
    const f = fixture(),
      path = join(directory, "inventory.json");
    const value = await publishInitialRoleInventory({ path, ...f });
    assert.equal(value.roles.length, 4);
    assert.equal(
      value.roles.every(
        (r) =>
          r.attemptId === null && r.retirementScope === "bootstrap-activation",
      ),
      true,
    );
    assert.equal(value.activation.activationDigest, digest(f.activation));
    assert.deepEqual(
      await readInitialRoleInventory({ path, instanceId: f.instanceId }),
      value,
    );
    assert.deepEqual(await publishInitialRoleInventory({ path, ...f }), value);
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("private-key"), false);
    const changed = fixture();
    changed.records[0].startIdentity = "replacement-bootstrap-start";
    changed.physical[changed.records[0].containerId].startIdentity =
      changed.records[0].startIdentity;
    await assert.rejects(
      publishInitialRoleInventory({ path, ...changed }),
      /INITIAL_ROLE_REGISTRATION_CONFLICT/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("replacement birth, metadata digest, unconfirmed activation and Owner roles refuse registration", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "initial-roles-negative-")),
  );
  try {
    for (const mutate of [
      (f) => {
        let calls = 0;
        const original = f.inspect;
        f.inspect = async (id) => {
          const p = structuredClone(await original(id));
          if (++calls === 2) p.birthTicks = "replacement";
          return p;
        };
      },
      (f) => {
        f.readIdentity = async (r) => ({
          instanceId: f.instanceId,
          pid: 1,
          startIdentity: r.startIdentity,
          role: "control",
          artifactDigest: digest("wrong"),
        });
      },
      (f) => (f.activation.activationGeneration = 2),
      (f) => (f.records[0].kind = "owner"),
    ]) {
      const f = fixture();
      mutate(f);
      await assert.rejects(
        publishInitialRoleInventory({
          path: join(directory, "inventory.json"),
          ...f,
        }),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("fixed metadata reader uses actual web shape without invented role and never calls Owner/business/lifecycle paths", async () => {
  const seen = [],
    key = "synthetic-only-install-key-32-chars";
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.end(
      JSON.stringify({
        instanceId: "fixture",
        pid: 1,
        startIdentity: "actual-own-start",
        artifactDigest: digest("web"),
        webRevision: "revision",
      }),
    );
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const reader = createInitialRoleIdentityReader({
        instanceId: "fixture",
        controlKey: key,
        controllerKey: key,
      }),
      base = "http://127.0.0.1:" + server.address().port;
    const value = await reader({ kind: "web", origin: base });
    assert.equal(Object.hasOwn(value, "role"), false);
    assert.deepEqual(seen, ["/web-process"]);
    await assert.rejects(
      reader({ kind: "owner", origin: base }),
      /INITIAL_ROLE_METADATA_SCOPE_UNKNOWN/,
    );
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});

test("pure-control cold installation registers only three actual business roles, never relabels independent Agent as legacy installer", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "initial-stable-roles-")),
  );
  try {
    const f = fixture();
    f.records = f.records.filter((r) => r.kind !== "installer");
    const value = await publishInitialRoleInventory({
      ...f,
      path: join(directory, "initial.json"),
    });
    assert.equal(value.roles.length, 3);
    assert.equal(
      value.roles.some((r) => r.kind === "installer"),
      false,
    );
    const bad = fixture();
    bad.physical[
      bad.records.find((r) => r.kind === "installer").containerId
    ].role = "control-agent";
    await assert.rejects(
      publishInitialRoleInventory({
        ...bad,
        path: join(directory, "bad.json"),
      }),
      /INITIAL_ROLE_PHYSICAL_CHANGED/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
