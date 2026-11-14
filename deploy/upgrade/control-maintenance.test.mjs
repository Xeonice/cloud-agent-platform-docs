import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { digest, canonical } from './trust.mjs';
import { treeManifest, atomicJson, fileDigest } from './io.mjs';
import { createControlAuthority } from './control-authority.mjs';
import { createControlRecoveryStore } from './control-recovery-store.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { createControlMaintenance } from './control-maintenance.mjs';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url)), Database = requireApi('better-sqlite3');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'supervisor-control-maintenance-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.parse('2026-10-20T12:00:00Z'), starts = 0, stops = 0, loseStartAck = false, failNew = false, unknownHealth = false, signals = 0;
  const instanceId = 'control-maintenance-fixture', executorId = 'fixed-supervisor-birth', keys = generateKeyPairSync('ed25519'), trust = join(root, 'trust.json'), ledgerRoot = join(root, 'ledger');
  await fs.mkdir(ledgerRoot); await atomicJson(trust, { schemaVersion: 1, keys: [{ id: 'fixture', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] });
  const controlDbPath = join(ledgerRoot, 'control.db'), controlSqlite = new Database(controlDbPath), sqlite = new Database(join(root, 'supervisor.db')); await fs.chmod(controlDbPath, 0o600);
  t.after(() => { sqlite.close(); controlSqlite.close(); });
  const { createUpgradeControlStores } = requireApi(resolve('api/apps/api/dist/platform/upgrade/control-store-factory.js'));
  createUpgradeControlStores({ sqlite: controlSqlite, instanceId, clock: { now: () => new Date(now) }, ids: { next: randomUUID } });
  const authority = createControlAuthority({ sqlite: controlSqlite, instanceId, epochFloor: 5, clock: () => now }); authority.activate({ expectedRevision: 1, sourceBindingDigest: digest('unchanged-source') });
  createControlRecoveryStore({ sqlite: controlSqlite, instanceId, clock: () => now });
  createControlCommandJournal({ sqlite: controlSqlite, instanceId, clock: () => now, assertAuthority: () => {} });
  controlSqlite.exec("CREATE TABLE control_fixture_current_data(value TEXT);INSERT INTO control_fixture_current_data VALUES('current-control-data')");
  const packages = {};
  for (const which of ['old', 'new']) {
    const artifactRoot = join(root, which), base = join(artifactRoot, 'api/apps/api/dist/platform/upgrade'); await fs.mkdir(base, { recursive: true }); await fs.mkdir(join(artifactRoot, 'installer'));
    // Real signed files, SQLite and the maintenance state machine. These tiny
    // role fixtures are not Native process or live Guest qualification.
    await fs.writeFile(join(base, 'control-store-factory.js'), 'exports.fixture=true;\n');
    await fs.writeFile(join(base, 'control-store-schema.js'), 'exports.UPGRADE_CONTROL_SCHEMA_VERSION=1;\n');
    await fs.writeFile(join(artifactRoot, 'api/apps/api/package.json'), '{"name":"@platform/api","type":"commonjs"}');
    await fs.writeFile(join(artifactRoot, 'installer/control-main.mjs'), 'export const version=' + JSON.stringify(which) + ';\n');
    const files = await treeManifest(artifactRoot), executionEngineDigest = digest(files.filter(file => file.path.startsWith('installer/'))), version = which === 'old' ? 'v1.0.0' : 'v1.0.1';
    const manifest = { schemaVersion: 1, kind: 'upgrade-control', version, protocolVersion: 1, apiRevision: 'a'.repeat(40), projectRevision: 'b'.repeat(40), treeDigest: digest(files), executionEngineDigest };
    const manifestPath = join(root, which + '-signed.json'); await atomicJson(manifestPath, { manifest, manifestDigest: digest(manifest), signature: { algorithm: 'Ed25519', keyId: 'fixture', value: sign(null, Buffer.from(canonical(manifest)), keys.privateKey).toString('base64') } });
    const configPath = join(root, which + '-config.json'); await atomicJson(configPath, { instanceId, startIdentity: which + '-agent-birth', controlArtifactRoot: artifactRoot, controlManifestPath: manifestPath, trustRootPath: trust,
      controlLedgerRoot: ledgerRoot, controlRoot: join(root, 'private-auth-unchanged'), accessAuthorityKey: 'synthetic-private-key-never-output', controlPort: 32123 });
    packages[which] = { artifactRoot, manifestPath, trustRootPath: trust, packageDigest: digest(manifest), configPath, configDigest: (await fileDigest(configPath)).digest };
    packages[which].engine = executionEngineDigest; packages[which].version = version;
  }
  const sourceAgent = { containerId: 'a'.repeat(64), startIdentity: 'old-agent-birth', hostPid: 200, birthTicks: '2000', cgroupDigest: digest('original-control-cgroup'), startedAt: new Date(now - 60000).toISOString(), artifactDigest: packages.old.engine, role: 'control-agent', running: true, paused: false, restartCount: 0, restartPolicy: 'no', oomKilled: false, exitCode: 0 };
  const agents = new Map([[sourceAgent.containerId, structuredClone(sourceAgent)]]), commands = new Map();
  const scope = request => ({ instanceId, maintenanceId: request.maintenanceId, commandId: request.commandId, specDigest: request.specDigest });
  const lifecycle = {
    inspect: async id => { assert(agents.has(id)); return structuredClone(agents.get(id)); },
    inventory: async () => ({ instanceId, complete: true, observedAt: new Date(now).toISOString(), agents: [...agents.values()].map(agent => structuredClone(agent)) }),
    async stop(request) { request.assertBeforeDispatch(); assert.equal(request.kind, 'stop-control-agent'); assert.equal(request.signal, 'SIGTERM'); const value = agents.get(request.target.containerId); assert.equal(value.role, 'control-agent'); const wasRunning=value.running; if(wasRunning){ signals++; value.running=false; value.hostPid=0; value.oomKilled=false; value.exitCode=143; } stops++;
      value.finishedAt=new Date(now).toISOString(); const result = { ...structuredClone(value), ...scope(request), forced:false, removed:false, normalExit:wasRunning, terminationObserved:!wasRunning, signal:wasRunning?'SIGTERM':null }; commands.set(request.commandId, result); return result; },
    async start(request) { request.assertBeforeDispatch(); assert.equal(request.kind, 'start-control-agent'); assert.equal([...agents.values()].filter(agent => agent.running).length, 0); starts++;
      const which = request.packageDigest === packages.new.packageDigest ? 'new' : 'old'; assert.equal(request.configPath, packages[which].configPath);
      const value = { ...structuredClone(sourceAgent), containerId: String(starts).repeat(64), startIdentity: which + '-agent-birth', hostPid: 300 + starts, birthTicks: String(3000 + starts), cgroupDigest: digest('started-group-' + starts), startedAt: new Date(now).toISOString(), artifactDigest: packages[which].engine, running: true };
      agents.set(value.containerId, value); const result = { ...structuredClone(value), ...scope(request) }; commands.set(request.commandId, result);
      if (loseStartAck && which === 'new') { loseStartAck = false; throw Error('Fixture dropped ACK after actual effect'); } return result;
    },
    lookup: async request => ({ ...scope(request), state: commands.has(request.commandId) ? 'applied' : 'unknown', ...(commands.has(request.commandId) ? { result: structuredClone(commands.get(request.commandId)) } : {}) }),
    health: async agent => { if (unknownHealth) throw Error('Fixture metadata unavailable'); const which = agent.artifactDigest === packages.new.engine ? 'new' : 'old'; return { instanceId, role: 'installer', pid: 1, startIdentity: which + '-agent-birth', artifactDigest: packages[which].engine,
      observedAt: new Date(now).toISOString(), controlSystem: { version: packages[which].version, protocolVersion: 1, packageDigest: packages[which].packageDigest } }; },
    // Fixed state-layer port. Real Linux capacity collection/admission has its
    // own tests and Native harness; this is not a production resource receipt.
    capacity: async input => ({ instanceId, maintenanceId: input.maintenanceId, commandId: input.commandId, specDigest: input.specDigest, action: input.action,
      requestDigest: digest(input), planDigest: digest('declared-fixture-capacity-plan'), configDigest: digest('declared-fixture-config'), qualified: true, state: 'admitted', observationDigest: digest('declared-fixture-observation'), revision: 1,
      resourcesDigest: digest(input.resources), observedAt: new Date(now).toISOString() }),
  };
  const fixedPackages = Object.fromEntries(Object.entries(packages).map(([key, value]) => { const { engine, version, ...fixed } = value; return [key, fixed]; }));
  const open = () => createControlMaintenance({ sqlite, controlSqlite, controlDbPath, instanceId, executorId, packages: fixedPackages, lifecycle,
    capacityAllocation: { id: 'control-agent', resources: { memoryBytes: 1000000, cpuMilliCores: 250, ioBytesPerSecond: 0, disks: {} } }, clock: () => now });
  let maintenance = open(); const input = { maintenanceId: 'same-maintenance-id', expectedControlEpoch: 5, sourceAgent, deadline: now + 30000, rollbackDeadline: now + 60000 };
  return { root, sqlite, controlSqlite, authority, input, agents, lifecycle, packages: fixedPackages, get maintenance() { return maintenance; }, reopen: () => { maintenance = open(); },
    now: () => now, elapse: ms => { now += ms; }, counts: () => ({ starts, stops }), signalCount:()=>signals, loseStart: () => { loseStartAck = true; }, unknownHealth: value => { unknownHealth = value; },
    failNew: () => { const value = [...agents.values()].find(agent => agent.running && agent.artifactDigest === packages.new.engine); assert(value); value.running = false; value.hostPid = 0; value.exitCode=1; value.oomKilled=false; value.finishedAt=new Date(now).toISOString(); failNew = true; },
  };
}

