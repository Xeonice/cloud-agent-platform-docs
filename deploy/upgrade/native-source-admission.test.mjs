import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeExecutor } from './native-executor.mjs';
import { createCoordinatorClient } from './coordinator-client.mjs';
import { createStableEntry } from './stable-entry.mjs';
import { digest } from './trust.mjs';

// Real Entry routing/CAS and live backend identities, with short HTTP contract
// doubles for durable Coordinator receipts and window coverage. No Native or
// real 60s traffic qualification is claimed by these fast boundary tests.
async function boundary(t, options={}) {
  const instanceId='consecutive-api-upgrades',key='e'.repeat(32),requests=[],errors=[],sockets=new Set(),timers=new Set();
  const servers=[];
  async function listen(server){servers.push(server);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));return 'http://127.0.0.1:'+server.address().port;}
  const components=['a','b','c','d'].map(c=>({artifactDigest:'sha256:'+c.repeat(64),inputFingerprint:'sha256:'+c.repeat(64),sourceRevision:c.repeat(40),protocol:{min:1,max:1}}));
  const backends=[];
  for(let i=0;i<4;i++) {
    const identity={instanceId,role:'control',artifactDigest:components[i].artifactDigest,startIdentity:'incarnation-'+i,pid:process.pid};
    const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/internal/control/identity'?identity:{backend:i}));});
    server.on('upgrade',(_req,socket)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');socket.on('data',bytes=>socket.write(bytes));});
    const origin=await listen(server);backends.push({identity,record:{...identity,kind:'api',origin}});
  }
  let source=1,target=2,sourceGeneration=options.sourceActivationGeneration??2,priorSourceGeneration=options.priorSourceActivationGeneration??sourceGeneration-1,priorAttemptGeneration=options.priorAttemptGeneration??sourceGeneration,attemptGeneration=options.attemptGeneration??priorAttemptGeneration+1,priorAttempt='confirmed-bridge',attemptId='accepted-final',fence=6,revoked=false,validations=0,raced=false,observedProcess=false,fenceDelayed=false;
  const sourceRelease=()=>source===1?'bridge-release':'final-release';
  const priorReceipt=()=>({...backends[source].record,attemptId:priorAttempt});
  const web={origin:backends[0].record.origin,root:tmpdir(),digest:components[0].artifactDigest,treeDigest:components[0].artifactDigest},retainedWeb=[{...web,root:tmpdir()}];
  const folder=await realpath(await mkdtemp(join(tmpdir(),'source-admission-')));
  const entry=await createStableEntry({root:folder,instanceId,controlKey:key,stickyKey:'k'.repeat(32),verifyFence:async v=>{assert.equal(v.attemptId,attemptId);assert.equal(v.fence,fence);},initialBinding:{instanceId,attemptId:priorAttempt,fence:4,routeGeneration:7,weight:100,oldApi:{origin:backends[0].record.origin,digest:components[0].artifactDigest},candidateApi:{origin:backends[1].record.origin,digest:components[1].artifactDigest},web,retainedWeb}});
  async function getBinding(){return (await fetch(entry.controlOrigin+'/binding',{headers:{'x-platform-internal-key':key}})).json();}
  function fixed(b){const v={...b};for(const k of ['inFlight','activeWS','wsByDigest','httpByDigest'])delete v[k];return v;}
  async function stamp(){const r=await fetch(entry.controlOrigin+'/fence',{method:'POST',headers:{'content-type':'application/json','x-platform-internal-key':key},body:JSON.stringify({instanceId,attemptId,fence})});assert.equal(r.status,200);}
  await stamp();
  function currentSnapshot(){const v={attempt:{attemptId,instanceId,generation:attemptGeneration,state:'prepared'},fence,plan:{planDigest:'fixed-plan',sourceActivationGeneration:sourceGeneration},sourceActivation:{releaseId:sourceRelease(),activationGeneration:sourceGeneration,components:{api:components[source]}}};options.snapshot?.(v);return v;}
  function historicalSnapshot(){const record=priorReceipt(),v={attempt:{attemptId:priorAttempt,instanceId,generation:priorAttemptGeneration,targetReleaseId:sourceRelease(),state:'activation-confirmed'},fence:fence-2,plan:{sourceActivationGeneration:priorSourceGeneration},sourceActivation:{releaseId:'previous-source',activationGeneration:priorSourceGeneration,components:{api:components[source-1]}},manifest:{releaseId:sourceRelease(),components:{api:components[source]}},appliedSteps:[{stepId:'candidate',receiptDigest:digest(record),evidence:record}]};options.prior?.(v);return v;}
  const receiver=createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null,url=new URL(req.url,'http://localhost');requests.push({path:url.pathname,body,at:Date.now()});let result;
      if(url.pathname.endsWith('/renew')) {if(revoked){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code:'UPGRADE_FENCE_EXPIRED'}));return;}if(options.finalFenceDelayMs&&observedProcess&&!fenceDelayed){fenceDelayed=true;await new Promise(ok=>setTimeout(ok,options.finalFenceDelayMs));}result={current:true};}
      else if(url.pathname==='/internal/upgrades/'+attemptId)result=currentSnapshot();
      else if(url.pathname==='/internal/upgrades/'+priorAttempt)result=historicalSnapshot();
      else if(url.pathname==='/internal/upgrades/process-observe'){
        assert.equal(body.attemptId,priorAttempt);assert.equal(body.kind,'api');const live=await (await fetch(body.origin+'/internal/control/identity')).json();
        result={qualified:live.artifactDigest===body.artifactDigest&&live.startIdentity===body.startIdentity&&live.pid===body.pid,...live,observedAt:new Date().toISOString()};options.observed?.(result);
        if(options.observeDelayMs)await new Promise(ok=>{const timer=setTimeout(()=>{timers.delete(timer);ok();},options.observeDelayMs);timers.add(timer);});
        observedProcess=true;if(options.revokeAfterObserve)revoked=true;
      }
      else if(url.pathname==='/start'||url.pathname==='/observe'){
        const b=await getBinding();assert.equal(b.attemptId,attemptId);assert.equal(b.fence,fence);assert.equal(b.weight,0);assert.equal(b.oldApi.digest,components[source].artifactDigest);
        const record=body.kind==='owner'?{kind:'owner',origin:backends[target].record.origin,artifactDigest:components[target].artifactDigest,startIdentity:'new-owner',pid:process.pid}:{...backends[target].record,attemptId};
        result=url.pathname==='/start'?record:{qualified:true,record,...record};
      }
      else if(url.pathname.endsWith('/validate-switch')){
        validations++;const b=await getBinding();const complete=options.completeImmediately||validations>=3;
        result={qualified:b.attemptId===attemptId&&b.fence===fence&&b.oldApi.digest===components[source].artifactDigest&&complete,controlOnly:true,noRuntimeSideEffects:true,authContinuity:true,originalResourceAddressable:true,baselineSamples:complete?600:0};
      }
      else if(url.pathname.endsWith('/owner-candidate')){
        const b=await getBinding();assert.equal(b.attemptId,attemptId);assert.equal(b.weight,0);assert.equal(b.oldApi.digest,components[source].artifactDigest);
        result=body.action==='adopt'?{commitKnown:true,evidence:{qualified:true,originalResourcesPreserved:true}}:{commitKnown:true};
      }
      else if(url.pathname==='/internal/upgrades/observation') {
        const b=await getBinding();result={coordinatorGeneration:2,observerEpoch:'real-cohort',fenceValid:true,ownerGenerationsValid:true,routeGenerationValid:true,sharedStateHealthy:true,continuity:{qualified:true},invariants:Object.fromEntries(['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].map(k=>[k,0])),probes:{known:true,hz:10,samples:600,failures:0,maxLatencyMs:1,attachMaxMs:1},baseline:{known:true,qualified:true,requests:600,errorRate:0,p95Ms:1,windowMs:60000,source:{instanceId,attemptId,fence,routeGeneration:b.routeGeneration,coordinatorGeneration:2,observerEpoch:'real-cohort',artifactDigest:components[source].artifactDigest,startIdentity:backends[source].identity.startIdentity,origin:b.oldApi.origin,weight:0,routeWeight:0,observedAt:new Date().toISOString()}}};
      }
      else assert.fail('Unexpected source-admission RPC '+url.pathname);
      res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
    }catch(error){errors.push(error);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({code:'CONTRACT_RECEIVER_FAILED'}));}
  });
  const origin=await listen(receiver);
  const fetcher=async(url,request)=>{
    if(url===entry.controlOrigin+'/binding') {
      requests.push({path:'/binding',method:request.method,body:request.body?JSON.parse(request.body):null,at:Date.now()});
      if(options.finalReadDelayMs&&request.method==='GET'&&requests.filter(r=>r.path==='/binding'&&r.method==='GET').length===2)await new Promise(ok=>setTimeout(ok,options.finalReadDelayMs));
      if(options.raceRead&&!raced&&request.method==='GET'&&requests.filter(r=>r.path==='/binding'&&r.method==='GET').length===2){raced=true;const current=fixed(await getBinding());const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-platform-internal-key':key},body:JSON.stringify({...current,attemptId,fence,routeGeneration:current.routeGeneration+1})});assert.equal(r.status,200);}
      if(options.raceCommit&&!raced&&request.method==='POST'&&JSON.parse(request.body).weight===0){raced=true;const current=fixed(await getBinding());const changed={...current,attemptId,fence,routeGeneration:current.routeGeneration+1};const r=await fetch(url,{...request,body:JSON.stringify(changed)});assert.equal(r.status,200);}
    }
    return fetch(url,request);
  };
  const executor=createNativeExecutor({root:folder,instanceId,coordinator:createCoordinatorClient({origin,instanceId,key:'c'.repeat(32)}),entryOrigin:entry.controlOrigin,entryKey:key,supervisorOrigin:origin,supervisorKey:'s'.repeat(32),fetcher});
  const input=()=>({artifact:{root:folder},attempt:{attemptId,targetDigest:components[target].artifactDigest,manifest:{components:{api:components[target]}},plan:{planDigest:'fixed-plan',sourceActivationGeneration:sourceGeneration,policy:{candidateStartupMs:options.budgetMs||2000,observationFreshnessMs:options.freshnessMs||5000,stageDurationMs:60000,minRequests:100,probeHz:10,requestDeadlineMs:2000,attachDeadlineMs:5000}}},fence});
  t.after(async()=>{for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();await entry.close();for(const server of servers){server.closeAllConnections();await new Promise(ok=>server.close(ok));}await rm(folder,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  return {entry,executor,input,getBinding,requests,backends,components,web,retainedWeb,validations:()=>validations,
    async mutateBinding(change){const b=fixed(await getBinding()),next={...b,...change};const r=await fetch(entry.controlOrigin+'/binding',{method:'POST',headers:{'content-type':'application/json','x-platform-internal-key':key},body:JSON.stringify(next)});assert.equal(r.status,200);},
    async nextUpgrade(){source=target;target++;priorSourceGeneration=sourceGeneration;sourceGeneration++;priorAttemptGeneration=attemptGeneration;attemptGeneration++;priorAttempt=attemptId;attemptId='accepted-next-upgrade';fence+=2;validations=0;await stamp();},
  };
}

test('confirmed 100% source admission preserves live HTTP and the original WS before Owner preparation',async t=>{
  for(const [name,options] of [['matching counters',{}],['failed attempt consumed a generation',{priorAttemptGeneration:5,priorSourceActivationGeneration:3,sourceActivationGeneration:4,attemptGeneration:6}]])await t.test(name,async t=>{
  const f=await boundary(t,options),url=new URL(f.entry.origin),socket=connect(Number(url.port),url.hostname);t.after(()=>socket.destroy());
  const read=()=>new Promise((ok,fail)=>{socket.once('data',v=>ok(v.toString()));socket.once('error',fail);});
  const opened=read();socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');assert.match(await opened,/101 Switching Protocols/);
  assert.equal((await (await fetch(f.entry.origin+'/api/who')).json()).backend,1);
  const before=await f.getBinding(),result=await f.executor.ownerCandidate({...f.input(),operationId:'owner-op'}),after=await f.getBinding();
  assert.equal(result.sourceBindingAdmission.servingEquivalent,true);assert.equal(after.weight,0);assert.deepEqual(after.oldApi,before.candidateApi);assert.equal(after.candidateApi,null);assert.equal(after.routeGeneration,before.routeGeneration+1);
  assert.equal(result.sourceBindingAdmission.sourceActivationGeneration,options.sourceActivationGeneration??2);
  assert.deepEqual(after.web,before.web);assert.deepEqual(after.retainedWeb,before.retainedWeb);assert.equal(after.activeWS,1);
  assert.equal((await (await fetch(f.entry.origin+'/api/who')).json()).backend,1);
  const echo=read();socket.write('same-source-connection');assert.equal(await echo,'same-source-connection');
  assert.ok(f.requests.findIndex(r=>r.path==='/binding'&&r.method==='POST')<f.requests.findIndex(r=>r.path==='/start'));
  assert.equal(f.requests.filter(r=>r.path==='/binding'&&r.method==='POST').length,1);
  });
});

test('two consecutive API upgrades admit each actual confirmed source and still wait for the new source gate',async t=>{
  for(const [name,options] of [['matching counters',{}],['independent attempt and activation counters',{priorAttemptGeneration:5,priorSourceActivationGeneration:3,sourceActivationGeneration:4,attemptGeneration:6}]])await t.test(name,async t=>{
  const f=await boundary(t,options);const first=await f.executor.candidate(f.input());assert.equal(f.validations(),3);assert.equal(first.bindingAdmission.sourceProcess.startIdentity,'incarnation-1');
  await f.executor.applyRoute({...f.input(),candidate:first,weight:100});assert.equal((await (await fetch(f.entry.origin+'/api/who')).json()).backend,2);
  await f.nextUpgrade();const second=await f.executor.candidate(f.input());assert.equal(f.validations(),3);assert.equal(second.bindingAdmission.sourceProcess.startIdentity,'incarnation-2');
  const b=await f.getBinding();assert.equal(b.weight,0);assert.equal(b.oldApi.digest,f.components[2].artifactDigest);assert.equal(b.candidateApi,null);assert.deepEqual(b.web,f.web);assert.deepEqual(b.retainedWeb,f.retainedWeb);
  assert.equal((await (await fetch(f.entry.origin+'/api/who')).json()).backend,2);
  });
});

test('independent generation sequences reject mismatched source anchors and non-increasing attempts',async t=>{
  const gap={priorAttemptGeneration:5,priorSourceActivationGeneration:3,sourceActivationGeneration:4,attemptGeneration:6};
  for(const [name,change,code] of [
    ['prior source activation changed',{prior:v=>v.sourceActivation.activationGeneration--},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
    ['prior source and plan agree but do not precede current activation',{prior:v=>{v.sourceActivation.activationGeneration=2;v.plan.sourceActivationGeneration=2;}},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
    ['prior plan does not match its source activation',{prior:v=>v.plan.sourceActivationGeneration++},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
    ['prior source anchor absent',{prior:v=>delete v.sourceActivation},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
    ['current source activation changed',{snapshot:v=>v.sourceActivation.activationGeneration++},'CONFIRMED_SOURCE_SNAPSHOT_REQUIRED'],
    ['current plan source activation changed',{snapshot:v=>v.plan.sourceActivationGeneration++},'CONFIRMED_SOURCE_SNAPSHOT_REQUIRED'],
    ['current activation and snapshot plan disagree with this fixed plan',{snapshot:v=>{v.sourceActivation.activationGeneration++;v.plan.sourceActivationGeneration++;}},'CONFIRMED_SOURCE_SNAPSHOT_REQUIRED'],
    ['same accepted attempt generation',{attemptGeneration:5},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
    ['older accepted attempt generation',{attemptGeneration:4},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
  ])await t.test(name,async t=>{const f=await boundary(t,{...gap,...change});await assert.rejects(f.executor.candidate(f.input()),{code});assert.equal(f.requests.filter(r=>r.path==='/binding'&&r.method==='POST'||r.path==='/start').length,0);assert.equal((await f.getBinding()).weight,100);});
});

test('candidate reconciliation performs the same admission before any candidate role observation',async t=>{
  const f=await boundary(t,{completeImmediately:true});const result=await f.executor.reconcile({step:{kind:'candidate'},...f.input(),local:{}});
  assert.equal(result.applied,true);assert.equal(result.evidence.bindingAdmission.servingEquivalent,true);
  assert.equal(f.requests.filter(r=>r.path==='/start').length,0);
  assert.ok(f.requests.findIndex(r=>r.path==='/binding'&&r.method==='POST')<f.requests.findIndex(r=>r.path==='/observe'));
});

test('a verified sourceActual proof retains the same confirmed API incarnation',async t=>{
  const f=await boundary(t,{completeImmediately:true,snapshot:v=>{const facts={schemaVersion:1,qualified:true,partial:true,instanceId:v.attempt.instanceId,baseConfirmedReleaseId:v.sourceActivation.releaseId,activationGeneration:v.sourceActivation.activationGeneration,schema:29,components:v.sourceActivation.components,observedAt:new Date().toISOString()};v.sourceActual={...facts,proofDigest:digest(facts)};}});
  const result=await f.executor.candidate(f.input());assert.equal(result.bindingAdmission.servingEquivalent,true);assert.equal(result.bindingAdmission.sourceProcess.startIdentity,'incarnation-1');
});

test('unconfirmed history, wrong tuples, source incarnation changes and authority loss never admit or start a role',async t=>{
  for(const [name,options,code] of [
    ['unconfirmed previous attempt',{prior:v=>v.attempt.state='failed'},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
    ['other confirmed generation',{prior:v=>v.attempt.generation--},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
    ['different previous fence',{prior:v=>v.fence--},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
    ['different source API',{snapshot:v=>v.sourceActivation.components.api={...v.sourceActivation.components.api,artifactDigest:'sha256:'+'f'.repeat(64)}},'CONFIRMED_SOURCE_COMPONENT_MISMATCH'],
    ['different full input fingerprint',{prior:v=>v.manifest.components.api={...v.manifest.components.api,inputFingerprint:'sha256:'+'f'.repeat(64)}},'CONFIRMED_SOURCE_HISTORY_MISMATCH'],
    ['tampered prior candidate receipt',{prior:v=>v.appliedSteps[0].evidence.pid++},'CONFIRMED_SOURCE_CANDIDATE_RECEIPT_REQUIRED'],
    ['unqualified source actual',{snapshot:v=>v.sourceActual={qualified:false}},'SOURCE_ACTUAL_UNQUALIFIED'],
    ['changed live incarnation',{observed:v=>v.startIdentity='replacement'},'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED'],
    ['changed live pid',{observed:v=>v.pid++},'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED'],
    ['unknown physical process',{observed:v=>v.qualified=false},'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED'],
    ['stale source process proof',{observed:v=>v.observedAt=new Date(Date.now()-5001).toISOString()},'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED'],
    ['revoked fence after real source observation',{revokeAfterObserve:true},'UPGRADE_FENCE_EXPIRED'],
  ])await t.test(name,async t=>{const f=await boundary(t,options);await assert.rejects(f.executor.candidate(f.input()),{code});assert.equal(f.requests.filter(r=>r.path==='/binding'&&r.method==='POST').length,0);assert.equal(f.requests.filter(r=>r.path==='/start').length,0);assert.equal((await f.getBinding()).weight,100);});
});

test('active gray routes and same-attempt 100% are refused, and real Entry CAS rejects a competing commit',async t=>{
  for(const [name,change] of [['active gray',{weight:25}],['same attempt',{attemptId:'accepted-final',fence:6}]])await t.test(name,async t=>{const f=await boundary(t);await f.mutateBinding({attemptId:'accepted-final',fence:6,routeGeneration:8,...change});await assert.rejects(f.executor.candidate(f.input()),{code:'CONFIRMED_SOURCE_ROUTE_REQUIRED'});assert.equal(f.requests.filter(r=>r.path==='/start').length,0);});
  await t.test('CAS lost after final immutable read',async t=>{const f=await boundary(t,{raceCommit:true});await assert.rejects(f.executor.candidate(f.input()),{code:'ENTRY_RPC_FAILED'});assert.equal(f.requests.filter(r=>r.path==='/start').length,0);const b=await f.getBinding();assert.equal(b.weight,100);assert.equal(b.routeGeneration,8);});
  await t.test('binding changed before final immutable read',async t=>{const f=await boundary(t,{raceRead:true});await assert.rejects(f.executor.candidate(f.input()),{code:'CONFIRMED_SOURCE_BINDING_CHANGED'});assert.equal(f.requests.filter(r=>r.path==='/start'||r.path==='/binding'&&r.method==='POST').length,0);});
});

test('source proof consumes the original startup budget and late reads never admit or start',async t=>{
  const f=await boundary(t,{budgetMs:80,observeDelayMs:250}),started=Date.now();await assert.rejects(f.executor.candidate(f.input()),{code:'CANDIDATE_STARTUP_BUDGET_EXCEEDED'});assert.ok(Date.now()-started<200);
  const requests=f.requests.length;await new Promise(ok=>setTimeout(ok,300));assert.equal(f.requests.length,requests);assert.equal(f.requests.filter(r=>r.path==='/start'||r.path==='/binding'&&r.method==='POST').length,0);
});

test('source process proof must remain fresh after the final binding and fence reads',async t=>{
  for(const [name,options] of [['slow binding read',{finalReadDelayMs:200}],['slow fence read',{finalFenceDelayMs:200}]])await t.test(name,async t=>{const f=await boundary(t,{...options,freshnessMs:100});await assert.rejects(f.executor.candidate(f.input()),{code:'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED'});assert.equal(f.requests.filter(r=>r.path==='/start'||r.path==='/binding'&&r.method==='POST').length,0);assert.equal((await f.getBinding()).weight,100);});
});
