import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStableEntry } from './legacy-entry-208342/stable-entry.mjs';
import { createControlAuthority } from '../upgrade/control-authority.mjs';
import { createControlCommandJournal } from '../upgrade/control-command-journal.mjs';
import { canonical, digest, invariant } from '../upgrade/trust.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const Database = require('better-sqlite3');
const key = 'isolated-shared-historical-entry-key-32';
const instanceId = 'legacy-entry-delegation-counterexample';
function deferred() {
  let resolve;
  const promise = new Promise(ok => { resolve = ok; });
  return { promise, resolve };
}
function persisted(value) {
  const { inFlight, activeWS, httpByDigest, wsByDigest, ...binding } = value;
  return binding;
}
async function listen(server) {
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise(ok => server.close(() => ok()));
}
async function fixture(t) {
  const historical = new URL('./legacy-entry-208342/', import.meta.url);
  const provenance = JSON.parse(await fs.readFile(new URL('provenance.json', historical), 'utf8'));
  assert.equal(provenance.sourceCommit, '208342ea994555c12c3ba42ce3b6aabd0afe9df1');
  for (const file of provenance.files) {
    const bytes = await fs.readFile(new URL(file.path, historical));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  const close = [];
  const barriers = [];
  t.after(async () => {
    for (const barrier of barriers) barrier.resolve();
    for (const release of close.reverse()) await release();
  });
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'legacy-entry-delegation-')));
  close.push(() => fs.rm(home, { recursive: true, force: true }));
  const sqlite = new Database(join(home, 'control.sqlite'));
  close.push(() => sqlite.close());
  sqlite.pragma('journal_mode=WAL');
  const backends = [];
  for (const label of ['source', 'fixed-command-target', 'second-actor-target']) {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ externalHttpFixture: label }));
    });
    const origin = await listen(server);
    close.push(() => closeServer(server));
    backends.push({ origin, digest: digest({ externalHttpFixture: label }) });
  }
  const web = join(home, 'web');
  await fs.mkdir(web);
  await fs.writeFile(join(web, 'index.html'), 'isolated delegation counterexample');
  const initial = {
    instanceId, attemptId: 'initial-source', fence: 1, routeGeneration: 1, weight: 0,
    oldApi: backends[0], candidateApi: null,
    web: { root: web, digest: digest({ fixtureWeb: true }), treeDigest: digest({ fixtureTree: true }) },
    retainedWeb: [],
  };
  const authority = createControlAuthority({ sqlite, instanceId, epochFloor: 1 });
  authority.activate({ expectedRevision: authority.observe().revision, sourceBindingDigest: digest(initial) });
  const operationId = randomUUID(), executorId = 'isolated-new-control';
  const scope = { operationId, epoch: 2, executorId, kind: 'maintenance' };
  authority.grant({ ...scope, leaseMs: 30000 });
  const journal = createControlCommandJournal({
    sqlite, instanceId,
    assertAuthority(a, command) {
      return authority.assert({ operationId: command.operationId, epoch: a.epoch, executorId: a.executorId, kind: 'maintenance' });
    },
  });
  const checks = [];
  let delayed;
  // A real HTTP verifier deliberately implements the proposed narrow window:
  // actual authority + unique executing fixed command + canonical spec digest.
  // Historical Entry sends NO pending binding/commandId to this verifier, so
  // even this guard cannot bind its successful result to the pending payload.
  const verifier = http.createServer((req, res) => {
    void (async () => {
      invariant(req.method === 'POST' && req.url === '/renew' && req.headers['x-platform-internal-key'] === key, 'COUNTEREXAMPLE_VERIFIER_AUTH');
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        invariant(Buffer.byteLength(text) <= 4096, 'COUNTEREXAMPLE_BODY_LIMIT');
      }
      const input = JSON.parse(text);
      invariant(Object.keys(input).sort().join(',') === 'attemptId,checkOnly,controllerId,fence,instanceId' && input.checkOnly === true && input.controllerId === null && input.instanceId === instanceId, 'COUNTEREXAMPLE_CHECK_ONLY_REQUIRED');
      const current = authority.assert({ operationId: input.attemptId, epoch: input.fence, executorId, kind: 'maintenance' });
      const rows = sqlite.prepare("SELECT operation_id,command_id FROM control_commands WHERE instance_id=? AND state='executing'").all(instanceId);
      invariant(rows.length === 1, 'COUNTEREXAMPLE_UNIQUE_COMMAND_REQUIRED');
      const command = journal.lookup({ operationId: rows[0].operation_id, commandId: rows[0].command_id });
      invariant(command.operationId === current.operationId && command.epoch === current.epoch && command.executorId === current.holderId && command.spec.kind === 'legacy-entry-binding' && command.spec.instanceId === instanceId && command.spec.deadline > Date.now(), 'COUNTEREXAMPLE_COMMAND_SCOPE');
      assert.equal(command.specDigest, digest(command.spec));
      checks.push({ input, specDigest: command.specDigest, validatedAt: Date.now() });
      const receipt = { fence: current.epoch, generation: current.epoch };
      if (delayed) {
        const barrier = delayed;
        delayed = undefined;
        barrier.validated.resolve();
        await barrier.reply.promise;
        // Deliberately return the already evaluated result. This models the
        // HTTP verification-result boundary, NOT an injected atomicJson barrier
        // or proof that the historical handler's filesystem commit was paused.
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(receipt));
    })().catch(error => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: error.code || 'COUNTEREXAMPLE_VERIFIER_REJECTED' }));
    });
  });
  const verifierOrigin = await listen(verifier);
  close.push(() => closeServer(verifier));
  const entry = await createStableEntry({
    root: join(home, 'entry'), instanceId, controlKey: key, stickyKey: 's'.repeat(32), initialBinding: initial,
    verifyFence: async value => {
      const response = await fetch(verifierOrigin + '/renew', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-internal-key': key },
        body: JSON.stringify({ ...value, controllerId: null, checkOnly: true }), signal: AbortSignal.timeout(3000),
      });
      const receipt = await response.json();
      invariant(response.ok, receipt.code || 'COUNTEREXAMPLE_VERIFIER_REJECTED');
      return receipt;
    },
  });
  close.push(() => entry.close());
  const before = persisted(entry.observe());
  const fixedAfter = { ...before, attemptId: operationId, fence: scope.epoch, routeGeneration: before.routeGeneration + 1, weight: 100, candidateApi: backends[1] };
  const spec = {
    schemaVersion: 1, kind: 'legacy-entry-binding', instanceId,
    before, after: fixedAfter, expectedBindingDigest: digest(before), targetBindingDigest: digest(fixedAfter),
    deadline: Date.now() + 10000,
  };
  const commandId = operationId + ':fixed-binding';
  const authorization = { ...scope, expiresAt: authority.observe().leaseExpiresAt };
  journal.prepare({ operationId, commandId, stepId: 'legacy-entry-binding', spec, authorization });
  journal.begin({ operationId, commandId, authorization });
  async function post(path, body) {
    const response = await fetch(entry.controlOrigin + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-internal-key': key },
      body: canonical(body), signal: AbortSignal.timeout(4000),
    });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await post('/fence', { instanceId, attemptId: operationId, fence: scope.epoch })).status, 200);
  return {
    entry, authority, journal, scope, commandId, fixedAfter, backends, checks, post,
    delayNextValidatedResult() {
      const validated = deferred(), reply = deferred();
      barriers.push(reply);
      delayed = { validated, reply };
      return { validated: validated.promise, release: () => reply.resolve() };
    },
  };
}

