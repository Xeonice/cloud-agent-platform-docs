import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createAcceptedUpgrade } from '../test-support/accepted-upgrade.mjs';
import { createNormalRetirement } from './normal-retirement.mjs';
import { createControlAuthority } from './control-authority.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { createControlRecoveryStore } from './control-recovery-store.mjs';
import { createCandidateRetirementExecutor } from './candidate-retirement.mjs';
import { createPrivateControlRpc } from './control-rpc.mjs';
import { digest } from './trust.mjs';
const Database=createRequire(new URL('../../api/package.json',import.meta.url))('better-sqlite3');
const businessKey='b'.repeat(32),supervisorKey='s'.repeat(32);
async function listen(t,key,handler) {
  const server=http.createServer((req,res)=>{void(async()=>{
    assert.equal(req.headers['x-platform-internal-key'],key);
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined;
    await handler(req,res,body);
  })().catch(e=>{if(!res.destroyed){res.writeHead(409);res.end(JSON.stringify({code:e.code||e.message}));}});});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(()=>new Promise(ok=>{server.closeAllConnections();server.close(ok);}));
  return `http://127.0.0.1:${server.address().port}`;
}
const reply=(res,value)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};

// Real UpgradeStore accepted intent/receipts, two file-backed SQLite journals,
// actual global authority, HTTP, and the production retirement executor. Only
// process observations and signalling are fixtures; this is not Native proof.
async function fixture(t,{holdWork=false,loseDrainAck=false,loseRetireAck=false}={}) {
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'normal-retirement-')));
  let now=Date.now();const clock=()=>now,db=new Database(join(root,'control.db')),supDb=new Database(join(root,'supervisor.db'));
  t.after(async()=>{db.close();supDb.close();await fs.rm(root,{recursive:true,force:true});});
  const f=createAcceptedUpgrade(db,{clock});now+=1000;
  const instanceId=f.stores.store.instanceId,authority=createControlAuthority({sqlite:db,instanceId,clock});
  authority.activate({expectedRevision:1,sourceBindingDigest:digest('initial-source')});
  const journal=createControlCommandJournal({sqlite:db,instanceId,clock,assertAuthority:a=>authority.assert(a)});
  const supJournal=createControlCommandJournal({sqlite:supDb,instanceId,clock,assertAuthority:a=>authority.assert(a)});
  const recoveryStore=createControlRecoveryStore({sqlite:db,instanceId,clock});
  const target={instanceId,role:'coordinator',containerId:'a'.repeat(64),startIdentity:'candidate-coordinator-real-fixture-start',hostPid:321,startedAt:new Date(now-999).toISOString(),
    artifactDigest:f.manifest.components.coordinator.artifactDigest,attemptId:f.attemptId};
  let runner,drainBody=null,admissionClosed=false,activeWork=holdWork?1:0,drainPosts=0,retirePosts=0,signals=0,lookups=0,retired=false,release;
  const work=holdWork?new Promise(ok=>{release=ok;}).finally(()=>{activeWork=0;}):Promise.resolve();
  const refs=(command=null)=>({known:true,instanceId,target,revision:1,observedAt:new Date(clock()).toISOString(),running:!retired,paused:false,restartPolicy:'no',attemptTerminal:true,authorityReleased:true,controllerLeaseExpiresAt:now-1,legacyInstaller:false,
    references:{entry:0,http:0,ws:0,writer:0,handoff:0,activeCommands:journal.pending().length+supJournal.pending().filter(v=>!command||v.operationId!==command.operationId||v.commandId!==command.commandId).length,
      fallback:0,owners:0,guests:0,recovery:0,workers:activeWork+(admissionClosed?0:1),userOperations:0}});
  const businessOrigin=await listen(t,businessKey,async(req,res,body)=>{
    if(req.method==='GET')return reply(res,{schemaVersion:1,complete:true,role:'coordinator',instanceId,startIdentity:target.startIdentity,artifactDigest:target.artifactDigest,observedAt:new Date(clock()).toISOString(),
      drain:drainBody?{operationId:drainBody.operationId,intentDigest:drainBody.intentDigest,admissionClosed,settled:activeWork===0}:null});
    const row=runner.read(body.operationId);assert.equal(row.intentDigest,body.intentDigest);
    authority.assert({operationId:body.operationId,epoch:body.epoch,executorId:body.executorId,kind:'maintenance'});
    drainPosts++;drainBody=body;admissionClosed=true;
    if(loseDrainAck){loseDrainAck=false;res.destroy();return;}
    reply(res,{admitted:true});
  });
  const result=request=>({instanceId,operationId:request.operationId,commandId:request.commandId,specDigest:request.specDigest,target,state:'applied',normalExit:true,signal:'SIGTERM',forced:false,removed:false,volumesRemoved:false,exit:{running:false,hostPid:0,oomKilled:false,exitCode:143}});
  const candidate=createCandidateRetirementExecutor({instanceId,journal:supJournal,clock,readTimeoutMs:1000,getState:({command})=>refs(command),adapter:{
    terminate:async request=>{signals++;retired=true;return result(request);},lookupCommand:async request=>{lookups++;return retired?result(request):{...result(request),state:'unknown'};}}});
  const supervisorOrigin=await listen(t,supervisorKey,async(req,res,body)=>{
    if(req.url==='/retire-candidate'){
      retirePosts++;const row=await candidate.execute({...body.command,plan:body.plan});
      if(loseRetireAck){loseRetireAck=false;res.destroy();return;}return reply(res,row);
    }
    assert.equal(req.url,'/command-result');lookups++;
    const row=supJournal.lookup(body);
    reply(res,await candidate.reconcile({operationId:row.operationId,commandId:row.commandId,stepId:row.stepId,authorization:{operationId:authority.observe().operationId,epoch:authority.observe().epoch,executorId:authority.observe().holderId,expiresAt:authority.observe().leaseExpiresAt,kind:'maintenance'},plan:{qualified:true,spec:row.spec,specDigest:row.specDigest}}));
  });
  const business=createPrivateControlRpc({origin:businessOrigin,instanceId,key:businessKey,timeoutMs:1000});
  const options={sqlite:db,instanceId,executorId:'independent-controller-incarnation',store:f.stores.store,authority,journal,recoveryStore,clock,
    participants:{admit:async scope=>authority.assert({operationId:scope.operationId,epoch:scope.epoch,executorId:scope.holderId,kind:'maintenance'})},
    references:async()=>refs(),participant:async()=>({startIdentity:target.startIdentity,artifactDigest:target.artifactDigest,applicationOrigin:businessOrigin,physical:{...target,startedAt:target.startedAt}}),
    census:()=>business('/internal/application/retirement'),drain:(_record,body)=>business('/internal/application/retirement-drain',body),
    supervisor:createPrivateControlRpc({origin:supervisorOrigin,instanceId,key:supervisorKey,timeoutMs:1000})};
  const make=()=>runner=createNormalRetirement(options);make();t.after(()=>runner.close());
  return {...f,db,supDb,authority,journal,supJournal,runner,target,make,clock,advanceClock:ms=>{now+=ms;},release:async()=>{release?.();await work;},counts:()=>({drainPosts,retirePosts,signals,lookups})};
}

