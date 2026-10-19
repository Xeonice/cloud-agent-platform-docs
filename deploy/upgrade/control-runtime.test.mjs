import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleControlRuntime } from './control-runtime.mjs';
import { signEntryContext } from './control-entry-context.mjs';
import { createControlContractAuthority } from './control-contract-authority.mjs';

const Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3');
const sha = char => 'sha256:' + char.repeat(64);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'control-runtime-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const before = process.env.PLATFORM_PROCESS_ROLE; process.env.PLATFORM_PROCESS_ROLE = 'upgrade-control';
  t.after(() => { if (before === undefined) delete process.env.PLATFORM_PROCESS_ROLE; else process.env.PLATFORM_PROCESS_ROLE = before; });
  const opened = []; function TrackedDatabase(path) { const db = new Database(path); opened.push(db); return db; }
  const args = { config: { instanceId: 'runtime-test', controlRoot: join(root, 'private'), controlLedgerRoot: join(root, 'ledger'),
    controllerKey: 'c'.repeat(32), businessKey: 'b'.repeat(32), accessAuthorityKey: 'a'.repeat(32), privateEntryKey: 'p'.repeat(32),
    coordinatorOrigin: 'http://127.0.0.1:1', allowedOrigins: ['http://test.invalid'], controlPort: 0 },
    verifiedPackage: { artifactRoot: root, apiRoot: fileURLToPath(new URL('../../api/', import.meta.url)), version: '1.0.0', protocolVersion: 1,
      packageDigest: sha('b'), executionEngineDigest: sha('c') },
    engineIdentity: { instanceId: 'runtime-test', artifactDigest: sha('c'), startIdentity: 'control-test', role: 'installer', pid: process.pid },
    Database: TrackedDatabase, participantsFactory: () => ({ admit: async () => {} }),
    executionFactory: async () => ({ runOnce: async () => {}, sample: async () => [], close: async () => {} }) };
  return { root, opened, args };
}

