import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './trust.mjs';
import { prepareCoordinatorPhased, inspectHeldCoordinatorPreparation } from './coordinator-preparation.mjs';

// Deterministic phase/deadline and crash-boundary checks. Real transport is
// exercised separately by prepare-budget.test and preparation-status.test.
const scope = { instanceId: 'private-instance-marker', attemptId: 'original-attempt',
  operationId: 'original-operation', planDigest: digest('plan'), targetDigest: digest('target'), fence: 7 };
const candidate = { artifactDigest: digest('coordinator'), startIdentity: 'original-process',
  pid: 42, origin: 'http://127.0.0.1:1234', artifactRoot: '/private/candidate-root' };
const prepared = () => ({ stage: 'prepared', commitKnown: true, applied: false, resumeAction: 'quiesce' });
const unknown = () => new DOMException('Response lost', 'TimeoutError');
const timedPrepareFailure = () => Object.assign(unknown(), {
  rpcContext: { action: 'prepare', startedAt: '2026-11-10T00:00:00.000Z',
    traceId: '11111111-1111-4111-8111-111111111111', timeoutMs: 100, elapsedMs: 95,
    bindingMs: 1, serializationMs: 0.1, firstResponseMs: null, decodeMs: null },
  preparationOutcome: { requestDispatched: true, responseDecoded: false },
});

function fixture(overrides = {}) {
  let now = 1000, last;
  const calls = [], records = [];
  const tick = ms => { now += ms; };
  const input = { scope, budgetMs: 100, clock: () => now,
    checkpoint: async value => { last = structuredClone(value); records.push(last); },
    assertFence: async () => {},
    start: async timeout => { calls.push(['start', timeout]); return candidate; },
    ready: async deadline => { calls.push(['ready', deadline]); },
    baseline: async deadline => { calls.push(['baseline', deadline]); },
    prepare: async (body, options) => {
      calls.push(['prepare', structuredClone(body), options]);
      assert.equal(last.prepareSent, true);
      assert.equal(last.state, 'preparing');
      return { commitKnown: true, stage: 'prepared' };
    },
    status: async (body, options) => { calls.push(['status', body, options]); return prepared(); },
    quiesce: async body => { calls.push(['quiesce', body]); return { commitKnown: true }; },
    release: async body => { calls.push(['release', body]); return { commitKnown: true }; },
    adopt: async body => { calls.push(['adopt', body]); return { commitKnown: true, evidence: { qualified: true } }; },
    pause: async ms => { tick(ms); },
  };
  Object.assign(input, overrides({ tick, calls, records, input, last: () => last }));
  return { input, tick, calls, records, last: () => last, run: () => prepareCoordinatorPhased(input) };
}
const mutations = f => f.calls.filter(([kind]) => ['prepare', 'quiesce', 'release', 'adopt'].includes(kind));

test('two signed phases each retain their own bounded clock and one original prepare', async () => {
  const f = fixture(({ tick }) => ({ ready: async () => tick(70), prepare: async () => {
    tick(80); return { commitKnown: true, stage: 'prepared' };
  } }));
  await f.run();
  assert.equal(f.last().startupDeadline, 1100);
  assert.equal(f.last().prepareStartedAt, 1070);
  assert.equal(f.last().prepareDeadline, 1170);
  assert.equal(f.last().state, 'adopted-known');
  assert.deepEqual(mutations(f).map(([kind]) => kind), ['quiesce', 'release', 'adopt']);
  assert.equal(f.records.filter(row => row.prepareSentAt !== undefined)[0].prepareSentAt, 1070);
});

test('A expiry cannot open B or send prepare', async () => {
  const f = fixture(({ tick }) => ({ ready: async () => tick(100) }));
  await assert.rejects(f.run(), { code: 'COORDINATOR_PREPARATION_HELD', suppressRecovery: true });
  assert.equal(f.last().state, 'startup-held');
  assert.equal(f.last().prepareDeadline, null);
  assert.equal(f.last().firstPrepareFailureCode, null);
  assert.equal(f.last().firstPrepareFailureAt, null);
  assert.equal(f.last().firstPrepareRpc, null);
  assert.equal(f.last().holdReasonCode, 'COORDINATOR_PREPARATION_EXPIRED');
  assert.deepEqual(mutations(f), []);
});