test('accepted real terminal upgrade drains old work to actual settlement before one Supervisor retirement',async t=>{
  const f=await fixture(t,{holdWork:true}),original=f.runner.submit({acceptedUpgradeId:f.attemptId,target:f.target});
  assert.equal((await f.runner.advance(original.operationId)).state,'drain-dispatched');
  assert.equal((await f.runner.advance(original.operationId)).state,'draining');
  assert.equal(f.counts().signals,0);
  await f.release();
  assert.equal((await f.runner.advance(original.operationId)).state,'retire-prepared');
  const done=await f.runner.advance(original.operationId);
  assert.equal(done.state,'applied');assert.equal(f.counts().signals,1);assert.equal(f.authority.observe().holderId,null);
  assert.equal(f.stores.store.snapshot(f.attemptId).attempt.state,'failed');
  assert.deepEqual(f.stores.store.confirmed(),f.source);
});

test('lost drain ACK and a restarted driver query the same intent and never repost drain',async t=>{
  const f=await fixture(t,{loseDrainAck:true}),row=f.runner.submit({acceptedUpgradeId:f.attemptId,target:f.target});
  await f.runner.advance(row.operationId);await f.runner.close();const next=f.make();
  assert.equal((await next.advance(row.operationId)).state,'retire-prepared');
  assert.equal((await next.advance(row.operationId)).state,'applied');
  assert.equal(f.counts().drainPosts,1);assert.equal(f.counts().signals,1);
  assert.equal(next.read(row.operationId).intent.deadline,row.intent.deadline);
});

