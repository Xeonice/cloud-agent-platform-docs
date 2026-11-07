import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createInstanceController } from "./instance-controller.mjs";
import { createCoordinatorClient } from "./coordinator-client.mjs";
import { atomicJson } from "./io.mjs";
import { digest, freezePlan, signManifest, verifyManifest } from "./trust.mjs";

const H = "sha256:" + "a".repeat(64),
  OLD = "sha256:" + "b".repeat(64);
const ID = "77777777-7777-4777-8777-777777777778";
function deferred() {
  let resolve;
  const promise = new Promise((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

// Real control HTTP, production signing/plan/controller/client and journals.
// The receiver implements the existing durable progress contract boundary;
// these local checks never stand in for native/VM qualification.
async function fixture(
  t,
  {
    installerHandoff = false,
    renewError = null,
    terminal = false,
    holdSecondAck = false,
    progressCapability,
    checkpointEvidence,
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "upg-progress-observation-")),
  );
  const key = generateKeyPairSync("ed25519");
  const privateKey = key.privateKey.export({ format: "pem", type: "pkcs8" });
  const publicKey = key.publicKey.export({ format: "pem", type: "spki" });
  const artifact = (d) => ({
    artifactDigest: d,
    inputFingerprint: H,
    sourceRevision: "a".repeat(40),
    protocol: { min: 1, max: 1 },
  });
  const policy = {
    id: "progress-policy",
    weights: [1, 5, 25, 100],
    stageDurationMs: 60000,
    minRequests: 100,
    observationFreshnessMs: 5000,
    probeHz: 10,
    requestDeadlineMs: 2000,
    attachDeadlineMs: 5000,
    softErrorDelta: 0.01,
    p95Ratio: 2,
    p95FloorMs: 1000,
    evaluationIntervalMs: 10000,
    consecutiveEvaluations: 2,
    retentionMs: 600000,
    migrationBatchMs: 500,
    maxWalBytes: 100000000,
    minFreeBytes: 1000000000,
    fallbacks: [
      { releaseId: "v1.0.0", apiDigest: OLD, webDigest: OLD, rehearsed: true },
    ],
    stopUserResources: false,
    restoreLiveVolume: false,
    contractInUpgrade: false,
  };
  const manifest = {
    schemaVersion: 2,
    releaseId: "v1.1.0",
    channel: "stable",
    publishedAt: new Date().toISOString(),
    commits: {
      project: "a".repeat(40),
      api: "b".repeat(40),
      web: "c".repeat(40),
    },
    components: {
      api: artifact(H),
      coordinator: artifact(H),
      web: { ...artifact(OLD), webRevision: "c".repeat(40) },
      installer: artifact(H),
    },
    packages: [
      {
        platform: process.platform,
        arch: process.arch,
        name: "instance.tgz",
        url: "https://dist.example.com/instance.tgz",
        digest: H,
        bytes: 4096,
        format: "native-tar",
      },
    ],
    upgradePaths: [
      {
        fromRelease: "v1.0.0",
        minSchema: 1,
        maxSchema: 1,
        targetSchema: 1,
        bridgeReleases: [],
        migrationPlanDigest: null,
      },
    ],
    policy,
    evidence: [
      "build",
      "contracts",
      "four-combinations",
      "native-continuity",
      "fault-recovery",
    ].map((kind) => ({
      kind,
      result: "passed",
      inputFingerprint: H,
      reportDigest: H,
      runId: "progress-boundary-test-only",
      recordedAt: new Date().toISOString(),
    })),
  };
  const roots = {
    schemaVersion: 1,
    channel: "stable",
    keys: [{ id: "test-key", publicKey }],
    distributionOrigins: ["https://dist.example.com"],
  };
  const current = {
    releaseId: "v1.0.0",
    schema: 1,
    channel: "stable",
    platform: process.platform,
    arch: process.arch,
    protocols: {
      api: { min: 1, max: 1 },
      web: { min: 1, max: 1 },
      installer: { min: 1, max: 1 },
    },
    bridges: [],
    generation: 1,
    apiDigest: OLD,
    apiInputFingerprint: H,
    coordinatorDigest: OLD,
    coordinatorInputFingerprint: H,
    webDigest: OLD,
    webInputFingerprint: H,
    installerDigest: installerHandoff ? OLD : H,
    installerInputFingerprint: H,
  };
  const envelope = signManifest(manifest, "test-key", privateKey);
  const plan = freezePlan(verifyManifest(envelope, roots, current), current);
  const blockedStep = installerHandoff
    ? "installer-handoff"
    : "coordinator-handoff";
  const blockedIndex = plan.steps.findIndex((s) => s.stepId === blockedStep);
  const lastStep = plan.steps[blockedIndex - 1];
  const steps = new Map(
    plan.steps.map((s, i) => [
      s.stepId,
      {
        stepId: s.stepId,
        applied: terminal || i < blockedIndex,
        completedWork: terminal || i < blockedIndex ? s.totalWork : 0,
        receiptDigest: terminal || i < blockedIndex ? digest(s.stepId) : null,
        evidence: { immutableCheckpoint: s.stepId },
      },
    ]),
  );
  if (checkpointEvidence !== undefined)
    steps.get(lastStep.stepId).evidence = structuredClone(checkpointEvidence);
  const attempt = {
    instanceId: "progress-instance",
    attemptId: ID,
    actorId: "operator",
    requestId: "22222222-2222-4222-8222-222222222224",
    targetReleaseId: manifest.releaseId,
    targetDigest: envelope.manifestDigest,
    planDigest: plan.planDigest,
    generation: 2,
    sequence: 7,
    state: terminal
      ? "activation-confirmed"
      : installerHandoff
        ? "package-verified"
        : "candidate-ready",
    stage: terminal ? "activation-confirm" : lastStep.stepId,
    acceptedAt: new Date(Date.now() - 120000).toISOString(),
    observedAt: new Date(Date.now() - 60000).toISOString(),
    reason: null,
  };
  let controllerId = null,
    fence = 4,
    leaseExpiresAt = Date.now() + 30000;
  const events = [],
    errors = [],
    renewals = [],
    calls = [];
  const operation = deferred(),
    secondProgress = deferred(),
    thirdProgress = deferred(),
    progressAck = deferred();
  const stopped = new AbortController();
  let running;
  function snapshot() {
    const rows = [...steps.values()];
    const totalWork = plan.steps.reduce((sum, s) => sum + s.totalWork, 0);
    const completedWork = rows.reduce((sum, s) => sum + s.completedWork, 0);
    const fraction = plan.steps.reduce(
      (sum, s) => sum + steps.get(s.stepId).completedWork / s.totalWork,
      0,
    );
    const percent =
      attempt.state === "activation-confirmed"
        ? 100
        : Math.min(99, Math.floor((100 * fraction) / plan.steps.length));
    return {
      ...(progressCapability === undefined
        ? {}
        : { controllerCapabilities: { progressEvidenceReference: progressCapability } }),
      attempt: { ...attempt, totalWork, completedWork, percent },
      actorId: "operator",
      signedManifest: envelope,
      manifest,
      plan,
      sourceActivation: {
        releaseId: current.releaseId,
        schema: 1,
        channel: "stable",
        activationGeneration: 1,
        components: {
          api: artifact(OLD),
          coordinator: artifact(OLD),
          web: { ...artifact(OLD), webRevision: "c".repeat(40) },
          installer: artifact(current.installerDigest),
        },
      },
      fence,
      controllerId,
      leaseExpiresAt,
      appliedSteps: rows.filter((s) => s.applied).map((s) => ({ ...s })),
    };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const send = (value) => res.end(JSON.stringify(value));
    try {
      const path = req.url;
      calls.push(path);
      if (req.method === "GET") {
        if (path.includes("/steps/"))
          return send(steps.get(decodeURIComponent(path.split("/steps/")[1])));
        return send(snapshot());
      }
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      if (path.endsWith("/claim")) {
        controllerId = body.controllerId;
        return send({
          fence,
          generation: attempt.generation,
          snapshot: snapshot(),
        });
      }
      if (path.endsWith("/renew")) {
        if (!body.checkOnly) {
          renewals.push(body);
          if (renewError) {
            if (renewError === "STALE_FENCE") fence++;
            else if (renewError === "UPGRADE_FENCE_EXPIRED")
              leaseExpiresAt = Date.now() - 1;
            res.writeHead(409);
            return send({ code: renewError });
          }
          assert.equal(body.controllerId, controllerId);
          leaseExpiresAt = Date.now() + 30000;
        }
        assert.equal(body.fence, fence);
        assert.ok(leaseExpiresAt > Date.now());
        return send({
          fence,
          generation: attempt.generation,
          snapshot: snapshot(),
        });
      }
      assert.ok(path.endsWith("/commit"));
      assert.equal(
        body.fence,
        fence,
        "only current fence may observe or complete work",
      );
      assert.equal(body.generation, attempt.generation);
      assert.equal(
        body.expectedSequence,
        attempt.sequence,
        "observation and work commits share one serialized sequence",
      );
      if (body.kind === "progress" || body.kind === "step-applied") {
        const step = plan.steps.find((s) => s.stepId === body.payload.stepId),
          row = steps.get(step?.stepId);
        assert.ok(step && row);
        assert.ok(
          plan.steps
            .slice(0, plan.steps.indexOf(step))
            .every((s) => steps.get(s.stepId).applied),
        );
        assert.ok(
          body.payload.completedWork >= row.completedWork &&
            body.payload.completedWork <= step.totalWork,
        );
        if (Object.hasOwn(body.payload, "evidenceDigest")) {
          assert.equal(progressCapability, 1);
          assert.equal(body.kind, "progress");
          assert.equal(Object.hasOwn(body.payload, "evidence"), false);
          assert.equal(body.payload.stepId, attempt.stage);
          assert.equal(body.payload.completedWork, row.completedWork);
          assert.equal(body.payload.evidenceDigest, digest(row.evidence));
        }
        if (body.kind === "step-applied") {
          assert.equal(body.payload.completedWork, step.totalWork);
          row.applied = true;
          row.completedWork = body.payload.completedWork;
          row.evidence = body.payload.evidence;
          row.receiptDigest = body.payload.receiptDigest;
        } else if (!row.applied) {
          row.completedWork = body.payload.completedWork;
          if (Object.hasOwn(body.payload, "evidence"))
            row.evidence = body.payload.evidence;
        }
        attempt.stage = step.stepId;
        attempt.state =
          {
            verify: "package-verified",
            candidate: "candidate-ready",
            "installer-handoff": "prepared",
            "coordinator-handoff": "prepared",
          }[step.kind] ?? attempt.state;
      } else if (body.kind === "failed") attempt.state = "failed";
      else throw new Error("Unexpected commit kind " + body.kind);
      attempt.sequence++;
      attempt.observedAt = new Date().toISOString();
      events.push(structuredClone(body));
      const result = snapshot();
      if (
        body.kind === "progress" &&
        events.filter((e) => e.kind === "progress").length === 2
      ) {
        secondProgress.resolve(result);
        if (holdSecondAck) await progressAck.promise;
      }
      if (
        body.kind === "progress" &&
        events.filter((e) => e.kind === "progress").length === 3
      ) thirdProgress.resolve(result);
      send(result);
    } catch (error) {
      errors.push(error.message);
      res.writeHead(409);
      send({ code: "TEST_CONTRACT_REJECTED" });
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const coordinator = createCoordinatorClient({
    origin: "http://127.0.0.1:" + server.address().port,
    instanceId: attempt.instanceId,
    key: "synthetic-progress-key-32-characters",
  });
  await atomicJson(join(root, "trust.json"), roots);
  const executor = {
    coordinatorHandoff: async () => {
      await operation.promise;
      return {
        qualified: true,
        originalResourcesPreserved: true,
        singleWriter: true,
        maxControlPauseMs: 0,
      };
    },
    installerCandidate: async () => {
      await operation.promise;
      return {
        artifactDigest: manifest.components.installer.artifactDigest,
        inputFingerprint: manifest.components.installer.inputFingerprint,
        operationId: "original-installer-operation",
      };
    },
    installerHandoff: async () => {},
    applyRoute: async () => {
      throw Object.assign(Error("Deliberate boundary after held operation"), {
        code: "EXPECTED_ROUTE_BOUNDARY",
      });
    },
    actual: async () => ({ weight: 0 }),
    fallbackEligibility: async () => ({ qualified: false }),
  };
  const controller = createInstanceController({
    root,
    instanceId: attempt.instanceId,
    controllerId: "progress-controller",
    trustRootPath: join(root, "trust.json"),
    coordinator,
    executor,
    signal: stopped.signal,
  });
  t.after(async () => {
    stopped.abort();
    operation.resolve();
    progressAck.resolve();
    await running?.catch(() => {});
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    await rm(root, { recursive: true, force: true });
  });
  return {
    controller,
    snapshot,
    steps,
    events,
    errors,
    calls,
    renewals,
    operation,
    secondProgress,
    thirdProgress,
    progressAck,
    stopped,
    setProgressCapability: (value) => { progressCapability = value; },
    run: () => {
      running = controller.runOnce();
      running.catch(() => {});
      return running;
    },
  };
}

test(
  "long handoff reobserves unchanged durable work and serializes its real progress ACK with normal completion",
  { timeout: 8000 },
  async (t) => {
    const f = await fixture(t, { holdSecondAck: true }),
      before = f.snapshot();
    assert.ok(Date.now() - Date.parse(before.attempt.observedAt) > 5000);
    const originalCandidate = structuredClone(f.steps.get("candidate"));
    const running = f.run();
    const refreshed = await f.secondProgress.promise;
    assert.equal(refreshed.attempt.percent, before.attempt.percent);
    assert.equal(refreshed.attempt.completedWork, before.attempt.completedWork);
    assert.equal(refreshed.attempt.totalWork, before.attempt.totalWork);
    assert.ok(refreshed.attempt.percent > 0 && refreshed.attempt.percent < 100);
    assert.ok(Date.now() - Date.parse(refreshed.attempt.observedAt) < 5000);
    assert.equal(refreshed.attempt.stage, "candidate");
    assert.deepEqual(f.steps.get("candidate"), originalCandidate);
    assert.equal(f.steps.get("coordinator-handoff").applied, false);
    for (const event of f.events) {
      assert.equal(event.kind, "progress");
      assert.equal(event.payload.stepId, "candidate");
      assert.equal(event.payload.completedWork, 1);
      assert.deepEqual(event.payload.evidence, originalCandidate.evidence);
      assert.equal(Object.hasOwn(event.payload, "evidenceDigest"), false);
    }
    f.operation.resolve();
    await delay(100);
    assert.equal(
      f.events.some((e) => e.kind === "step-applied"),
      false,
      "completion cannot overtake an unacknowledged observation",
    );
    f.progressAck.resolve();
    await assert.rejects(running, { code: "EXPECTED_ROUTE_BOUNDARY" });
    assert.deepEqual(f.errors, []);
    assert.deepEqual(
      f.events.map((e) => e.expectedSequence),
      f.events.map((_, i) => before.attempt.sequence + i),
    );
    const after = f.events.length;
    await delay(1100);
    assert.equal(
      f.events.length,
      after,
      "finally stops and settles observations; no late progress can overwrite failure",
    );
  },
);

test('a delayed progress acknowledgement does not stop independent lease renewal', { timeout: 8000 }, async t => {
  const f = await fixture(t, { holdSecondAck: true });
  const running = f.run();
  await f.secondProgress.promise;
  const before = f.renewals.length;
  await delay(2200);
  assert.ok(f.renewals.length >= before + 2, 'the active lease keeps renewing while the progress response is held');
  assert.equal(f.events.filter(e => e.kind === 'progress').length, 2, 'slow progress requests remain single flight');
  f.progressAck.resolve(); f.operation.resolve();
  await assert.rejects(running, { code: 'EXPECTED_ROUTE_BOUNDARY' });
  assert.deepEqual(f.errors, []);
});

test(
  "fresh Coordinator capability switches unchanged large checkpoints to small digest heartbeats",
  { timeout: 7000 },
  async (t) => {
    const evidence = {
      immutableCheckpoint: "candidate",
      observedAt: "2026-10-19T12:50:51.661Z",
      owner: { operations: [{ history: "x".repeat(1600000) }] },
    };
    const f = await fixture(t, {
      progressCapability: "1", // An unknown version is not an advertised v1 capability.
      checkpointEvidence: evidence,
    });
    const before = f.snapshot(), original = structuredClone(f.steps.get("candidate"));
    const running = f.run();
    await f.secondProgress.promise;
    assert.ok(f.renewals.length >= 2);
    for (const event of f.events) {
      assert.deepEqual(event.payload.evidence, evidence);
      assert.equal(Object.hasOwn(event.payload, "evidenceDigest"), false);
    }
    // The accepted/claimed snapshot lacked support. Only a newly read snapshot
    // may opt into the contract after the Coordinator has changed.
    f.setProgressCapability(1);
    const refreshed = await f.thirdProgress.promise;
    const heartbeat = f.events.at(-1);
    assert.equal(heartbeat.kind, "progress");
    assert.deepEqual(heartbeat.payload, {
      stepId: "candidate",
      completedWork: original.completedWork,
      totalWork: 1,
      evidenceDigest: digest(evidence),
      stage: before.attempt.state,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(heartbeat.payload)) < 512);
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) > 1600000);
    assert.deepEqual(f.steps.get("candidate"), original);
    for (const field of ["percent", "completedWork", "totalWork", "stage"])
      assert.equal(refreshed.attempt[field], before.attempt[field]);
    assert.ok(Date.parse(refreshed.attempt.observedAt) > Date.parse(before.attempt.observedAt));
    assert.equal(f.steps.get("coordinator-handoff").applied, false);
    f.operation.resolve();
    await assert.rejects(running, { code: "EXPECTED_ROUTE_BOUNDARY" });
    const completion = f.events.find((e) => e.kind === "step-applied");
    assert.ok(Object.hasOwn(completion.payload, "evidence"));
    assert.equal(Object.hasOwn(completion.payload, "evidenceDigest"), false);
    assert.deepEqual(f.errors, []);
  },
);

for (const code of ["STALE_FENCE", "UPGRADE_FENCE_EXPIRED"]) {
  test(
    `${code} renewal never reobserves old work and leaves no late observation`,
    { timeout: 6000 },
    async (t) => {
      const f = await fixture(t, { renewError: code }),
        before = f.snapshot();
      const running = f.run();
      await delay(1200);
      assert.ok(f.renewals.length >= 1);
      f.operation.resolve();
      await assert.rejects(running, { code });
      assert.equal(f.events.length, 0);
      assert.equal(f.snapshot().attempt.observedAt, before.attempt.observedAt);
      assert.equal(f.snapshot().attempt.percent, before.attempt.percent);
      const renewals = f.renewals.length;
      await delay(1100);
      assert.equal(f.renewals.length, renewals);
      assert.equal(f.events.length, 0);
    },
  );
}

test(
  "renewal transport failure records the real fault without refreshing numeric work or continuing the timer",
  { timeout: 6000 },
  async (t) => {
    const f = await fixture(t, { renewError: "UPGRADE_RPC_TIMEOUT" });
    const running = f.run();
    await delay(1200);
    assert.ok(f.renewals.length >= 1);
    f.operation.resolve();
    await assert.rejects(running, { code: "UPGRADE_RPC_TIMEOUT" });
    assert.deepEqual(
      f.events.map((e) => e.kind),
      ["failed"],
    );
    assert.equal(f.snapshot().attempt.state, "failed");
    assert.deepEqual(f.errors, []);
    const events = f.events.length,
      renewals = f.renewals.length;
    await delay(1100);
    assert.equal(f.events.length, events);
    assert.equal(f.renewals.length, renewals);
  },
);

test(
  "successful installer handoff stops periodic observations before returning authority",
  { timeout: 7000 },
  async (t) => {
    const f = await fixture(t, { installerHandoff: true });
    const running = f.run();
    await f.secondProgress.promise;
    f.operation.resolve();
    assert.equal((await running).state, "controller-handoff");
    assert.deepEqual(f.errors, []);
    assert.ok(
      f.events.some(
        (e) =>
          e.kind === "step-applied" && e.payload.stepId === "installer-handoff",
      ),
    );
    const events = f.events.length,
      renewals = f.renewals.length;
    await delay(1100);
    assert.equal(f.events.length, events);
    assert.equal(f.renewals.length, renewals);
  },
);

test(
  "an already terminal attempt never starts renewal or creates progress observations",
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t, { terminal: true });
    assert.equal((await f.run()).state, "activation-confirmed");
    await delay(1100);
    assert.equal(f.events.length, 0);
    assert.equal(f.renewals.length, 0);
    assert.deepEqual(f.errors, []);
  },
);
