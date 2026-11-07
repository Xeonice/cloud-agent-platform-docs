import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStableEntry } from './stable-entry.mjs';
import { createEntryContextVerifier, entryControlHeaders, entryBindingDigest, persistedEntryBinding } from './control-entry-context.mjs';
const key='e'.repeat(32), privateKey='p'.repeat(32), instanceId='control-entry-test';
const digest=letter=>'sha256:'+letter.repeat(64);
function deferred(){let release;const promise=new Promise(ok=>{release=ok;});return{promise,release};}
async function listener(handler){const server=http.createServer(handler);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));return{server,origin:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(ok=>{server.closeAllConnections();server.close(ok);})};}
async function fixture(t,options={}){
  const directory=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'entry-control-'))),webRoot=join(directory,'web');await fs.mkdir(webRoot);await fs.writeFile(join(webRoot,'index.html'),'test web');
  const seen=[];const verifier=createEntryContextVerifier({instanceId,key:privateKey});
  const agent=await listener((req,res)=>{let context;try{context=verifier.verify(req);}catch(error){res.writeHead(403);res.end(JSON.stringify({code:error.code}));return;}seen.push({url:req.url,headers:req.headers,context});if(options.agentHandler){options.agentHandler(req,res);return;}res.writeHead(200,{'content-type':'application/json','set-cookie':'ap_session=test-session; HttpOnly; Path=/'});res.end(JSON.stringify({independent:true,path:req.url}));});
  const business=await listener((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({business:true,path:req.url}));});
  const binding={instanceId,attemptId:'old-attempt',fence:26,routeGeneration:34,weight:25,oldApi:{origin:business.origin,digest:digest('a')},candidateApi:{origin:business.origin,digest:digest('b')},web:{digest:digest('c'),treeDigest:digest('d'),root:webRoot},retainedWeb:[]};
  const calls={fence:0,authority:0};
  const createOptions={root:join(directory,'entry'),instanceId,controlKey:key,stickyKey:'s'.repeat(32),initialBinding:binding,controlOrigin:agent.origin,privateEntryKey:privateKey,
    verifyFence:async value=>{calls.fence++;if(options.verifyFence)return options.verifyFence(value);},
    verifyControlAuthority:async value=>{calls.authority++;if(options.verifyControlAuthority)return options.verifyControlAuthority(value);return{leaseExpiresAt:(options.clock?.()??Date.now())+120000};},
    ...(options.clock?{clock:options.clock}:{}),...(options.entryOptions??{})};
  let entry=await createStableEntry(createOptions);
  t.after(async()=>{await entry.close();await agent.close();await business.close();await fs.rm(directory,{recursive:true,force:true});});
  function request(path,value,context,extra={}){return fetch(entry.controlOrigin+path,{method:value===undefined?'GET':'POST',headers:{'x-platform-internal-key':key,'content-type':'application/json',...(context?entryControlHeaders({key:privateKey,context}):{}),...extra},...(value===undefined?{}:{body:JSON.stringify(value)})});}
  const current=async()=>persistedEntryBinding(await(await request('/binding')).json());
  async function admit({epoch,kind='upgrade',operationId='operation-one',executorId='control-one',recoveryId,...over}={}){const previous=await(await request('/control-epoch')).json();return request('/control-epoch',{instanceId,expectedRevision:previous.revision,epoch,operationId,executorId,kind,leaseExpiresAt:(options.clock?.()??Date.now())+60000,...(recoveryId?{recoveryId}:{}),...over},undefined,{'x-platform-entry-controller-key':privateKey});}
  return{get entry(){return entry;},agent,business,binding,seen,calls,request,current,admit,directory,async restart(){await entry.close();entry=await createStableEntry(createOptions);},createOptions};
}
const context=(over={})=>({schemaVersion:1,epoch:1,operationId:'operation-one',executorId:'control-one',kind:'upgrade',...over});