test('prepare lost ACK reconciles only the original operation, absent never resends', async () => {
  let queries = 0;
  const f = fixture(({ calls, last }) => ({
    prepare: async body => {
      assert.equal(last().prepareSent, true);
      calls.push(['prepare', body]); throw unknown();
    },
    status: async (body, options) => {
      calls.push(['status', body, options]);
      return ++queries === 1 ? { stage: 'absent', definitelyNotApplied: true } : prepared();
    },
    pause: async () => {},
  }));
  await f.run();
  assert.deepEqual(mutations(f).map(([kind]) => kind), ['prepare', 'quiesce', 'release', 'adopt']);
  assert.equal(queries, 2);
  for (const [, body, options] of f.calls.filter(([kind]) => kind === 'status')) {
    assert.equal(body.operationId, scope.operationId);
    assert.equal(body.fence, scope.fence);
    assert.deepEqual(body.candidate, candidate);
    assert.equal(options.statusRead.deadline, 1100);
  }
});

test('late prepared is classification only; no critical mutation after B expiry', async () => {
  const f = fixture(({ tick, calls }) => ({ prepare: async body => {
    calls.push(['prepare', body]); tick(101); throw unknown();
  } }));
  await assert.rejects(f.run(), { code: 'COORDINATOR_PREPARATION_HELD', suppressRecovery: true });
  assert.equal(f.last().state, 'expired-held');
  assert.equal(f.last().statusClassification, 'prepared');
  assert.equal(f.calls.filter(([kind]) => kind === 'status').length, 1);
  assert.deepEqual(mutations(f).map(([kind]) => kind), ['prepare']);
  assert.equal(f.last().prepareDeadline, 1100);
});

test('prepare timeout survives absent status and remaining-clock expiry as the first RPC failure', async () => {
  const f = fixture(({ tick, calls }) => ({
    prepare: async body => { calls.push(['prepare', body]); tick(95); throw timedPrepareFailure(); },
    status: async body => { calls.push(['status', body]); tick(3); return { stage: 'absent', definitelyNotApplied: true }; },
  }));
  await assert.rejects(f.run(), error => {
    const evidence = error.faultEvidence.coordinatorPreparation;
    assert.equal(evidence.firstPrepareFailureCode, 'UPGRADE_RPC_TIMEOUT');
    assert.equal(evidence.firstPrepareFailureAt, 1095);
    assert.equal(evidence.firstPrepareRpc.elapsedMs, 95);
    assert.equal(evidence.firstPrepareRpc.firstResponseMs, null);
    assert.equal(evidence.lastFailureCode, 'COORDINATOR_PREPARATION_EXPIRED');
    assert.equal(evidence.holdReasonCode, 'COORDINATOR_PREPARATION_EXPIRED');
    return error.code === 'COORDINATOR_PREPARATION_HELD';
  });
  assert.equal(f.last().prepareDeadline, 1100);
  assert.equal(f.last().heldAt, 1100);
  assert.equal(f.last().statusClassification, 'absent-not-proof');
  assert.equal(f.last().firstPrepareFailureCode, 'UPGRADE_RPC_TIMEOUT');
  assert.deepEqual(f.last().firstPrepareRpc, f.last().prepareRpc);
  for (const row of f.records.filter(row => row.firstPrepareFailureCode !== null)) {
    assert.equal(row.firstPrepareFailureAt, 1095);
    assert.deepEqual(row.firstPrepareRpc, f.last().firstPrepareRpc);
  }
  assert.deepEqual(mutations(f).map(([kind]) => kind), ['prepare']);
});