test('COUNTEREXAMPLE: a second actor sharing the historical Entry key can substitute a payload inside the genuine fixed-command window', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const command = f.journal.lookup({ operationId: f.scope.operationId, commandId: f.commandId });
  assert.equal(command.state, 'executing');
  assert.equal(command.specDigest, digest(command.spec));
  const otherPayload = { ...f.fixedAfter, candidateApi: f.backends[2] };
  assert.notEqual(digest(otherPayload), command.spec.targetBindingDigest);
  // This is the observed risk, not a passing adoption/CAS qualification. The
  // second actor presents the very same old key/id/fence but a different route.
  const response = await f.post('/binding', otherPayload);
  assert.equal(response.status, 200);
  assert.deepEqual(persisted(f.entry.observe()), otherPayload);
  const publicResponse = await fetch(f.entry.origin + '/api/counterexample');
  assert.equal(publicResponse.status, 200);
  assert.deepEqual(await publicResponse.json(), { externalHttpFixture: 'second-actor-target' });
  assert.equal(f.journal.lookup({ operationId: f.scope.operationId, commandId: f.commandId }).state, 'executing');
  assert.ok(f.checks.length >= 2);
  assert.ok(f.checks.every(check => Object.keys(check.input).sort().join(',') === 'attemptId,checkOnly,controllerId,fence,instanceId'));
});

test('COUNTEREXAMPLE: revoking authority does not invalidate an already evaluated delayed HTTP verification result', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const delay = f.delayNextValidatedResult();
  const pending = f.post('/binding', f.fixedAfter);
  try {
    await delay.validated;
    f.authority.release(f.scope);
    assert.equal(f.authority.observe().leaseExpiresAt, 0);
    delay.release();
    assert.equal((await pending).status, 200);
    assert.deepEqual(persisted(f.entry.observe()), f.fixedAfter);
    // Fresh verification really is closed. Only the old successful result was
    // delayed; no timer, fixture boolean or fabricated accepted attempt grants it.
    const later = await f.post('/binding', { ...f.fixedAfter, routeGeneration: f.fixedAfter.routeGeneration + 1, weight: 0 });
    assert.equal(later.status, 409);
    assert.equal(later.body.code, 'CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED');
    assert.deepEqual(persisted(f.entry.observe()), f.fixedAfter);
  } finally {
    delay.release();
    await pending;
  }
});