test('stable same-origin control paths remain reachable with business API down and spoofed browser headers are replaced',async t=>{
  const f=await fixture(t);await f.business.close();
  const response=await fetch(f.entry.origin+'/api/system/upgrade/status',{headers:{cookie:'ap_session=original-session',origin:f.entry.origin,'x-upgrade-csrf':'original-csrf',forwarded:'for=127.0.0.1','x-forwarded-for':'127.0.0.1','x-platform-entry-context':'forged','x-platform-entry-signature':'0'.repeat(64),'x-platform-internal-key':'forged','x-platform-control-epoch':'99'}});
  assert.equal(response.status,200);assert.equal((await response.json()).independent,true);assert.match(response.headers.get('set-cookie'),/ap_session=test-session/);
  assert.equal(f.seen[0].headers.cookie,'ap_session=original-session');assert.equal(f.seen[0].headers['x-upgrade-csrf'],'original-csrf');assert.equal(f.seen[0].headers.origin,f.entry.origin);
  assert.equal(f.seen[0].headers.forwarded,undefined);assert.equal(f.seen[0].headers['x-platform-internal-key'],undefined);assert.equal(f.seen[0].headers['x-platform-control-epoch'],undefined);
  assert.equal(f.seen[0].context.clientIp,'127.0.0.1');assert.notEqual(f.seen[0].headers['x-platform-entry-context'],'forged');
  for(const path of ['/api/system/upgrade','/api/system/upgrade/requests/id','/api/system/access-passcode'])assert.equal((await fetch(f.entry.origin+path)).status,200);
  for(const path of ['/api/projects','/api/system/upgrades/status','/api/system/upgrade-other','/api/system/access-passcode/other'])assert.equal((await fetch(f.entry.origin+path)).status,502);
});

test('control configuration is explicit and public routing without it keeps legacy behavior',async t=>{
  const f=await fixture(t);await assert.rejects(()=>createStableEntry({...f.createOptions,root:join(f.directory,'invalid'),privateEntryKey:null}),{code:'ENTRY_CONTROL_CONFIGURATION_REQUIRED'});
  const legacy=await createStableEntry({...f.createOptions,root:join(f.directory,'legacy'),controlOrigin:null,privateEntryKey:null,verifyControlAuthority:undefined});t.after(()=>legacy.close());
  const response=await fetch(legacy.origin+'/api/system/upgrade/status');assert.equal((await response.json()).business,true);
});

test('local control CAS persists independent epoch while binding CAS retains original business attempt and fence',async t=>{
  const f=await fixture(t);assert.equal((await f.admit({epoch:1})).status,200);
  const before=await f.current(),next={...before,routeGeneration:35,weight:5};
  const applied=await f.request('/binding',next,context({expectedBindingDigest:entryBindingDigest({...before,inFlight:300,activeWS:7,httpByDigest:{fake:100},wsByDigest:{}})}));
  assert.equal(applied.status,200);assert.deepEqual(await f.current(),next);assert.equal(f.calls.fence,1);
  assert.equal((await f.request('/binding',{...next,routeGeneration:36,weight:0})).status,403);
  const stale=await f.request('/binding',{...next,routeGeneration:36},context({expectedBindingDigest:entryBindingDigest(before)}));assert.equal(stale.status,409);assert.equal((await stale.json()).code,'ENTRY_CONTROL_BINDING_CHANGED');
  const admission=JSON.parse(await fs.readFile(join(f.directory,'entry','entry-control-admission.json'),'utf8'));assert.equal(admission.epoch,1);assert.equal(admission.revision,1);assert.equal(admission.fence,undefined);
  assert.equal((await f.admit({epoch:0})).status,409);assert.equal((await f.admit({epoch:2,expectedRevision:0})).status,409);
});

test('a recovery epoch can retire candidate traffic after the failed business attempt has no lease',async t=>{
  const f=await fixture(t,{verifyFence:async()=>{throw Object.assign(new Error('old attempt expired'),{code:'BUSINESS_ATTEMPT_EXPIRED'});}});
  assert.equal((await f.admit({epoch:1})).status,200);
  assert.equal((await f.admit({epoch:2,kind:'recovery',operationId:'recovery-operation',recoveryId:'recovery-one'})).status,200);
  const before=await f.current(),recovery=context({epoch:2,kind:'recovery',operationId:'recovery-operation',recoveryId:'recovery-one',expectedBindingDigest:entryBindingDigest(before)});
  const restored=await f.request('/binding',{...before,routeGeneration:35,weight:0},recovery);assert.equal(restored.status,200);assert.equal(f.calls.fence,0);
  const after=await f.current();assert.equal(after.attemptId,before.attemptId);assert.equal(after.fence,before.fence);assert.equal(after.weight,0);
  assert.equal((await f.request('/fence',{instanceId,attemptId:'new-attempt',fence:27},recovery)).status,409);
  assert.equal((await f.request('/contract-fence',{instanceId,contractAttemptId:'contract-one',fence:27},recovery)).status,409);
  assert.equal((await f.request('/binding',{...after,routeGeneration:36,fence:27},context({...recovery,expectedBindingDigest:entryBindingDigest(after)}))).status,409);
  assert.equal((await f.request('/binding',{...after,routeGeneration:36},context({expectedBindingDigest:entryBindingDigest(after)}))).status,409);
});