test('status or fence failures retain the original prepare RPC cause and a separate final hold reason', async t => {
  for (const phase of ['status', 'fence']) await t.test(phase, async () => {
    let sent = false;
    const code = phase === 'status' ? 'STATUS_READ_FAILED' : 'UPGRADE_FENCE_EXPIRED';
    const f = fixture(({ calls, tick }) => ({
      prepare: async body => { calls.push(['prepare', body]); tick(50); sent = true; throw timedPrepareFailure(); },
      assertFence: async () => { if (sent && phase === 'fence') throw Object.assign(Error(code), { code }); },
      status: async () => { calls.push(['status']); throw Object.assign(Error(code), { code }); },
    }));
    await assert.rejects(f.run(), error => {
      const evidence = error.faultEvidence.coordinatorPreparation;
      assert.equal(evidence.firstPrepareFailureCode, 'UPGRADE_RPC_TIMEOUT');
      assert.equal(evidence.firstPrepareFailureAt, 1050);
      assert.equal(evidence.firstPrepareRpc.traceId, timedPrepareFailure().rpcContext.traceId);
      assert.equal(evidence.lastFailureCode, code);
      assert.equal(evidence.holdReasonCode, code);
      return error.code === 'COORDINATOR_PREPARATION_HELD';
    });
    assert.deepEqual(mutations(f).map(([kind]) => kind), ['prepare']);
    assert.equal(f.last().prepareDeadline, 1100);
  });
});

test('expiry after a successful prepare response does not invent an RPC failure', async () => {
  const f = fixture(({ tick, calls }) => ({
    prepare: async body => { calls.push(['prepare', body]); tick(100); return { stage: 'prepared', commitKnown: true }; },
  }));
  await assert.rejects(f.run(), error => {
    const evidence = error.faultEvidence.coordinatorPreparation;
    assert.equal(evidence.firstPrepareFailureCode, null);
    assert.equal(evidence.firstPrepareFailureAt, null);
    assert.equal(evidence.firstPrepareRpc, null);
    assert.equal(evidence.holdReasonCode, 'COORDINATOR_PREPARATION_EXPIRED');
    return error.code === 'COORDINATOR_PREPARATION_HELD';
  });
  assert.deepEqual(mutations(f).map(([kind]) => kind), ['prepare']);
});

test('completed hard rejection and lost authority do not poll or mutate further', async t => {
  for (const code of ['HANDOFF_INTENT_CONFLICT', 'UPGRADE_FENCE_EXPIRED', 'CANDIDATE_IDENTITY_CHANGED'])
    await t.test(code, async () => {
      const f = fixture(() => ({ prepare: async () => { throw Object.assign(Error(code), { code, status: 409 }); } }));
      await assert.rejects(f.run(), { code: 'COORDINATOR_PREPARATION_HELD' });
      assert.equal(f.last().firstPrepareFailureCode, code);
      assert.equal(f.last().firstPrepareRpc, null);
      assert.equal(f.last().lastFailureCode, code);
      assert.equal(f.last().holdReasonCode, code);
      assert.equal(f.calls.filter(([kind]) => kind === 'status').length, 0);
      assert.deepEqual(mutations(f), []);
    });
});

test('status scope mismatch or unknown read cannot authorize quiesce', async t => {
  for (const response of ['foreign', 'nested-foreign', 'timeout', 'quiesced']) await t.test(response, async () => {
    const f = fixture(({ calls }) => ({ prepare: async () => { throw unknown(); }, status: async () => {
      calls.push(['status']);
      if (response === 'timeout') throw unknown();
      return response === 'foreign' ? { ...prepared(), operationId: 'foreign-operation' }
        : response === 'nested-foreign' ? { ...prepared(), snapshot: { attempt: { attemptId: 'foreign-attempt' } } }
        : { stage: 'quiesced', commitKnown: true, applied: false, resumeAction: 'release' };
    } }));
    await assert.rejects(f.run(), { code: 'COORDINATOR_PREPARATION_HELD' });
    assert.equal(f.calls.filter(([kind]) => kind === 'status').length, 1);
    assert.deepEqual(mutations(f), []);
  });
});

test('a contradictory prepared ACK is a hard hold without status or quiesce', async t => {
  for (const flags of [{ unknown: true }, { definitelyNotApplied: true }, { applied: true }])
    await t.test(JSON.stringify(flags), async () => {
      const f = fixture(() => ({ prepare: async () => ({ stage: 'prepared', commitKnown: true, ...flags }) }));
      await assert.rejects(f.run(), { code: 'COORDINATOR_PREPARATION_HELD' });
      assert.equal(f.last().firstPrepareFailureCode, null);
      assert.equal(f.last().firstPrepareRpc, null);
      assert.equal(f.last().holdReasonCode, 'COORDINATOR_PREPARATION_ACK_INVALID');
      assert.equal(f.calls.filter(([kind]) => kind === 'status').length, 0);
      assert.deepEqual(mutations(f), []);
    });
});