test('Supervisor persists before stopping Agent and completes the same signed maintenance after object restart without lowering control epoch', async t => {
  const f = await fixture(t); await f.maintenance.submit(f.input); assert.deepEqual(f.counts(), { starts: 0, stops: 0 });
  assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'barrier-held'); assert.equal(f.authority.observe().mode, 'passive'); assert.equal(f.authority.observe().epoch, 6);
  assert.throws(() => f.authority.grant({ operationId: 'other', epoch: 7, executorId: 'other' }), /CONTROL_AUTHORITY_NOT_ACTIVE/);
  f.reopen(); assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'old-stopped');
  assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'new-started');
  const result = await f.maintenance.advance(f.input.maintenanceId); assert.equal(result.phase, 'completed'); assert.equal(result.result.epoch, 6);
  assert.equal(f.authority.observe().mode, 'active'); assert.equal(f.authority.observe().holderId, null); assert.equal(f.authority.observe().epoch, 6);
  assert.deepEqual(f.counts(), { starts: 1, stops: 1 }); assert.deepEqual((await f.maintenance.advance(f.input.maintenanceId)).result, result.result);
});
test('lost startup ACK is resolved by the original command; no second launch occurs and unavailable health preserves passive isolation', async t => {
  const f = await fixture(t); await f.maintenance.submit(f.input); await f.maintenance.advance(f.input.maintenanceId); await f.maintenance.advance(f.input.maintenanceId);
  f.loseStart(); assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'blocked'); assert.deepEqual(f.counts(), { starts: 1, stops: 1 });
  f.reopen(); assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'new-started');
  f.unknownHealth(true); assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'blocked'); assert.equal(f.authority.observe().mode, 'passive');
  f.unknownHealth(false); assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'completed'); assert.deepEqual(f.counts(), { starts: 1, stops: 1 });
});
test('a confirmed failed new Agent rolls back old compatible code with the current ledger, using the same maintenance and reserved epoch', async t => {
  const f = await fixture(t); await f.maintenance.submit(f.input);
  for (let i = 0; i < 3; i++) await f.maintenance.advance(f.input.maintenanceId);
  f.controlSqlite.prepare('UPDATE control_fixture_current_data SET value=?').run('data written after maintenance began'); f.failNew();
  assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'rollback-stop-new');
  assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'rollback-old-ready');
  assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'rollback-old-started');
  const result = await f.maintenance.advance(f.input.maintenanceId); assert.equal(result.phase, 'rolled-back'); assert.equal(result.maintenanceId, f.input.maintenanceId);
  assert.equal(f.authority.observe().epoch, 6); assert.equal(f.authority.observe().mode, 'active');
  assert.deepEqual(f.controlSqlite.prepare('SELECT value FROM control_fixture_current_data').get(), { value: 'data written after maintenance began' }); assert.deepEqual(f.counts(), { starts: 2, stops: 2 });
  const terminated = f.maintenance.readAction(f.input.maintenanceId, f.input.maintenanceId + ':rollback-stop-new').result;
  assert.equal(terminated.exitCode,1); assert.equal(terminated.normalExit,false); assert.equal(terminated.terminationObserved,true); assert.equal(terminated.signal,null); assert.equal(f.signalCount(),1);
});
test('the Supervisor can recover an already-crashed exact Agent using its frozen last-known live birth without inventing a normal stop', async t => {
  const f=await fixture(t), crashed=f.agents.get(f.input.sourceAgent.containerId); crashed.running=false; crashed.hostPid=0; crashed.oomKilled=false; crashed.exitCode=1; crashed.finishedAt=new Date(f.now()).toISOString();
  await f.maintenance.submit(f.input); f.reopen(); for(let i=0;i<4;i++)await f.maintenance.advance(f.input.maintenanceId);
  assert.equal(f.maintenance.read(f.input.maintenanceId).phase,'completed'); assert.equal(f.authority.observe().epoch,6); assert.deepEqual(f.counts(),{starts:1,stops:1}); assert.equal(f.signalCount(),0);
  const row=f.maintenance.readAction(f.input.maintenanceId,f.input.maintenanceId+':stop-old'); assert.equal(row.spec.target.hostPid,200); assert.equal(row.spec.target.birthTicks,'2000'); assert.equal(row.result.normalExit,false); assert.equal(row.result.terminationObserved,true); assert.equal(row.result.signal,null);
  const original=f.sqlite.prepare('SELECT * FROM supervisor_control_maintenance_actions WHERE command_id=?').get(row.commandId); await f.maintenance.advance(f.input.maintenanceId); assert.deepEqual(f.sqlite.prepare('SELECT * FROM supervisor_control_maintenance_actions WHERE command_id=?').get(row.commandId),original);
});
test('an unknown crash, changed incarnation, paused role or restart never permits maintenance to release the original resident',async t=>{
  for(const patch of [{oomKilled:null},{exitCode:null},{finishedAt:null},{paused:true},{restartCount:1},{restartPolicy:'always'},{startedAt:'2026-10-20T00:00:00Z'}])await t.test(JSON.stringify(patch),async sub=>{
    const f=await fixture(sub),actual=f.agents.get(f.input.sourceAgent.containerId);Object.assign(actual,{running:false,hostPid:0,oomKilled:false,exitCode:1,finishedAt:new Date(f.now()).toISOString()},patch);
    await assert.rejects(f.maintenance.submit(f.input),/CONTROL_MAINTENANCE_SOURCE_CHANGED/);assert.deepEqual(f.counts(),{starts:0,stops:0});assert.equal(f.authority.observe().epoch,5);
  });
});
test('pending business intent, live global holder or future control schema prevents the first stop', async t => {
  for (const mode of ['intent', 'holder', 'schema']) await t.test(mode, async sub => {
    const f = await fixture(sub); await f.maintenance.submit(f.input);
    if (mode === 'intent') f.controlSqlite.prepare('INSERT INTO platform_operations VALUES(?,?,?,?,?,?,?,?,?,?)').run('active-plan', f.input.sourceAgent.instanceId ?? 'control-maintenance-fixture', 'admin', 'upgrade-plan', 5, digest('intent'), 'running', '{}', f.now(), f.now());
    if (mode === 'holder') f.authority.grant({ operationId: 'other-business', epoch: 6, executorId: 'agent' });
    if (mode === 'schema') f.controlSqlite.prepare('UPDATE control_store_metadata SET schema_version=2').run();
    assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'blocked'); assert.deepEqual(f.counts(), { starts: 0, stops: 0 });
  });
});
function retirementTable(sqlite) {
  sqlite.exec('CREATE TABLE control_normal_retirements(operation_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,intent TEXT NOT NULL,intent_digest TEXT NOT NULL,state TEXT NOT NULL,retirement_plan TEXT,result TEXT)');
}
function retirementRow(sqlite, instanceId, state, now) {
  const operationId = '11111111-1111-5111-a111-111111111111';
  const intent = { schemaVersion: 1, kind: 'normal-retirement', instanceId, operationId,
    deadline: now + 120000, budget: { maxDurationMs: 120000 } };
  sqlite.prepare('INSERT INTO control_normal_retirements VALUES(?,?,?,?,?,NULL,NULL)')
    .run(operationId, instanceId, canonical(intent), digest(intent), state);
  return operationId;
}
test('unreconciled normal retirement prevents the maintenance CAS even after both command journals are applied and authority is released', async t => {
  for (const state of ['prepared', 'draining', 'expired-unknown', 'future-unknown']) await t.test(state, async sub => {
    const f = await fixture(sub), instanceId = f.authority.observe().instanceId;
    retirementTable(f.controlSqlite);
    const operationId = retirementRow(f.controlSqlite, instanceId, state, f.now());
    const scope = f.authority.grant({ operationId, epoch: 6, executorId: 'retirement-agent', kind: 'maintenance', leaseMs: 120000 });
    const authorization = { operationId, epoch: scope.epoch, executorId: scope.holderId, kind: scope.kind, expiresAt: scope.leaseExpiresAt };
    const key = { operationId, commandId: operationId + ':retire' };
    // Real independent Root and Supervisor journals both contain the original
    // applied receipt. The enclosing Root retirement still lacks confirmation.
    for (const sqlite of [f.controlSqlite, f.sqlite]) {
      const journal = createControlCommandJournal({ sqlite, instanceId, clock: f.now, assertAuthority: input => f.authority.assert(input) });
      journal.prepare({ ...key, authorization, stepId: 'retire', spec: { kind: 'retire-candidate', deadline: f.now() + 120000 } });
      journal.begin({ ...key, authorization });
      journal.record({ ...key, authorization, state: 'applied', result: { instanceId, operationId, commandId: key.commandId, commitKnown: true } });
      assert.equal(journal.lookup(key).state, 'applied');
      assert.deepEqual(journal.pending(), []);
    }
    f.authority.release({ operationId, epoch: scope.epoch, executorId: scope.holderId });
    f.elapse(120001);
    f.input.expectedControlEpoch = scope.epoch;
    f.input.deadline = f.now() + 30000; f.input.rollbackDeadline = f.now() + 60000;
    const beforeAuthority = f.authority.observe();
    const beforeRetirement = f.controlSqlite.prepare('SELECT * FROM control_normal_retirements').get();
    let capacityCalls = 0;
    f.lifecycle.capacity = async () => { capacityCalls++; throw Error('Pending retirement must not reach capacity'); };
    await f.maintenance.submit(f.input);
    f.reopen();
    const result = await f.maintenance.advance(f.input.maintenanceId);
    assert.equal(result.phase, 'blocked');
    assert.equal(result.reason, 'CONTROL_MAINTENANCE_BUSINESS_NOT_QUIESCENT');
    assert.deepEqual(f.authority.observe(), beforeAuthority);
    assert.equal(f.authority.observe().mode, 'active');
    assert.deepEqual(f.controlSqlite.prepare('SELECT * FROM control_normal_retirements').get(), beforeRetirement);
    assert.deepEqual(f.counts(), { starts: 0, stops: 0 }); assert.equal(f.signalCount(), 0); assert.equal(capacityCalls, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM supervisor_control_maintenance_actions').get().count, 0);
  });
});
test('terminal or other-instance normal retirements and legacy ledgers without that table allow the maintenance barrier', async t => {
  for (const mode of ['applied', 'blocked', 'other-instance', 'no-table']) await t.test(mode, async sub => {
    const f = await fixture(sub), instanceId = f.authority.observe().instanceId;
    if (mode !== 'no-table') {
      retirementTable(f.controlSqlite);
      retirementRow(f.controlSqlite, mode === 'other-instance' ? 'another-instance' : instanceId,
        mode === 'other-instance' ? 'expired-unknown' : mode, f.now());
    }
    await f.maintenance.submit(f.input);
    assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'barrier-held');
    assert.equal(f.authority.observe().mode, 'passive'); assert.equal(f.authority.observe().epoch, 6);
    assert.deepEqual(f.counts(), { starts: 0, stops: 0 });
  });
});
test('expiry never removes passive maintenance isolation, and unknown source shutdown is never treated as stopped', async t => {
  const f = await fixture(t); await f.maintenance.submit(f.input); await f.maintenance.advance(f.input.maintenanceId);
  f.lifecycle.stop = async () => { throw Error('Unknown stop before physical receipt'); };
  assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'blocked'); f.elapse(300000); f.reopen();
  assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'blocked'); assert.equal(f.authority.observe().mode, 'passive'); assert.equal(f.authority.observe().epoch, 6); assert.deepEqual(f.counts(), { starts: 0, stops: 0 });
});
test('a persisted completion is replayed after local ACK failure even if normal control has already advanced to a higher epoch', async t => {
  const f = await fixture(t); await f.maintenance.submit(f.input); for (let i = 0; i < 3; i++) await f.maintenance.advance(f.input.maintenanceId);
  f.sqlite.exec("CREATE TRIGGER fixture_drop_completion BEFORE UPDATE OF phase ON supervisor_control_maintenance WHEN NEW.phase='completed' BEGIN SELECT raise(ABORT,'lost local completion ACK'); END");
  assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'blocked'); assert.equal(f.authority.observe().mode, 'active');
  f.authority.grant({ operationId: 'later-normal-operation', epoch: 7, executorId: 'new-agent' }); f.sqlite.exec('DROP TRIGGER fixture_drop_completion'); f.reopen();
  assert.equal((await f.maintenance.advance(f.input.maintenanceId)).phase, 'completed'); assert.equal(f.authority.observe().epoch, 7); assert.equal(f.authority.observe().operationId, 'later-normal-operation');
});