test('lost retirement ACK uses the actual Supervisor original journal without another physical POST',async t=>{
  const f=await fixture(t,{loseRetireAck:true}),row=f.runner.submit({acceptedUpgradeId:f.attemptId,target:f.target});
  await f.runner.advance(row.operationId);await f.runner.advance(row.operationId);
  assert.equal((await f.runner.advance(row.operationId)).state,'retire-dispatched');
  assert.equal((await f.runner.advance(row.operationId)).state,'applied');
  assert.equal(f.counts().retirePosts,1);assert.equal(f.counts().signals,1);assert.ok(f.counts().lookups>0);
});

test('expired unknown drain stops automatic leases and only explicit lookup can remove the fuse',async t=>{
  const f=await fixture(t,{loseDrainAck:true}),row=f.runner.submit({acceptedUpgradeId:f.attemptId,target:f.target});
  await f.runner.advance(row.operationId);f.advanceClock(120001);
  assert.equal((await f.runner.advance(row.operationId)).state,'expired-unknown');
  assert.equal(f.runner.active(),null);assert.equal(f.runner.blocking().operationId,row.operationId);
  assert.ok(f.authority.observe().leaseExpiresAt<=f.clock());
  const epoch=f.authority.observe().epoch;await f.runner.advance(row.operationId);assert.equal(f.authority.observe().epoch,epoch);
  assert.throws(()=>f.runner.submit({acceptedUpgradeId:f.attemptId,target:f.target,requestId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}),/NORMAL_RETIREMENT_ALREADY_PENDING/);
  assert.equal((await f.runner.reconcile(row.operationId)).state,'blocked');
  assert.equal(f.runner.blocking(),null);assert.equal(f.counts().retirePosts,0);assert.equal(f.counts().drainPosts,1);
  const retry=f.runner.submit({acceptedUpgradeId:f.attemptId,target:f.target,requestId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});
  assert.equal((await f.runner.advance(retry.operationId)).state,'retire-prepared');
  assert.equal((await f.runner.advance(retry.operationId)).state,'applied');assert.equal(f.counts().drainPosts,1);
});

test('expired physical ACK is resolved by original lookup without extending the old physical deadline',async t=>{
  const f=await fixture(t,{loseRetireAck:true}),row=f.runner.submit({acceptedUpgradeId:f.attemptId,target:f.target});
  await f.runner.advance(row.operationId);await f.runner.advance(row.operationId);await f.runner.advance(row.operationId);
  const before=f.supJournal.lookup({operationId:row.operationId,commandId:row.operationId+':retire'});
  f.advanceClock(120001);assert.equal((await f.runner.advance(row.operationId)).state,'expired-unknown');
  assert.equal((await f.runner.reconcile(row.operationId)).state,'applied');
  const after=f.supJournal.lookup({operationId:row.operationId,commandId:row.operationId+':retire'});
  assert.deepEqual(after.spec,before.spec);assert.equal(f.counts().retirePosts,1);assert.equal(f.counts().signals,1);
});

test('Owner, invented bootstrap attempts and component substitutions have zero maintenance effects',async t=>{
  const f=await fixture(t);
  for(const target of [{...f.target,role:'owner'},{...f.target,attemptId:'cold-install'},{...f.target,artifactDigest:digest('substitution')}])
    assert.throws(()=>f.runner.submit({acceptedUpgradeId:f.attemptId,target}));
  assert.deepEqual(f.counts(),{drainPosts:0,retirePosts:0,signals:0,lookups:0});
  assert.equal(f.db.prepare('SELECT count(*) n FROM control_normal_retirements').get().n,0);
});

test('a live contract owns the global fence and maintenance cannot supersede it',async t=>{
  const f=await fixture(t),row=f.runner.submit({acceptedUpgradeId:f.attemptId,target:f.target});
  f.authority.grant({operationId:'contract',epoch:1,executorId:'contract-owner',leaseMs:30000,kind:'contract'});
  assert.equal((await f.runner.advance(row.operationId)).reason,'NORMAL_RETIREMENT_BUSY');
  assert.equal(f.counts().drainPosts,0);assert.equal(f.authority.observe().operationId,'contract');
});