test('deadline spent fsyncing dispatch intent cannot result in a late prepare', async () => {
  const f = fixture(({ input, tick }) => {
    const original = input.checkpoint;
    return { checkpoint: async row => { await original(row); if (row.prepareSent) tick(101); } };
  });
  await assert.rejects(f.run(), { code: 'COORDINATOR_PREPARATION_HELD' });
  assert.deepEqual(mutations(f), []);
});

test('candidate is immutable and no preparation fsync enters release/adopt critical window', async () => {
  let critical = false, pinned;
  const f = fixture(({ input }) => {
    const original = input.checkpoint;
    return { start: async () => { pinned = structuredClone(candidate); return pinned; },
      checkpoint: async row => { assert.equal(critical, false); await original(row); },
      prepare: async body => {
        pinned.startIdentity = 'caller-mutated';
        assert.equal(body.candidate.startIdentity, candidate.startIdentity);
        return { commitKnown: true, stage: 'prepared' };
      },
      quiesce: async body => { critical = true; assert.deepEqual(body.candidate, candidate); return { commitKnown: true }; },
      adopt: async () => { critical = false; return { commitKnown: true }; },
    };
  });
  await f.run();
  assert.equal(f.last().candidate.startIdentity, candidate.startIdentity);
});

test('restart uses current read authority but retains original fence/deadlines and always holds', async t => {
  for (const result of [prepared(), { stage: 'absent', definitelyNotApplied: true }])
    await t.test(result.stage, async () => {
      const f = fixture(({ tick }) => ({ prepare: async () => { tick(101); throw unknown(); } }));
      await assert.rejects(f.run());
      const original = structuredClone(f.last()), statuses = [], records = [];
      await assert.rejects(inspectHeldCoordinatorPreparation({
        scope: { ...scope, fence: 8 }, local: { preparation: original }, clock: () => 9000,
        checkpoint: async row => records.push(row), assertFence: async () => {},
        status: async (body, options) => { statuses.push({ body, options }); return result; },
      }), { code: 'COORDINATOR_PREPARATION_HELD', suppressRecovery: true });
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0].body.fence, 8);
      assert.equal(statuses[0].body.operationId, scope.operationId);
      assert.equal(records[0].fence, 7);
      assert.equal(records[0].inspectionFence, 8);
      assert.equal(records[0].prepareDeadline, original.prepareDeadline);
      assert.equal(records[0].firstPrepareFailureCode, original.firstPrepareFailureCode);
      assert.deepEqual(records[0].firstPrepareRpc, original.firstPrepareRpc);
      assert.equal(records[0].holdReasonCode, original.holdReasonCode);
      assert.equal(records[0].state, 'restart-held');
    });
});

test('missing history cannot be reconstructed from an absent Supervisor', async () => {
  let reads = 0;
  await assert.rejects(inspectHeldCoordinatorPreparation({ scope, local: {},
    checkpoint: async () => {}, status: async () => { reads++; }, assertFence: async () => {} }),
  { code: 'COORDINATOR_PREPARATION_HISTORY_REQUIRED' });
  assert.equal(reads, 0);
});

