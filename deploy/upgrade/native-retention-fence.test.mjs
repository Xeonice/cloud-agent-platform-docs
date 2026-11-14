import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInstanceController} from './instance-controller.mjs';
import {createNativeExecutor} from './native-executor.mjs';
import {createCoordinatorClient} from './coordinator-client.mjs';
import {createStableEntry} from './stable-entry.mjs';
import {atomicJson,readJson} from './io.mjs';
import {digest} from './trust.mjs';

const id='88888888-8888-4888-8888-888888888881',instanceId='retention-refence-instance',key='e'.repeat(32);
function fixed(value){const result={...value};for(const name of ['inFlight','activeWS','wsByDigest','httpByDigest'])delete result[name];return result;}
function observation(empty,patch={}){
  const lane={known:!empty,qualified:!empty,requests:empty?0:600,errorRate:empty?null:0,p95Ms:empty?null:1,windowMs:empty?0:60000};
  return {observedAt:new Date().toISOString(),fenceValid:true,ownerGenerationsValid:true,routeGenerationValid:true,sharedStateHealthy:true,continuity:{qualified:true},invariants:Object.fromEntries(['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].map(k=>[k,0])),probes:{known:!empty,hz:empty?0:10,samples:empty?0:600,failures:0,maxLatencyMs:empty?null:1,attachMaxMs:empty?null:1,windowMs:empty?0:60000},candidate:lane,baseline:lane,windowMs:empty?0:60000,...patch};
}
// Real StableEntry, live HTTP/WS backends and CoordinatorClient transport. The
// durable lease and observation receiver are controlled contracts, not a real
// Native/60-second qualification or production continuity claim.
async function fixture(t,{weight=100,empty=true,patch={},anchorChange,snapshotFence,raceCommit=false,replaceProcess=false,webFailure=false}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'retention-refence-'))),servers=[],sockets=new Set(),streams=new Set(),requests=[],events=[];
  const api={artifactDigest:digest('actual-serving-api'),inputFingerprint:digest('api-input'),sourceRevision:'a'.repeat(40),protocol:{min:1,max:1}},web={artifactDigest:digest('actual-web'),webRevision:'b'.repeat(40)};
  const identity={instanceId,artifactDigest:api.artifactDigest,startIdentity:'retained-original-api',pid:process.pid};
  async function listen(server){servers.push(server);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));return 'http://127.0.0.1:'+server.address().port;}
  const backend=createServer((req,res)=>{
    if(webFailure&&req.url==='/web-process'){res.writeHead(503);res.end();return;}
    if(req.url==='/api/stream'){res.writeHead(200);res.write('original-http-before\n');streams.add(res);res.once('close',()=>streams.delete(res));return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/internal/control/identity'?{...identity,...(replaceProcess?{startIdentity:'replacement'}:{})}:req.url==='/web-process'?{...identity,artifactDigest:web.artifactDigest,webRevision:web.webRevision}:req.url==='/web-build'?{webRevision:web.webRevision}:{backend:'original'}));
  });
  backend.on('upgrade',(_req,socket)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');socket.on('data',bytes=>socket.write(bytes));});
  const origin=await listen(backend),initial={instanceId,attemptId:id,fence:4,routeGeneration:7,weight,oldApi:{origin,digest:weight===0?api.artifactDigest:digest('retained-old-api')},candidateApi:weight===100?{origin,digest:api.artifactDigest}:null,web:{origin,root,digest:web.artifactDigest,treeDigest:digest('web-tree')},retainedWeb:[]};
  const plan={apiReused:weight===0,policy:{retentionMs:600000,evaluationIntervalMs:1,observationFreshnessMs:5000,stageDurationMs:60000,minRequests:100,probeHz:10,requestDeadlineMs:2000,attachDeadlineMs:5000,softErrorDelta:0.01,p95Ratio:2,p95FloorMs:1000,consecutiveEvaluations:2},steps:[]};plan.planDigest=digest(plan);
  const manifest={components:{api,web}},attempt={attemptId:id,instanceId,state:'activation-confirmed',generation:2,sequence:9,targetDigest:digest(manifest),observedAt:new Date().toISOString()},candidate={...identity,kind:'api',attemptId:id,origin},activation={instanceId,manifestDigest:attempt.targetDigest,actual:structuredClone(initial),compatibility:{qualified:true,identity},continuity:{qualified:true}};
  const activationStep={stepId:'activation-confirm',evidence:activation,receiptDigest:digest(activation)};anchorChange?.(activationStep);
  let fence=4,leaseExpiresAt=Date.now()-1,controllerId='expired-controller',reclaims=0,raced=false;
  const entry=await createStableEntry({root:join(root,'entry'),instanceId,controlKey:key,stickyKey:'k'.repeat(32),verifyFence:async v=>{assert.equal(v.attemptId,id);assert.equal(v.fence,fence);assert.ok(leaseExpiresAt>Date.now());},initialBinding:initial});
  const getBinding=async()=> (await fetch(entry.controlOrigin+'/binding',{headers:{'x-platform-internal-key':key}})).json();
  const snapshot=()=>({attempt:{...attempt},fence:snapshotFence??fence,plan,manifest,sourceActivation:{activationGeneration:1},appliedSteps:[...(weight===100?[{stepId:'candidate',receiptDigest:digest(candidate),evidence:candidate}]:[]),activationStep]});
  const receiver=createServer(async(req,res)=>{
    try{
      let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):null,url=new URL(req.url,'http://localhost');requests.push({path:url.pathname,body});let result;
      if(url.pathname.endsWith('/claim')){
        if(leaseExpiresAt<=Date.now()||controllerId!==body.controllerId){fence++;reclaims++;}controllerId=body.controllerId;leaseExpiresAt=Date.now()+body.leaseMs;
        const response=await fetch(entry.controlOrigin+'/fence',{method:'POST',headers:{'content-type':'application/json','x-platform-internal-key':key},body:JSON.stringify({instanceId,attemptId:id,fence})});assert.equal(response.status,200);
        result={fence,generation:attempt.generation,snapshot:snapshot()};
      }else if(url.pathname.endsWith('/renew')){
        if(body.fence!==fence||leaseExpiresAt<=Date.now()){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code:'UPGRADE_FENCE_EXPIRED'}));return;}result={current:true};
      }else if(url.pathname==='/internal/upgrades/'+id)result=snapshot();
      else if(url.pathname==='/internal/upgrades/process-observe'){
        const live=await(await fetch(body.origin+'/internal/control/identity')).json();result={qualified:live.startIdentity===body.startIdentity&&live.artifactDigest===body.artifactDigest&&live.pid===body.pid,...live,observedAt:new Date().toISOString()};
      }else if(url.pathname==='/internal/upgrades/observation'){
        const binding=await getBinding();result=observation(empty,{routeGenerationValid:binding.attemptId===id&&binding.fence===Number(url.searchParams.get('fence')),...patch});
      }else if(url.pathname==='/internal/upgrades/continuity')result={qualified:true};
      else if(url.pathname.endsWith('/commit')){events.push(body);attempt.sequence++;result=snapshot();}
      else if(url.pathname.endsWith('/fallback-eligibility'))result={qualified:false};
      else throw Error('Unexpected retention RPC '+url.pathname);
      res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({code:error.code||'RETENTION_RECEIVER_FAILED'}));}
  });
  const coordinatorOrigin=await listen(receiver),coordinator=createCoordinatorClient({origin:coordinatorOrigin,instanceId,key:'c'.repeat(32)});
  const fetcher=async(url,request)=>{
    if(url===entry.controlOrigin+'/binding'&&request.method==='POST'){
      requests.push({path:'/binding',body:JSON.parse(request.body)});
      if(raceCommit&&!raced){raced=true;const next=JSON.parse(request.body),response=await fetch(url,{...request,body:JSON.stringify({...next,web:{...next.web,root:root+'/competing'}})});assert.equal(response.status,200);}
    }
    return fetch(url,request);
  };
  const executor=createNativeExecutor({root,instanceId,coordinator,entryOrigin:entry.controlOrigin,entryKey:key,supervisorOrigin:coordinatorOrigin,supervisorKey:'s'.repeat(32),fetcher});
  const controller=createInstanceController({root,instanceId,controllerId:'retention-controller',coordinator,executor});
  await atomicJson(join(root,'journals',id+'.json'),{attemptId:id,planDigest:plan.planDigest,steps:{}});
  t.after(async()=>{for(const response of streams)response.end();for(const socket of sockets)socket.destroy();await entry.close();for(const server of servers){server.closeAllConnections();await new Promise(ok=>server.close(ok));}await rm(root,{recursive:true,force:true});});
  return {controller,entry,initial,getBinding,requests,events,streams,expire:()=>{leaseExpiresAt=0;},reclaims:()=>reclaims,journal:()=>readJson(join(root,'journals',id+'.json'))};
}