test('an awaited old apply cannot race a new recovery admission and expiry is rechecked before atomic rename',async t=>{
  const held=deferred(),entered=deferred();let now=Date.now();
  const f=await fixture(t,{clock:()=>now,verifyFence:async()=>{entered.release();await held.promise;}});
  assert.equal((await f.admit({epoch:1})).status,200);const before=await f.current();
  const old=f.request('/binding',{...before,routeGeneration:35,weight:5},context({expectedBindingDigest:entryBindingDigest(before)}));await entered.promise;
  const blocked=await f.admit({epoch:2,kind:'recovery',operationId:'recovery-operation',recoveryId:'recovery-one'});assert.equal(blocked.status,409);assert.equal((await blocked.json()).code,'ENTRY_BUSY_OR_METHOD');
  now+=61000;held.release();assert.equal((await old).status,409);assert.deepEqual(await f.current(),before);
  assert.deepEqual(JSON.parse(await fs.readFile(join(f.directory,'entry','entry-binding.json'),'utf8')),before);
  assert.equal((await f.admit({epoch:2,kind:'recovery',operationId:'recovery-operation',recoveryId:'recovery-one'})).status,200);
});

test('control admission itself shares the apply lock with fence and route commands',async t=>{
  const held=deferred(),entered=deferred();const f=await fixture(t,{verifyControlAuthority:async next=>{if(next.expectedRevision!==undefined){entered.release();await held.promise;}return{leaseExpiresAt:Date.now()+120000};}});
  const admission=f.admit({epoch:1});await entered.promise;
  const fence=await f.request('/fence',{instanceId,attemptId:'new-attempt',fence:27});assert.equal(fence.status,409);assert.equal(f.calls.fence,0);
  const route=await f.request('/binding',{...f.binding,routeGeneration:35});assert.equal(route.status,409);
  held.release();assert.equal((await admission).status,200);
});

test('restart preserves the admitted recovery epoch and refuses a configuration downgrade',async t=>{
  const f=await fixture(t);assert.equal((await f.admit({epoch:3,kind:'recovery',operationId:'recovery-operation',recoveryId:'recovery-one'})).status,200);
  await f.restart();const admission=await(await f.request('/control-epoch')).json();assert.equal(admission.epoch,3);
  await assert.rejects(()=>createStableEntry({...f.createOptions,controlOrigin:null,privateEntryKey:null,verifyControlAuthority:undefined}),{code:'ENTRY_CONTROL_CONFIGURATION_REQUIRED'});
  const before=await f.current();assert.equal((await f.request('/binding',{...before,routeGeneration:35},context({expectedBindingDigest:entryBindingDigest(before)}))).status,409);
});

test('the controller lease is bounded by actual authority and an expired same epoch cannot be revived',async t=>{
  let now=Date.now();const f=await fixture(t,{clock:()=>now,verifyControlAuthority:async()=>({leaseExpiresAt:now+1000})});
  assert.equal((await f.admit({epoch:1})).status,409);assert.equal((await f.admit({epoch:1,leaseExpiresAt:now+500})).status,200);
  now+=600;const same=await f.admit({epoch:1,leaseExpiresAt:now+500});assert.equal(same.status,409);assert.equal((await same.json()).code,'ENTRY_CONTROL_STALE_EPOCH');
  assert.equal((await f.admit({epoch:2,leaseExpiresAt:now+500})).status,200);
});

test('control proxy concurrency and whole-request deadlines are bounded without retrying another backend',async t=>{
  const entered=deferred();const f=await fixture(t,{entryOptions:{maxControlRequests:1,controlRequestTimeoutMs:40},agentHandler:()=>entered.release()});
  const first=fetch(f.entry.origin+'/api/system/upgrade/status');await entered.promise;
  const second=await fetch(f.entry.origin+'/api/system/upgrade/status');assert.equal(second.status,503);assert.equal((await second.json()).code,'ENTRY_CONTROL_BUSY');
  const timeout=await first;assert.equal(timeout.status,504);assert.equal((await timeout.json()).code,'ENTRY_CONTROL_TIMEOUT');assert.equal(f.seen.length,1);
  assert.equal((await fetch(f.entry.origin+'/api/projects')).status,200);
});