test('the actual pure API factory opens only separate control and access databases and remains passive', async t => {
  const f = await fixture(t); let starts = 0, closes = 0;
  f.args.executionFactory = async () => ({ runOnce: async () => { starts++; }, sample: async () => [], close: async () => { closes++; } });
  const runtime = await assembleControlRuntime(f.args); t.after(() => runtime.close());
  assert.equal(f.opened.length, 2); assert.equal(runtime.authority.observe().mode, 'passive');
  assert.equal(f.opened[0].prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('projects','sandboxes','credentials')").get().n, 0);
  assert.deepEqual(f.opened[1].prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(), [{ name: 'control_access' }, { name: 'control_access_environment' }]);
  assert.equal(f.opened[0].prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='control_access'").get().n, 0);
  await runtime.tick(); assert.equal(starts, 0);
  const response = await fetch(runtime.origin + '/metadata', { headers: { 'x-platform-internal-key': f.args.config.controllerKey, 'x-platform-instance-id': 'runtime-test' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).controlSystem.version, '1.0.0');
  await runtime.close(); await runtime.close(); assert.equal(closes, 1); assert.ok(f.opened.every(db => !db.open));
});

test('assembly failure after binding a real HTTP listener closes listeners and both database handles', async t => {
  const f = await fixture(t); let origin;
  f.args.executionFactory = async args => { origin = args.controlOrigin; throw Object.assign(Error('assembly fixture failed'), { code: 'TEST_ASSEMBLY_FAILURE' }); };
  await assert.rejects(assembleControlRuntime(f.args), { code: 'TEST_ASSEMBLY_FAILURE' });
  assert.ok(f.opened.every(db => !db.open));
  await assert.rejects(fetch(origin + '/metadata', { signal: AbortSignal.timeout(1000) }));
});

test('persisted drain/stop barriers survive an Agent restart and deny every foreign grant before any contract admission',async t=>{
  const f=await fixture(t);f.args.config.accessAllowLoopback=true;
  f.args.contractBusinessFactory=()=>({});
  let runtime=await assembleControlRuntime(f.args);const instanceId=f.args.config.instanceId;
  runtime.authority.activate({expectedRevision:1,sourceBindingDigest:sha('d')});
  // Real file-backed ledger and production runtime/contract authority. No
  // physical roles or Native qualification are represented by these rows.
  f.opened[0].exec('CREATE TABLE control_normal_retirements(operation_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,state TEXT NOT NULL)');
  const operationId='11111111-1111-4111-8111-111111111111';
  f.opened[0].prepare('INSERT INTO control_normal_retirements VALUES(?,?,?)').run(operationId,instanceId,'expired-unknown');
  await runtime.close();runtime=await assembleControlRuntime(f.args);t.after(()=>runtime.close());
  await runtime.access.importState({source:'none',sessionSecret:'protocol-test-original-session',upgradeSessionSecretBase64:Buffer.alloc(32,13).toString('base64')});
  const ledger=f.opened[2],before=runtime.authority.observe();
  for(const state of ['drain-dispatched','draining','retire-prepared','retire-dispatched','expired-unknown','future-unknown']) {
    ledger.prepare('UPDATE control_normal_retirements SET state=?').run(state);
    for(const kind of ['upgrade','contract','recovery','maintenance'])
      assert.throws(()=>runtime.authority.grant({operationId:'foreign-operation',epoch:before.epoch+1,executorId:'foreign',kind}),/CONTROL_RETIREMENT_RECONCILIATION_REQUIRED/);
    assert.deepEqual(runtime.authority.observe(),before);
  }
  ledger.prepare("UPDATE control_normal_retirements SET state='expired-unknown'").run();
  let admits=0;
  const contract=createControlContractAuthority({sqlite:ledger,instanceId,authority:runtime.authority,contracts:{},participants:{admit:async()=>{admits++;}}});t.after(()=>contract.close());
  await assert.rejects(contract.ensure({attempt:{instanceId,contractAttemptId:'foreign-contract',state:'accepted'},fence:1}),/CONTROL_RETIREMENT_RECONCILIATION_REQUIRED/);
  assert.equal(admits,0);assert.equal(ledger.prepare('SELECT count(*) n FROM control_contract_authority').get().n,0);
  for(const [path,body] of [
    ['/api/system/upgrade/contracts/requests',{requestId:'22222222-2222-4222-8222-222222222222',targetPlanDigest:sha('e'),expectedActivationGeneration:0,acknowledgeRollbackClosure:true}],
    ['/api/system/upgrade/requests',{requestId:'33333333-3333-4333-8333-333333333333',targetReleaseId:'v1.1.0',targetDigest:sha('e'),expectedActivationGeneration:0}],
  ]) {
    const response=await fetch(runtime.origin+path,{method:'POST',headers:{host:'test.invalid',origin:'http://test.invalid','content-type':'application/json',
      ...signEntryContext({instanceId,key:f.args.config.privateEntryKey,remoteAddress:'127.0.0.1',method:'POST',path})},body:JSON.stringify(body)});
    assert.notEqual(response.status,202);assert.equal((await response.json()).code,'CONTROL_RETIREMENT_RECONCILIATION_REQUIRED');
  }
  assert.equal(ledger.prepare('SELECT count(*) n FROM platform_operations').get().n,0);
  assert.throws(()=>runtime.authority.grant({operationId,epoch:1,executorId:'lookup',kind:'maintenance',leaseMs:30000}),/CONTROL_RETIREMENT_RECONCILIATION_REQUIRED/);
  const scope=runtime.authority.grant({operationId,epoch:1,executorId:'lookup',kind:'maintenance',leaseMs:5000});
  runtime.authority.release({operationId,epoch:scope.epoch,executorId:'lookup'});
  for(const state of ['prepared','blocked','applied']) {
    ledger.prepare('UPDATE control_normal_retirements SET state=?').run(state);
    const allowed=runtime.authority.grant({operationId:'ordinary-'+state,epoch:runtime.authority.observe().epoch+1,executorId:'normal'});
    runtime.authority.release({operationId:allowed.operationId,epoch:allowed.epoch,executorId:'normal'});
  }
});

test('a prepared retirement yields after an old maintenance release, while persisted effects still stop the business tick',async t=>{
  const f=await fixture(t);let runs=0,contracts=0;
  f.args.contractBusinessFactory=()=>({});
  const operationId='11111111-1111-4111-8111-111111111111';
  f.args.executionFactory=async()=>({runOnce:async()=>{runs++;},sample:async()=>[],close:async()=>{},tickContracts:async()=>{contracts++;},
    normalRetirements:{active:()=>({operationId,state:'prepared'}),advance:async()=>({operationId,state:'prepared',reason:'NORMAL_RETIREMENT_BUSY'})}});
  const runtime=await assembleControlRuntime(f.args);t.after(()=>runtime.close());
  runtime.authority.activate({expectedRevision:1,sourceBindingDigest:sha('d')});
  runtime.authority.grant({operationId:'old-retirement',epoch:1,executorId:'old',kind:'maintenance'});
  runtime.authority.release({operationId:'old-retirement',epoch:1,executorId:'old'});
  assert.equal(runtime.authority.observe().kind,'maintenance');assert.equal(runtime.authority.observe().holderId,null);
  await runtime.tick();assert.equal(runs,1);assert.equal(contracts,1);
  f.opened[0].exec('CREATE TABLE control_normal_retirements(operation_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,state TEXT NOT NULL)');
  f.opened[0].prepare('INSERT INTO control_normal_retirements VALUES(?,?,?)').run(operationId,f.args.config.instanceId,'drain-dispatched');
  await runtime.tick();assert.equal(runs,1);assert.equal(contracts,1);
  f.opened[0].prepare("UPDATE control_normal_retirements SET state='prepared'").run();
  runtime.authority.grant({operationId,epoch:2,executorId:'current',kind:'maintenance',leaseMs:30000});
  await runtime.tick();assert.equal(runs,1);assert.equal(contracts,1);
});