for(const weight of [100,0])test('expired confirmed lease metadata CAS preserves serving HTTP/WS and empty new scope at weight'+weight,async t=>{
  const f=await fixture(t,{weight}),url=new URL(f.entry.origin),socket=connect(Number(url.port),url.hostname);t.after(()=>socket.destroy());
  const read=()=>new Promise((ok,fail)=>{socket.once('data',b=>ok(b.toString()));socket.once('error',fail);}),opened=read();socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');assert.match(await opened,/101 Switching Protocols/);
  const response=await fetch(f.entry.origin+'/api/stream'),reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/original-http-before/);
  const before=fixed(await f.getBinding());
  for(let index=0;index<2;index++){
    if(index){f.expire();await new Promise(ok=>setTimeout(ok,3));}
    assert.equal((await f.controller.monitorOnce()).state,'retention-observed');
    const after=await f.getBinding();assert.deepEqual(fixed(after),{...before,fence:5+index,routeGeneration:8+index});assert.equal(after.activeWS,1);
    assert.equal((await(await fetch(f.entry.origin+'/api/who')).json()).backend,'original');
    const echoed=read();socket.write('same-ws-'+index);assert.equal(await echoed,'same-ws-'+index);
    for(const stream of f.streams)stream.write('same-http-'+index+'\n');assert.match(new TextDecoder().decode((await reader.read()).value),new RegExp('same-http-'+index));
  }
  assert.equal(f.reclaims(),2);assert.deepEqual(f.events,[]);assert.equal(f.requests.filter(r=>r.path==='/binding').length,2);
  const journal=await f.journal();assert.equal(journal.circuitBroken,undefined);assert.equal(journal.previousObservation.consecutive,0);assert.equal(journal.retentionBindingAdmission.servingEquivalent,true);
  await reader.cancel();
});