test('contract authority can stamp only contract fence and cannot authorize a business fence or route',async t=>{
  let contractCalls=0;const f=await fixture(t,{entryOptions:{verifyContractFence:async()=>{contractCalls++;}}});
  assert.equal((await f.admit({epoch:1,kind:'contract',operationId:'contract-one'})).status,200);
  const contract=context({kind:'contract',operationId:'contract-one'});
  assert.equal((await f.request('/contract-fence',{instanceId,contractAttemptId:'contract-one',fence:27},contract)).status,200);
  assert.equal(contractCalls,1);assert.equal(f.calls.fence,0);
  assert.equal((await f.request('/fence',{instanceId,attemptId:'new-attempt',fence:28},contract)).status,409);
  const before=await f.current();assert.equal((await f.request('/binding',{...before,routeGeneration:35},context({...contract,expectedBindingDigest:entryBindingDigest(before)}))).status,409);
  assert.equal((await f.admit({epoch:2,kind:'upgrade'})).status,200);
  assert.equal((await f.request('/contract-fence',{instanceId,contractAttemptId:'contract-one',fence:28},context({epoch:2}))).status,409);
});

test('exact business probe goes through the business API and only a separately authenticated local observer retains private probe headers',async t=>{
  const probeKey='b'.repeat(32),seen=[];const f=await fixture(t,{entryOptions:{businessProbeKey:probeKey}});
  f.business.server.removeAllListeners('request');f.business.server.on('request',(req,res)=>{seen.push(req.headers);res.writeHead(200,{'content-type':'application/json','x-platform-probe-instance-id':instanceId});res.end(JSON.stringify({business:true}));});
  const headers={'x-platform-internal-key':probeKey,'x-platform-instance-id':instanceId,'x-platform-recovery-id':'00000000-0000-4000-8000-000000000001','x-platform-control-epoch':'99','x-platform-entry-context':'must-not-forward'};
  const trusted=await fetch(f.entry.origin+'/api/system/upgrade/probe?requestId=1',{headers});assert.equal((await trusted.json()).business,true);assert.equal(trusted.headers.get('x-platform-probe-instance-id'),instanceId);
  assert.equal(seen[0]['x-platform-internal-key'],probeKey);assert.equal(seen[0]['x-platform-recovery-id'],headers['x-platform-recovery-id']);assert.equal(seen[0]['x-platform-control-epoch'],'99');assert.equal(seen[0]['x-platform-entry-context'],undefined);
  await fetch(f.entry.origin+'/api/system/upgrade/probe',{headers:{...headers,'x-platform-internal-key':key}});assert.equal(seen[1]['x-platform-internal-key'],undefined);assert.equal(seen[1]['x-platform-recovery-id'],undefined);
  assert.equal((await fetch(f.entry.origin+'/api/system/upgrade/probe/other')).status,200);assert.equal(f.seen.at(-1).context.path,'/api/system/upgrade/probe/other');assert.equal(seen.length,2);
});

test('business observer key reads only the exact binding route and cannot admit or mutate any control state',async t=>{
  const observerKey='o'.repeat(32),f=await fixture(t,{entryOptions:{observerKey}});
  const observer=async(path,method='GET',value)=>fetch(f.entry.controlOrigin+path,{method,headers:{'x-platform-internal-key':observerKey,'content-type':'application/json','x-platform-entry-controller-key':privateKey,...entryControlHeaders({key:privateKey,context:context()})},...(value===undefined?{}:{body:JSON.stringify(value)})});
  const before=await f.current();const read=await observer('/binding');assert.equal(read.status,200);assert.deepEqual(persistedEntryBinding(await read.json()),before);
  for(const path of ['/metadata','/control-epoch','/binding/','/binding?read=true','/unknown'])assert.equal((await observer(path)).status,403,path);
  for(const path of ['/binding','/fence','/contract-fence','/control-epoch'])assert.equal((await observer(path,'POST',{...before,routeGeneration:35})).status,403,path);
  assert.equal((await observer('/binding','HEAD')).status,403);assert.equal((await observer('/binding','PUT',{})).status,403);
  assert.deepEqual(await f.current(),before);assert.equal(f.calls.authority,0);assert.equal(f.calls.fence,0);
  assert.equal((await(await f.request('/control-epoch')).json()).epoch,0);
  await assert.rejects(()=>createStableEntry({...f.createOptions,root:join(f.directory,'observer-equals-write'),observerKey:key}),{code:'ENTRY_OBSERVER_KEY_INVALID'});
  await assert.rejects(()=>createStableEntry({...f.createOptions,root:join(f.directory,'observer-equals-hmac'),observerKey:privateKey}),{code:'ENTRY_OBSERVER_KEY_INVALID'});
});