test('restart fault evidence normalizes historical first-failure fields without rewriting the journal', async () => {
  const f = fixture(() => ({ prepare: async () => { throw unknown(); }, status: async () => { throw unknown(); } }));
  await assert.rejects(f.run());
  const local = { ...structuredClone(f.last()), firstPrepareFailureCode: 'UPGRADE_RPC_TIMEOUT',
    firstPrepareFailureAt: 0, holdReasonCode: 'COORDINATOR_PREPARATION_EXPIRED',
    firstPrepareRpc: { ...timedPrepareFailure().rpcContext, path: 'http://private-origin-marker/',
      headers: { authorization: 'private-header-marker' }, body: candidate, extra: 'private-extra-marker',
      requestDispatched: true, responseDecoded: false } };
  let saved;
  await assert.rejects(inspectHeldCoordinatorPreparation({ scope: { ...scope, fence: 8 },
    local: { preparation: local }, clock: () => 9000, checkpoint: async value => { saved = value; },
    status: async () => prepared(), assertFence: async () => {},
  }), error => {
    const evidence = error.faultEvidence.coordinatorPreparation;
    assert.equal(evidence.firstPrepareFailureCode, 'UPGRADE_RPC_TIMEOUT');
    assert.equal(evidence.firstPrepareFailureAt, 0);
    assert.equal(evidence.holdReasonCode, 'COORDINATOR_PREPARATION_EXPIRED');
    assert.equal(evidence.firstPrepareRpc.path, '/internal/upgrades/:attemptId/coordinator-handoff');
    assert.equal(evidence.firstPrepareRpc.elapsedMs, 95);
    for (const marker of ['private-origin-marker', 'private-header-marker', 'private-extra-marker', candidate.origin, candidate.artifactRoot])
      assert.equal(JSON.stringify(evidence).includes(marker), false);
    return error.code === 'COORDINATOR_PREPARATION_HELD';
  });
  assert.deepEqual(saved.firstPrepareRpc, local.firstPrepareRpc);
  assert.equal(saved.firstPrepareFailureAt, 0);
});

test('restart fault evidence emits null for missing or malformed optional first-failure fields', async t => {
  const f = fixture(() => ({ prepare: async () => { throw unknown(); }, status: async () => { throw unknown(); } }));
  await assert.rejects(f.run());
  for (const kind of ['old-record', 'malformed']) await t.test(kind, async () => {
    const local = structuredClone(f.last());
    for (const key of ['firstPrepareFailureCode', 'firstPrepareFailureAt', 'firstPrepareRpc', 'holdReasonCode']) delete local[key];
    if (kind === 'malformed') Object.assign(local, { firstPrepareFailureCode: 'private-code-marker',
      firstPrepareFailureAt: Infinity, firstPrepareRpc: { action: 'status', headers: 'private-header-marker' },
      holdReasonCode: 'private-reason-marker' });
    await assert.rejects(inspectHeldCoordinatorPreparation({ scope: { ...scope, fence: 8 },
      local: { preparation: local }, clock: () => 9000, checkpoint: async () => {},
      status: async () => prepared(), assertFence: async () => {},
    }), error => {
      const evidence = error.faultEvidence.coordinatorPreparation;
      for (const key of ['firstPrepareFailureCode', 'firstPrepareFailureAt', 'firstPrepareRpc', 'holdReasonCode'])
        assert.equal(evidence[key], null);
      return error.code === 'COORDINATOR_PREPARATION_HELD';
    });
  });
});

test('failure evidence contains fixed timing/classification, no identity markers or candidate paths', async () => {
  const f = fixture(() => ({ prepare: async () => { throw Object.assign(unknown(), {
    rpcContext: { path: '/internal/upgrades/private-instance-marker/coordinator-handoff', action: 'prepare',
      startedAt: '2026-11-10T00:00:00.000Z', elapsedMs: 83, timeoutMs: 100,
      traceId: '11111111-1111-4111-8111-111111111111', firstResponseMs: null, decodeMs: null,
      body: candidate, headers: { authorization: 'secret-header' } },
    preparationOutcome: { requestDispatched: true, responseDecoded: false },
  }); },
    status: async () => { throw unknown(); } }));
  await assert.rejects(f.run(), error => {
    const output = JSON.stringify(error.faultEvidence);
    for (const secret of [scope.instanceId, candidate.origin, candidate.artifactRoot, candidate.startIdentity])
      assert.equal(output.includes(secret), false);
    assert.equal(output.includes('secret-header'), false);
    assert.equal(error.faultEvidence.coordinatorPreparation.prepareRpc.elapsedMs, 83);
    assert.equal(error.faultEvidence.coordinatorPreparation.prepareRpc.method, 'POST');
    assert.deepEqual(error.faultEvidence.coordinatorPreparation.firstPrepareRpc,
      error.faultEvidence.coordinatorPreparation.prepareRpc);
    return error.suppressRecovery === true;
  });
});