test('retention cannot lift a fence from corrupt activation, changed identity or competing metadata',async t=>{
  for(const [name,options,reason] of [
    ['receipt digest changed',{anchorChange:s=>s.receiptDigest=digest('wrong')},'CONFIRMED_SOURCE_ACTIVATION_RECEIPT_REQUIRED'],
    ['different confirmed serving tuple',{anchorChange:s=>{s.evidence.actual.web={...s.evidence.actual.web,root:'/another-web'};s.receiptDigest=digest(s.evidence);}},'CONFIRMED_SOURCE_ACTIVATION_RECEIPT_REQUIRED'],
    ['wrong current lease snapshot',{snapshotFence:4},'CONFIRMED_RETENTION_SCOPE_CHANGED'],
    ['process replaced',{replaceProcess:true},'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED'],
    ['competing binding',{raceCommit:true},'ENTRY_RPC_FAILED'],
  ])await t.test(name,async t=>{const f=await fixture(t,options);assert.equal((await f.controller.monitorOnce()).state,'ready-revoked');assert.equal(f.events[0].payload.reason,reason);assert.equal((await f.getBinding()).weight,100);});
});

test('an empty new probe cohort cannot conceal actual control, Web or measured attach failures',async t=>{
  for(const [name,options,reason] of [
    ['Owner authority',{patch:{ownerGenerationsValid:false}},'CONTROL_OR_OWNERSHIP_UNKNOWN'],
    ['Web failed',{webFailure:true},'WEB_UNHEALTHY'],
    ['failed fresh probe',{patch:{probes:{known:false,hz:0,samples:0,failures:1,maxLatencyMs:null,attachMaxMs:null,windowMs:0}}},'SLO_PROBE_FAILED'],
    ['measured attach deadline',{patch:{probes:{known:false,hz:0,samples:0,failures:0,maxLatencyMs:null,attachMaxMs:5001,windowMs:0}}},'SLO_PROBE_FAILED'],
    ['unknown attach with nonempty sample',{patch:{probes:{known:false,hz:0,samples:1,failures:0,maxLatencyMs:null,attachMaxMs:null,windowMs:0}}},'SLO_PROBE_FAILED'],
  ])await t.test(name,async t=>{const f=await fixture(t,options);assert.equal((await f.controller.monitorOnce()).state,'ready-revoked');assert.equal(f.events[0].payload.reason,reason);});
});
