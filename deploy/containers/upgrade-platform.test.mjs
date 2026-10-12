import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync,createHash } from 'node:crypto';
import { canonical,digest,signManifest,verifyManifest,freezePlan,loadTrustRoot,runInputFingerprint } from '../upgrade/trust.mjs';
import { atomicJson,treeManifest,fileDigest } from '../upgrade/io.mjs';
import { createStableEntry } from '../upgrade/stable-entry.mjs';
import { command,downloadVerified,unpackVerified } from '../upgrade/artifacts.mjs';
import { inspectObservation,qualifiedFallback } from '../upgrade/circuit-breaker.mjs';
import { buildQualificationDistribution } from '../upgrade/build-distribution.mjs';
import { createPublicationArtifactReader } from '../jenkins/publication-artifact-reader.mjs';
import { createCoordinatorClient } from '../upgrade/coordinator-client.mjs';
import { createCandidateSupervisor } from '../upgrade/candidate-supervisor.mjs';
import { createInstanceController } from '../upgrade/instance-controller.mjs';

const H='sha256:'+'a'.repeat(64),B='sha256:'+'b'.repeat(64),W='sha256:'+'c'.repeat(64),V='sha256:'+'d'.repeat(64);
function fixture() {
  const keys=generateKeyPairSync('ed25519'),privateKey=keys.privateKey.export({format:'pem',type:'pkcs8'}),publicKey=keys.publicKey.export({format:'pem',type:'spki'});
  const artifact=d=>({artifactDigest:d,inputFingerprint:H,sourceRevision:'a'.repeat(40),protocol:{min:1,max:2}});
  const policy={id:'policy-1',weights:[1,5,25,100],stageDurationMs:60000,minRequests:100,observationFreshnessMs:5000,probeHz:10,requestDeadlineMs:2000,attachDeadlineMs:5000,softErrorDelta:0.01,p95Ratio:2,p95FloorMs:1000,evaluationIntervalMs:10000,consecutiveEvaluations:2,retentionMs:600000,migrationBatchMs:500,maxWalBytes:100000000,minFreeBytes:1000000000,fallbacks:[{releaseId:'v1.0.0',apiDigest:B,webDigest:W,rehearsed:true}],stopUserResources:false,restoreLiveVolume:false,contractInUpgrade:false};
  const manifest={schemaVersion:2,releaseId:'v1.1.0',channel:'stable',publishedAt:new Date().toISOString(),commits:{project:'a'.repeat(40),api:'b'.repeat(40),web:'c'.repeat(40)},components:{api:artifact(H),coordinator:artifact(H),web:{...artifact(V),webRevision:'d'.repeat(40)},installer:artifact(H)},packages:[{platform:process.platform,arch:process.arch,name:'instance.tgz',url:'https://dist.example.com/instance.tgz',digest:H,bytes:4096,format:'native-tar'}],upgradePaths:[{fromRelease:'v1.0.0',minSchema:1,maxSchema:1,targetSchema:1,bridgeReleases:[],migrationPlanDigest:null}],policy,evidence:['build','contracts','four-combinations','native-continuity','fault-recovery'].map(kind=>({kind,result:'passed',inputFingerprint:H,reportDigest:H,runId:'cryptography-test-only',recordedAt:new Date().toISOString()}))};
  const roots={schemaVersion:1,channel:'stable',keys:[{id:'test-key',publicKey}],distributionOrigins:['https://dist.example.com']};
  const current={releaseId:'v1.0.0',schema:1,channel:'stable',platform:process.platform,arch:process.arch,protocols:{api:{min:1,max:1},web:{min:1,max:1},installer:{min:1,max:1}},bridges:[],generation:1,apiDigest:B,apiInputFingerprint:H,webDigest:W,webInputFingerprint:H,installerDigest:H,installerInputFingerprint:H};
  return {keys,privateKey,manifest,roots,current,policy};
}
async function folder(t) {const path=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'upgrade-deploy-test-')));t.after(()=>fs.rm(path,{recursive:true,force:true}));return path;}
async function listen(t,handler) {const server=http.createServer(handler);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>{server.closeAllConnections();return new Promise(ok=>server.close(ok));});return {server,origin:'http://127.0.0.1:'+server.address().port};}

test('B01 cryptographic catalogue: fixed Ed25519 root, canonical bytes, tampering and wrong roots reject',()=>{
  const f=fixture(),signed=signManifest(f.manifest,'test-key',f.privateKey);assert.equal(verifyManifest(signed,f.roots,f.current).manifestDigest,digest(canonical(f.manifest)));
  const changed=structuredClone(signed);changed.manifest.releaseId='v9.0.0';assert.throws(()=>verifyManifest(changed,f.roots,f.current),{code:'SIGNATURE_OR_MANIFEST_DIGEST_INVALID'});
  const other=fixture();assert.throws(()=>verifyManifest(signed,other.roots,f.current),{code:'SIGNATURE_OR_MANIFEST_DIGEST_INVALID'});assert.throws(()=>canonical({x:Infinity}),{code:'NON_FINITE'});
});
test('B01 signed catalogue refuses architecture, origin, schema path, required bridge and channel mismatch before installation',()=>{
  const f=fixture();const signed=signManifest(f.manifest,'test-key',f.privateKey);
  for(const [patch,code]of [[{arch:'wrong'},'UNSUPPORTED_ARCHITECTURE'],[{schema:2},'UPGRADE_PATH_NOT_SUPPORTED'],[{channel:'beta'},'WRONG_CHANNEL']])assert.throws(()=>verifyManifest(signed,f.roots,{...f.current,...patch}),{code});
  const m=structuredClone(f.manifest);m.upgradePaths[0].bridgeReleases=['v1.0.1'];assert.throws(()=>verifyManifest(signManifest(m,'test-key',f.privateKey),f.roots,f.current),{code:'UPGRADE_PATH_NOT_SUPPORTED'});
  m.upgradePaths[0].bridgeReleases=[];m.packages[0].url='https://untrusted.example/instance.tgz';assert.throws(()=>verifyManifest(signManifest(m,'test-key',f.privateKey),f.roots,f.current),{code:'UNTRUSTED_DISTRIBUTION_ORIGIN'});
  m.withdrawn=true;assert.throws(()=>signManifest(m,'test-key',f.privateKey),{code:'INVALID_RELEASE_MANIFEST'});
});
test('B09 fixed plan uses actual artifact and input fingerprint, does not promote same-artifact Web or recreate unchanged API',()=>{
  const f=fixture();f.manifest.components.api.artifactDigest=f.current.apiDigest;f.manifest.components.coordinator.artifactDigest=f.current.apiDigest;f.manifest.components.web.artifactDigest=f.current.webDigest;
  const verified=verifyManifest(signManifest(f.manifest,'test-key',f.privateKey),f.roots,f.current),plan=freezePlan(verified,f.current);
  assert.equal(plan.apiReused,true);assert.equal(plan.webReused,true);assert.deepEqual(plan.steps.map(s=>s.kind),['download','verify','activation']);const p={...plan};delete p.planDigest;assert.equal(plan.planDigest,digest(p));
  f.current.apiInputFingerprint=V;assert.equal(freezePlan(verified,f.current).apiReused,false);
});
test('same-release repair requires validated partial source tuples and an explicit signed repair path',()=>{
  const f=fixture();f.manifest.upgradePaths.push({fromRelease:f.manifest.releaseId,minSchema:1,maxSchema:1,targetSchema:1,bridgeReleases:[],migrationPlanDigest:null});
  const current={...f.current,releaseId:f.manifest.releaseId,coordinatorDigest:H,coordinatorInputFingerprint:H,apiDigest:H,webDigest:V};const envelope=signManifest(f.manifest,'test-key',f.privateKey);
  assert.throws(()=>verifyManifest(envelope,f.roots,current),{code:'ALREADY_INSTALLED'});assert.throws(()=>verifyManifest(envelope,f.roots,{...current,partialRepair:true}),{code:'ALREADY_INSTALLED'});
  const partial={...current,partialRepair:true,webDigest:W};assert.equal(verifyManifest(envelope,f.roots,partial).path.migrationPlanDigest,null);const plan=freezePlan(verifyManifest(envelope,f.roots,partial),partial);assert.deepEqual(plan.steps.map(s=>s.kind),['download','verify','web','activation']);
  f.manifest.upgradePaths.pop();assert.throws(()=>verifyManifest(signManifest(f.manifest,'test-key',f.privateKey),f.roots,partial),{code:'UPGRADE_PATH_NOT_SUPPORTED'});
});
test('B01 trust-root installation refuses writable files and never fetches replacement signing keys',async t=>{
  const root=await folder(t),f=fixture(),path=join(root,'trust.json');await atomicJson(path,f.roots);assert.deepEqual(await loadTrustRoot(path),f.roots);await fs.chmod(path,0o666);await assert.rejects(loadTrustRoot(path),{code:'INSECURE_TRUST_ROOT'});
});
test('B04 actual download resumes durable bytes, verifies SHA256, rejects corrupt cache without executing a package',async t=>{
  const root=await folder(t),bytes=Buffer.alloc(2*1024*1024+17,0x31),pkg={name:'download.tgz',digest:digest(bytes),bytes:bytes.length};let calls=0,ranges=[];
  const server=await listen(t,(req,res)=>{calls++;ranges.push(req.headers.range);const at=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0);if(at){res.writeHead(206,{'content-range':`bytes ${at}-${bytes.length-1}/${bytes.length}`});}res.end(bytes.subarray(at));});pkg.url=server.origin+'/fixed';await fs.mkdir(join(root,'downloads'),{mode:0o700});const partial=join(root,'downloads',pkg.digest.slice(7)+'.tgz.partial');await fs.writeFile(partial,bytes.subarray(0,10000));let progressed=0;let fences=0;
  const r=await downloadVerified(pkg,root,{assertFence:async()=>fences++,onProgress:async n=>{assert.ok(n>=progressed);progressed=n;}});assert.equal(r.digest,pkg.digest);assert.equal(progressed,pkg.bytes);assert.equal(ranges[0],'bytes=10000-');assert.ok(fences>1);
  await downloadVerified(pkg,root,{assertFence:async()=>{}});assert.equal(calls,1);await fs.writeFile(r.path,'bad');await assert.rejects(downloadVerified(pkg,root,{assertFence:async()=>{}}),{code:'CACHED_PACKAGE_CORRUPT'});
});
// A real slow HTTP body crosses the production controller's periodic renewal.
// The contract receiver is a boundary double; this is not native qualification.
test('controller sends renewal authority without claim-only options during a download longer than one second',async t=>{
  const root=await folder(t),f=fixture(),bytes=Buffer.alloc(4096,0x5a),id='11111111-1111-4111-8111-111111111112';let sequence=0,verifiedDownload=false;const renewals=[];
  const upstream=await listen(t,async(req,res)=>{
    if(req.url==='/package'){res.writeHead(200,{'content-length':bytes.length});res.write(bytes.subarray(0,2048));setTimeout(()=>res.end(bytes.subarray(2048)),1400);return;}
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);res.setHeader('content-type','application/json');
    if(req.url==='/internal/upgrades/'+id+'/renew'&&req.method==='POST'){renewals.push(body);res.end(JSON.stringify({fence:3}));return;}
    res.writeHead(400);res.end(JSON.stringify({error:{code:'INVALID_RENEW_REQUEST'}}));
  });
  f.manifest.packages[0].digest=digest(bytes);f.manifest.packages[0].bytes=bytes.length;
  const envelope=signManifest(f.manifest,'test-key',f.privateKey),verified=verifyManifest(envelope,f.roots,f.current),plan=freezePlan(verified,f.current);
  const artifact=artifactDigest=>({artifactDigest,inputFingerprint:H,sourceRevision:'a'.repeat(40),protocol:{min:1,max:1}});
  const attempt={instanceId:'instance',attemptId:id,actorId:'operator',requestId:'22222222-2222-4222-8222-222222222223',acceptedAt:new Date().toISOString(),state:'accepted',sequence:0,generation:2,targetDigest:verified.manifestDigest,planDigest:plan.planDigest};
  const record={attempt,actorId:'operator',signedManifest:envelope,plan,sourceActivation:{releaseId:f.current.releaseId,schema:1,channel:'stable',activationGeneration:1,components:{api:artifact(B),coordinator:artifact(B),web:{...artifact(W),webRevision:'c'.repeat(40)},installer:artifact(H)}}};
  await atomicJson(join(root,'trust.json'),f.roots);
  const actualClient=createCoordinatorClient({origin:upstream.origin,instanceId:'instance',key:'k'.repeat(32)});
  const coordinator={pending:async()=>record,claim:async(_id,body)=>{assert.equal(body.leaseMs,15000);return {fence:3,generation:2,snapshot:record};},renew:actualClient.renew,assertFence:async()=>{},step:async()=>null,
    commit:async(_id,event)=>{assert.equal(event.expectedSequence,sequence);sequence++;return {attempt:{...attempt,sequence}};}};
  const executor={prepare:async()=>{verifiedDownload=true;throw Object.assign(Error('Intentional unit-test verification boundary'),{code:'VERIFICATION_BOUNDARY'});},actual:async()=>({weight:0}),fallbackEligibility:async()=>({qualified:false})};
  const controller=createInstanceController({root,instanceId:'instance',controllerId:'controller',trustRootPath:join(root,'trust.json'),coordinator,executor,fetcher:(_url,options)=>fetch(upstream.origin+'/package',options)});
  await assert.rejects(controller.runOnce(),{code:'VERIFICATION_BOUNDARY'});assert.ok(renewals.length>=1);assert.equal(verifiedDownload,true);
  for(const renewal of renewals){assert.deepEqual(Object.keys(renewal).sort(),['controllerId','fence']);assert.equal(renewal.fence,3);assert.equal(typeof renewal.controllerId,'string');}
  const download=await fileDigest(join(root,'downloads',digest(bytes).slice(7)+'.tgz'));assert.equal(download.digest,digest(bytes));assert.equal(download.bytes,bytes.length);
});
test('B01 actual archive bytes/tree validation and unsafe link rejection',async t=>{
  const root=await folder(t),source=join(root,'source');await fs.mkdir(source,{mode:0o700});await fs.mkdir(join(source,'api'));await fs.mkdir(join(source,'web'));await fs.mkdir(join(source,'installer'));await fs.writeFile(join(source,'installer/controller.mjs'),'export const version=1;');await fs.writeFile(join(source,'api/code.js'),'export const a=1;');await fs.writeFile(join(source,'web/index.html'),'old page');const files=await treeManifest(source),f=fixture();f.manifest.components.api.artifactDigest=digest(files.filter(x=>x.path.startsWith('api/')));f.manifest.components.coordinator.artifactDigest=f.manifest.components.api.artifactDigest;f.manifest.components.installer.artifactDigest=digest(files.filter(x=>x.path.startsWith('installer/')));f.manifest.components.web.artifactDigest=digest(files.filter(x=>x.path.startsWith('web/')));
  await atomicJson(join(source,'upgrade-artifact.json'),{schemaVersion:1,platform:process.platform,arch:process.arch,components:f.manifest.components,treeDigest:digest(files),files});const archive=join(root,'archive.tgz');await command('tar',['-czf',archive,'-C',source,'.']);const hash=await fileDigest(archive),pkg={...hash,platform:process.platform,arch:process.arch};const installed=await unpackVerified(archive,pkg,root,f.manifest.components);assert.equal(await fs.readFile(join(installed.root,'api/code.js'),'utf8'),'export const a=1;');
  await fs.symlink('/etc/passwd',join(source,'escape'));const unsafe=join(root,'unsafe.tgz');await command('tar',['-czf',unsafe,'-C',source,'.']);const u={...await fileDigest(unsafe),platform:process.platform,arch:process.arch};await assert.rejects(unpackVerified(unsafe,u,root,f.manifest.components),{code:'UNSAFE_ARCHIVE_TYPE'});
});
test('B01 a verified contained package link preserves shared module identity and an escaping chain is rejected',async t=>{
  const root=await folder(t),source=join(root,'source');for(const path of ['api/modules','api/node_modules/@platform','web','installer'])await fs.mkdir(join(source,path),{recursive:true});
  await fs.writeFile(join(source,'api/modules/contracts.js'),'module.exports={token:Symbol("shared")};');await fs.symlink('../../modules/contracts.js',join(source,'api/node_modules/@platform/contracts.js'));await fs.symlink('../../modules',join(source,'api/node_modules/@platform/shared'));
  await fs.writeFile(join(source,'web/page.html'),'web');await fs.writeFile(join(source,'installer/controller-main.mjs'),'export const testOnly=true;');const files=await treeManifest(source),f=fixture();
  for(const kind of ['api','coordinator'])f.manifest.components[kind].artifactDigest=digest(files.filter(row=>row.path.startsWith('api/')));f.manifest.components.web.artifactDigest=digest(files.filter(row=>row.path.startsWith('web/')));f.manifest.components.installer.artifactDigest=digest(files.filter(row=>row.path.startsWith('installer/')));
  await atomicJson(join(source,'upgrade-artifact.json'),{schemaVersion:1,platform:process.platform,arch:process.arch,components:f.manifest.components,files,treeDigest:digest(files)});const archive=join(root,'safe.tgz');await command('tar',['-czf',archive,'-C',source,'.']);const pkg={...await fileDigest(archive),platform:process.platform,arch:process.arch};const installed=await unpackVerified(archive,pkg,root,f.manifest.components);
  assert.equal(await fs.readlink(join(installed.root,'api/node_modules/@platform/contracts.js')),'../../modules/contracts.js');const actual=await command(process.execPath,['-e','const r=require;process.stdout.write(String(r("./modules/contracts.js").token===r("./node_modules/@platform/contracts.js").token))'],{cwd:join(installed.root,'api')});assert.equal(actual,'true');
  await fs.symlink('../../../../outside',join(source,'api/modules/escape'));const unsafe=join(root,'escape.tgz');await command('tar',['-czf',unsafe,'-C',source,'.']);await assert.rejects(unpackVerified(unsafe,{...await fileDigest(unsafe),platform:process.platform,arch:process.arch},root,f.manifest.components),{code:'UNSAFE_ARCHIVE_TYPE'});
});
test('B04 no accepted durable user intent means no download, candidate, migration or entry switch',async t=>{
  const root=await folder(t);let executorCalls=0,downloads=0;const executor=new Proxy({}, {get(){executorCalls++;return ()=>{};}}),controller=createInstanceController({root,instanceId:'instance',controllerId:'controller',trustRootPath:join(root,'absent-trust.json'),coordinator:{pending:async()=>({attempts:[]})},executor,fetcher:async()=>downloads++});assert.deepEqual(await controller.runOnce(),{state:'idle'});assert.equal(executorCalls,0);assert.equal(downloads,0);
});
test('B08 measured circuit policy never passes missing samples, stale observations, unsafe ownership or publication errors',()=>{
  const f=fixture(),now=Date.now(),good={observedAt:new Date(now).toISOString(),fenceValid:true,ownerGenerationsValid:true,routeGenerationValid:true,sharedStateHealthy:true,continuity:{qualified:true},invariants:{unauthorizedStops:0,resourceRebuilds:0,duplicateCommands:0,duplicateOccurrences:0,writerConflicts:0,migrationDifferences:0,integrityFailures:0},probes:{hz:10,samples:600,failures:0,maxLatencyMs:100,attachMaxMs:100},candidate:{requests:100,errorRate:0,p95Ms:100},baseline:{errorRate:0,p95Ms:100},windowMs:60000};
  assert.equal(inspectObservation(good,f.policy,now).qualified,true);assert.equal(inspectObservation({...good,candidate:{...good.candidate,requests:99}},f.policy,now).pending,true);assert.equal(inspectObservation({...good,observedAt:new Date(now-5001).toISOString()},f.policy,now).fault,'OBSERVATION_STALE');assert.equal(inspectObservation({...good,probes:{...good.probes,failures:1}},f.policy,now).fault,'SLO_PROBE_FAILED');
  const worse={...good,candidate:{...good.candidate,errorRate:0.1}};const first=inspectObservation(worse,f.policy,now);assert.equal(first.pending,true);assert.equal(inspectObservation(worse,f.policy,now,first).fault,'SOFT_TRAFFIC_DEGRADATION');
});
test('B08 fallback requires latest-data, still-loaded Web, every owner, live fence and fresh authenticated facts',()=>{
  const f=fixture(),attempt={instanceId:'instance',plan:{policy:f.policy}},e={qualified:true,instanceId:'instance',fence:2,observedAt:new Date().toISOString(),migrationCommitKnown:true,sharedStateHealthy:true,releaseId:'v1.0.0',apiDigest:B,webDigest:W,rehearsalDigest:H,currentDataEpoch:9};
  for(const k of ['artifactImmutable','healthy','capacitySufficient','latestDatabaseCompatible','newWritesCompatible','loadedWebCompatible','allOwnersCompatible','coordinatorCompatible','authContinuous','originalResourcesAddressable','dedupCancellationCursorPreserved'])e[k]=true;
  assert.equal(qualifiedFallback(e,{attempt,fence:2}),true);for(const key of ['loadedWebCompatible','latestDatabaseCompatible','allOwnersCompatible'])assert.equal(qualifiedFallback({...e,[key]:false},{attempt,fence:2}),false);assert.equal(qualifiedFallback({...e,observedAt:'invalid'},{attempt,fence:2}),false);assert.equal(qualifiedFallback(e,{attempt,fence:1}),false);
});
test('B04 stable HTTP entry switches once, preserves current writes and instance Web binding, retains old chunks',async t=>{
  const root=await folder(t);let aWrites=0,bWrites=0;const a=await listen(t,(req,res)=>{if(req.method==='POST')aWrites++;res.end('api-a');}),b=await listen(t,(req,res)=>{if(req.method==='POST')bWrites++;res.end('api-b');});
  const webA=join(root,'web-a'),webB=join(root,'web-b');for(const [folder,text]of [[webA,'web-a'],[webB,'web-b']]){await fs.mkdir(join(folder,'_next/static'),{recursive:true});await fs.writeFile(join(folder,'index.html'),text);}await fs.writeFile(join(webA,'_next/static/old.js'),'old lazy chunk');
  const binding={instanceId:'instance',fence:1,routeGeneration:1,attemptId:'initial',weight:0,oldApi:{origin:a.origin,digest:B},candidateApi:{origin:b.origin,digest:H},web:{root:webA,digest:W,treeDigest:W},retainedWeb:[]};let liveFence=1;
  const entry=await createStableEntry({root:join(root,'entry'),instanceId:'instance',controlKey:'k'.repeat(32),stickyKey:'s'.repeat(32),verifyFence:async ({fence})=>assert.equal(fence,liveFence),initialBinding:binding});t.after(()=>entry.close());
  assert.equal(await (await fetch(entry.origin+'/api/write',{method:'POST',body:'operation-1'})).text(),'api-a');assert.equal(await (await fetch(entry.origin+'/')).text(),'web-a');
  assert.equal(await (await fetch(entry.origin+'/mcp?sessionId=before',{method:'POST',body:'actual-mcp-request'})).text(),'api-a');
  const update={...binding,fence:2,routeGeneration:2,weight:100,web:{root:webB,digest:V,treeDigest:V},retainedWeb:[binding.web]};liveFence=2;const admitted=await fetch(entry.controlOrigin+'/fence',{method:'POST',headers:{'x-platform-internal-key':'k'.repeat(32)},body:JSON.stringify({instanceId:'instance',attemptId:'initial',fence:2})});assert.equal(admitted.status,200);const r=await fetch(entry.controlOrigin+'/binding',{method:'POST',headers:{'x-platform-internal-key':'k'.repeat(32)},body:JSON.stringify(update)});assert.equal(r.status,200);
  assert.equal(await (await fetch(entry.origin+'/api/write',{method:'POST',body:'operation-2'})).text(),'api-b');assert.equal(await (await fetch(entry.origin+'/mcp?sessionId=after',{method:'POST',body:'actual-mcp-request'})).text(),'api-b');assert.deepEqual([aWrites,bWrites],[2,2]);assert.equal(await (await fetch(entry.origin+'/')).text(),'web-b');assert.equal(await (await fetch(entry.origin+'/_next/static/old.js')).text(),'old lazy chunk');
  const stale=await fetch(entry.controlOrigin+'/binding',{method:'POST',headers:{'x-platform-internal-key':'k'.repeat(32)},body:JSON.stringify({...binding,routeGeneration:3})});assert.equal(stale.status,409);assert.equal(entry.observe().web.digest,V);
});
test('CD templates expose no instance deploy, global promote or runtime monitor; separate publication profile has no instance volumes/socket',async()=>{
  const release=await fs.readFile(new URL('../jenkins/release.groovy',import.meta.url),'utf8'),api=await fs.readFile(new URL('../jenkins/api.groovy',import.meta.url),'utf8');
  assert.doesNotMatch(release,/WEB_TOOL|\bpromote\b|MONITOR_TOOL|api-container\.mjs/);assert.doesNotMatch(api,/API_TOOL" deploy|API_TOOL" monitor/);assert.match(release,/Sign fixed manifest/);assert.match(release,/agent-platform-upgrade-evidence/);
  const compose=JSON.parse(await fs.readFile(new URL('./compose.publication.json',import.meta.url),'utf8'));const publisher=compose.services.publisher;assert.ok(publisher.cap_drop.includes('ALL'));assert.ok(!publisher.volumes.some(v=>/docker\.sock|runtime|api_secrets|\/data|boxlite/i.test(v.target+v.source)));assert.notEqual(compose.services['api-build'].environment.DOCKER_HOST,'unix:///var/run/docker.sock');
});

// This exercises the real controller loop with a contract boundary double; it is not native qualification.
test('X05 controller loop observes accepted retention after 100 and trips exactly once without retrying the upgrade',async t=>{
  const root=await folder(t),f=fixture(),id='11111111-1111-4111-8111-111111111111';const plan={planDigest:H,policy:f.policy};let sequence=12,failed=false,claims=0,events=[];
  const accepted={instanceId:'instance',attemptId:id,requestId:'22222222-2222-4222-8222-222222222222',actorId:'operator',state:'activation-confirmed',sequence,generation:2,targetDigest:H,observedAt:new Date().toISOString()};
  await atomicJson(join(root,'journals',id+'.json'),{attemptId:id,planDigest:H,steps:{},confirmedAt:accepted.observedAt});
  const coordinator={pending:async()=>({attempts:[]}),snapshot:async()=>({attempt:{...accepted,sequence},plan,manifest:f.manifest}),claim:async()=>{claims++;return {fence:3,generation:2,snapshot:{attempt:{...accepted,sequence}}};},assertFence:async()=>{},commit:async(_id,c)=>{events.push(c.kind);sequence++;return {attempt:{...accepted,sequence}};}};
  const observation=()=>({observedAt:new Date().toISOString(),fenceValid:true,ownerGenerationsValid:true,routeGenerationValid:true,sharedStateHealthy:true,continuity:{qualified:true},invariants:{unauthorizedStops:0,resourceRebuilds:0,duplicateCommands:0,duplicateOccurrences:0,writerConflicts:0,migrationDifferences:0,integrityFailures:0},probes:{hz:10,samples:600,failures:failed?1:0,maxLatencyMs:100,attachMaxMs:100},candidate:{requests:100,errorRate:0,p95Ms:100},baseline:{errorRate:0,p95Ms:100},windowMs:60000});
  const executor={observe:async()=>observation(),actual:async()=>({weight:100}),fallbackEligibility:async()=>({qualified:false})};const controller=createInstanceController({root,instanceId:'instance',controllerId:'controller',trustRootPath:'not-used',coordinator,executor});
  assert.equal((await controller.runOnce()).state,'retention-observed');failed=true;const journalPath=join(root,'journals',id+'.json'),journal=JSON.parse(await fs.readFile(journalPath));delete journal.nextObservationAt;await atomicJson(journalPath,journal);
  assert.equal((await controller.runOnce()).state,'ready-revoked');assert.deepEqual(events,['ready-revoked']);assert.equal((await controller.runOnce()).state,'idle');assert.equal(claims,2);assert.equal(JSON.parse(await fs.readFile(journalPath)).circuitBroken,true);assert.equal(accepted.state,'activation-confirmed');
});

test('B01 isolated qualification uses an independent signature domain and honest not-run evidence',async t=>{
  const root=await folder(t),f=fixture(),bytes=Buffer.alloc(4096,42);f.manifest.packages[0].digest=digest(bytes);await fs.writeFile(join(root,f.manifest.packages[0].name),bytes);
  const result=await buildQualificationDistribution({manifest:f.manifest,outputRoot:root,instanceId:'qualification-instance',runId:'actual-crypto-unit'});
  assert.ok(result.envelope.manifest.evidence.every(e=>e.result==='not-run'));assert.ok(result.envelope.manifest.policy.fallbacks.every(f=>f.rehearsed===false));assert.equal(runInputFingerprint(result.envelope.manifest),runInputFingerprint(f.manifest));
  assert.equal(verifyManifest(result.envelope,result.trustRoot,{...f.current,instanceId:'qualification-instance'}).manifestDigest,result.envelope.manifestDigest);
  assert.throws(()=>verifyManifest(result.envelope,result.trustRoot,{...f.current,instanceId:'other-instance'}),{code:'WRONG_QUALIFICATION_INSTANCE'});
  assert.throws(()=>verifyManifest(result.envelope,{...result.trustRoot,purpose:'release'},{...f.current,instanceId:'qualification-instance'}),{code:'WRONG_TRUST_DOMAIN'});
  assert.throws(()=>verifyManifest(result.envelope,f.roots,{...f.current,instanceId:'qualification-instance'}),{code:'UNTRUSTED_SIGNING_KEY'});
  assert.throws(()=>signManifest(result.envelope.manifest,'test-key',f.privateKey),{code:'WRONG_MANIFEST_PURPOSE'});
  for(const evidence of result.envelope.manifest.evidence)assert.equal((await fileDigest(join(root,'qualification-'+evidence.kind+'.json'))).digest,evidence.reportDigest);
  assert.ok(!(await fs.readdir(root)).some(n=>/pem|private|key/.test(n)));
});
test('CD readonly artifact gateway cannot enqueue, change jobs, fetch secrets or forward caller credentials',async t=>{
  let requests=[];const upstream=await listen(t,(req,res)=>{requests.push({method:req.method,url:req.url,authorization:req.headers.authorization});res.setHeader('content-type','application/json');res.end(JSON.stringify({number:7,result:'SUCCESS'}));});
  const gateway=await createPublicationArtifactReader({jenkinsOrigin:upstream.origin,username:'installed-backend',token:'private-upstream-token',readerKey:'r'.repeat(32),host:'127.0.0.1',port:0});t.after(()=>gateway.close());
  const path='/job/agent-platform-api/7/api/json?tree=number,result';let response=await fetch(gateway.origin+path,{headers:{'x-publication-reader-key':'r'.repeat(32)}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{number:7,result:'SUCCESS'});
  assert.deepEqual(requests.map(r=>[r.method,r.url]),[['GET',path]]);assert.equal(requests[0].authorization,'Basic '+Buffer.from('installed-backend:private-upstream-token').toString('base64'));
  for(const [method,p,key]of [['POST',path,'r'.repeat(32)],['GET','/script','r'.repeat(32)],['GET','/job/agent-platform-api/7/artifact/%2e%2e/secret','r'.repeat(32)],['GET','/job/unknown/7/artifact/ci.json','r'.repeat(32)],['GET',path,'bad']]){response=await fetch(gateway.origin+p,{method,headers:{'x-publication-reader-key':key}});assert.ok(response.status>=400);}
  assert.equal(requests.length,1);
});

test('B04 real WebSocket transport retains the original connection while new connections use the switched API',async t=>{
  const root=await folder(t),sockets=new Set();
  async function backend(label){const endpoint=await listen(t,(_req,res)=>res.end(label));endpoint.server.on('upgrade',(req,socket)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('data',chunk=>{if((chunk[0]&15)===8){socket.end(Buffer.from([0x88,0]));return;}const text=Buffer.from(label);socket.write(Buffer.concat([Buffer.from([0x81,text.length]),text]));});});return endpoint;}
  t.after(()=>{for(const socket of sockets)socket.destroy();});const a=await backend('owner-a'),b=await backend('owner-b');
  const web=join(root,'web');await fs.mkdir(web);await fs.writeFile(join(web,'index.html'),'web');let fence=1;const initial={instanceId:'instance',fence:1,routeGeneration:1,attemptId:'initial',weight:0,oldApi:{origin:a.origin,digest:B},candidateApi:{origin:b.origin,digest:H},web:{root:web,digest:W,treeDigest:W},retainedWeb:[]};
  const entry=await createStableEntry({root:join(root,'entry'),instanceId:'instance',controlKey:'k'.repeat(32),stickyKey:'s'.repeat(32),verifyFence:async n=>assert.equal(n.fence,fence),initialBinding:initial});t.after(()=>entry.close());
  const old=new WebSocket(entry.origin.replace('http:','ws:')+'/ws');await new Promise((ok,fail)=>{old.onopen=ok;old.onerror=fail;});
  async function message(ws){const result=new Promise((ok,fail)=>{ws.onmessage=e=>ok(e.data);ws.onerror=fail;});ws.send('read');return result;}
  assert.equal(await message(old),'owner-a');fence=2;const headers={'x-platform-internal-key':'k'.repeat(32)};assert.equal((await fetch(entry.controlOrigin+'/fence',{method:'POST',headers,body:JSON.stringify({instanceId:'instance',attemptId:'initial',fence})})).status,200);assert.equal((await fetch(entry.controlOrigin+'/binding',{method:'POST',headers,body:JSON.stringify({...initial,fence,routeGeneration:2,weight:100})})).status,200);
  assert.equal(await message(old),'owner-a');const next=new WebSocket(entry.origin.replace('http:','ws:')+'/ws');await new Promise((ok,fail)=>{next.onopen=ok;next.onerror=fail;});assert.equal(await message(next),'owner-b');assert.deepEqual(entry.observe().wsByDigest,{[B]:1,[H]:1});old.close();next.close();
});

test('installer handoff candidate is a real scoped Node controller parked before authority, with physical code identity',async t=>{
  const root=await folder(t),f=fixture(),id='33333333-3333-4333-8333-333333333333',artifact=join(root,'artifacts',H.slice(7));await fs.mkdir(artifact,{recursive:true});await fs.cp(new URL('../upgrade/',import.meta.url),join(artifact,'installer'),{recursive:true,filter:path=>!path.endsWith('.test.mjs')});await fs.mkdir(join(artifact,'api'));await fs.mkdir(join(artifact,'web'));await fs.writeFile(join(artifact,'api/code.js'),'export const a=1');await fs.writeFile(join(artifact,'web/index.html'),'web');
  const files=await treeManifest(artifact);f.manifest.components.api.artifactDigest=digest(files.filter(x=>x.path.startsWith('api/')));f.manifest.components.coordinator.artifactDigest=f.manifest.components.api.artifactDigest;f.manifest.components.web.artifactDigest=digest(files.filter(x=>x.path.startsWith('web/')));f.manifest.components.installer.artifactDigest=digest(files.filter(x=>x.path.startsWith('installer/')));f.manifest.components.installer.inputFingerprint=f.manifest.components.installer.artifactDigest;
  await atomicJson(join(artifact,'upgrade-artifact.json'),{components:f.manifest.components,files,treeDigest:digest(files)});await atomicJson(join(artifact,'installed.json'),{packageDigest:H,components:f.manifest.components});await atomicJson(join(root,'journals',id+'.json'),{steps:{'installer-handoff':{operationId:'fixed-operation'}}});
  let requests=0;const endpoint=await listen(t,(_req,res)=>{requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({attempts:[]}));});const portReservation=http.createServer();await new Promise(ok=>portReservation.listen(0,'127.0.0.1',ok));const installerPort=portReservation.address().port;await new Promise(ok=>portReservation.close(ok));
  const installerConfig={root,instanceId:'instance',controllerId:'candidate',trustRootPath:join(root,'no-trust-needed-before-authority'),coordinatorOrigin:endpoint.origin,controllerKey:'c'.repeat(32),entryOrigin:endpoint.origin,entryKey:'e'.repeat(32),supervisorKey:'s'.repeat(32)};const coordinator={origin:endpoint.origin,assertFence:async()=>{},snapshot:async()=>({attempt:{instanceId:'instance',actorId:'user',requestId:'explicit-request'},plan:{package:f.manifest.packages[0],steps:[{stepId:'installer-handoff',kind:'installer-handoff'}]},manifest:f.manifest})};
  const supervisor=await createCandidateSupervisor({root,instanceId:'instance',key:'s'.repeat(32),coordinator,controlEnv:{PLATFORM_CONTROL_RPC_KEY:'k'.repeat(32)},installerConfig,installerPort});installerConfig.supervisorOrigin=supervisor.origin;t.after(async()=>{for(const child of supervisor.ownedProcesses())try{process.kill(child.pid,'SIGTERM');}catch{}await supervisor.close();});
  const candidate=await supervisor.start(id,7,'installer');let proof;const deadline=Date.now()+5000;while(Date.now()<deadline){proof=await supervisor.inspect(id,'installer');if(proof.qualified)break;await new Promise(ok=>setTimeout(ok,50));}assert.equal(proof.qualified,true);assert.equal(proof.identity.pid,candidate.pid);assert.equal(proof.identity.artifactDigest,f.manifest.components.installer.artifactDigest);assert.equal(proof.identity.programRoot,join(artifact,'installer'));assert.equal(requests,0);
  const config=JSON.parse(await fs.readFile(join(root,'processes',id+'-installer-config.json')));assert.equal(config.handoffMode,true);assert.ok(!Object.keys(config).some(k=>/ownerEnv|coordinatorEnv|database|boxlite|controlEnv/i.test(k)));
  const rejected=await fetch(supervisor.origin+'/start',{method:'POST',headers:{'x-platform-internal-key':'s'.repeat(32)},body:JSON.stringify({attemptId:id,fence:7,kind:'installer',env:{PLATFORM_COORDINATOR_RPC_KEY:'bad'}})});assert.equal(rejected.status,409);assert.equal(supervisor.ownedProcesses().length,1);
  await atomicJson(join(root,'controller-authority.json'),candidate);process.kill(candidate.pid,'SIGKILL');
  const exited=Date.now()+5000;while(Date.now()<exited){try{process.kill(candidate.pid,0);}catch(error){if(error.code==='ESRCH')break;throw error;}await new Promise(ok=>setTimeout(ok,20));}
  const restarted=await supervisor.restartCurrentInstaller();assert.notEqual(restarted.pid,candidate.pid);assert.equal(restarted.artifactDigest,candidate.artifactDigest);assert.equal(restarted.artifactRoot,candidate.artifactRoot);
  const restartDeadline=Date.now()+5000;while(Date.now()<restartDeadline){proof=await supervisor.inspect(id,'installer');if(proof.qualified)break;await new Promise(ok=>setTimeout(ok,30));}
  assert.equal(proof.qualified,true);assert.equal(proof.identity.pid,restarted.pid);assert.equal(proof.identity.programRoot,join(artifact,'installer'));assert.equal((await readJsonForTest(join(root,'controller-authority.json'))).pid,restarted.pid);
});

test('Coordinator private binding permits bounded handoff management on A and sends each business commit once to ready B',async t=>{
  const root=await folder(t),path=join(root,'coordinator-binding.json'),id='44444444-4444-4444-8444-444444444444',requests=[];
  const a=await listen(t,async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({role:'a',url:req.url,body});res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{commitKnown:true}}));}),b=await listen(t,async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({role:'b',url:req.url,body});res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{sequence:3}}));});
  await atomicJson(path,{instanceId:'instance',state:'quiescing',origin:a.origin,generation:1,artifactDigest:B,attemptId:id,fence:7});const client=createCoordinatorClient({origin:a.origin,instanceId:'instance',key:'k'.repeat(32),bindingPath:path});
  await client.assertFence(id,7);await client.coordinatorHandoff(id,{fence:7,operationId:'fixed-op',planDigest:H,action:'release'});assert.equal(requests.length,2);
  const pending=client.commit(id,{eventId:'fixed-event',expectedSequence:2,fence:7});await new Promise(ok=>setTimeout(ok,20));assert.equal(requests.length,2);await atomicJson(path,{instanceId:'instance',state:'ready',origin:b.origin,generation:2,artifactDigest:H});assert.equal((await pending).sequence,3);assert.equal(requests.length,3);assert.equal(requests[2].role,'b');assert.equal(JSON.parse(requests[2].body).eventId,'fixed-event');
  await atomicJson(path,{instanceId:'other',state:'ready',origin:a.origin,generation:3});await assert.rejects(client.commit(id,{eventId:'must-not-send'}),{code:'COORDINATOR_BINDING_UNKNOWN'});assert.equal(requests.length,3);
});

test('qualification fixture serves actual immutable HTTPS bytes with dedicated CA and honest not-run signatures',async t=>{
  const {createUpgradeFixture}=await import('../../e2e-contract/server/upgrade-fixture.mjs');
  const root=await folder(t),initial=join(root,'initial'),archives=join(root,'archives'),installation=join(root,'upgrade-installation');
  await fs.mkdir(initial,{mode:0o700});await fs.mkdir(archives,{mode:0o700});await fs.mkdir(join(initial,'api'));await fs.mkdir(join(initial,'web'));await fs.mkdir(join(initial,'installer'));
  await fs.writeFile(join(initial,'api/code.js'),'module.exports=1');await fs.writeFile(join(initial,'web/page.html'),'A');await fs.writeFile(join(initial,'installer/controller-main.mjs'),'export const qualifiedFixture=true');
  const files=await treeManifest(initial),f=fixture();
  for(const kind of ['api','coordinator'])f.manifest.components[kind].artifactDigest=digest(files.filter(row=>row.path.startsWith('api/')));
  f.manifest.components.web.artifactDigest=digest(files.filter(row=>row.path.startsWith('web/')));f.manifest.components.installer.artifactDigest=digest(files.filter(row=>row.path.startsWith('installer/')));
  await atomicJson(join(initial,'upgrade-artifact.json'),{schemaVersion:1,platform:process.platform,arch:process.arch,releaseId:'v1.0.0',components:f.manifest.components,files,treeDigest:digest(files)});
  const bytes=Buffer.alloc(32768,0x42);await fs.writeFile(join(archives,'instance.tgz'),bytes);Object.assign(f.manifest.packages[0],{digest:digest(bytes),bytes:bytes.length});
  const fixtureRun=await createUpgradeFixture({instanceId:'upgrade-acceptance-tls-'+Date.now(),isolated:true,root:installation,initialRoot:initial,archiveRoot:archives,initialRelease:{schema:1},targetManifest:f.manifest});t.after(()=>fixtureRun.close());
  const qualified=fixtureRun.envelope.manifest;assert.equal(qualified.purpose,'qualification');assert.ok(qualified.evidence.every(row=>row.result==='not-run'));assert.ok(qualified.policy.fallbacks.every(row=>row.rehearsed===false));assert.equal(runInputFingerprint(qualified),runInputFingerprint(f.manifest));
  await fs.writeFile(join(archives,'instance.tgz'),'source changed after qualification');
  const response=await fetch(qualified.packages[0].url,{headers:{Range:'bytes=1000-'}});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 1000-32767/32768');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(1000));
  const roots=await loadTrustRoot(fixtureRun.trustRootPath);assert.equal(roots.purpose,'qualification');assert.equal((await readJsonForTest(fixtureRun.installationProofPath)).trustRootDigest,digest(roots));
  assert.equal((await fs.stat(fixtureRun.configPath)).mode&0o777,0o600);assert.equal(fixtureRun.requestLog()[0].completed,true);assert.equal(fixtureRun.requestLog()[0].bytesSent,bytes.length-1000);
});
async function readJsonForTest(path){return JSON.parse(await fs.readFile(path,'utf8'));}

test('Supervisor publishes real verified archive through a private immutable copy and rejects symlink input',async t=>{
  const base=await folder(t),root=join(base,'installer'),publicationRoot=join(base,'private-publication'),source=join(base,'source'),f=fixture(),id='55555555-5555-4555-8555-555555555555';
  await fs.mkdir(source);for(const folder of ['api','web','installer'])await fs.mkdir(join(source,folder));
  await fs.writeFile(join(source,'api/code.js'),'module.exports=1');await fs.writeFile(join(source,'web/page.html'),'real archive');await fs.writeFile(join(source,'installer/controller-main.mjs'),'export const testOnly=true');
  const files=await treeManifest(source);for(const kind of ['api','coordinator'])f.manifest.components[kind].artifactDigest=digest(files.filter(row=>row.path.startsWith('api/')));
  f.manifest.components.web.artifactDigest=digest(files.filter(row=>row.path.startsWith('web/')));f.manifest.components.installer.artifactDigest=digest(files.filter(row=>row.path.startsWith('installer/')));
  await atomicJson(join(source,'upgrade-artifact.json'),{schemaVersion:1,platform:process.platform,arch:process.arch,components:f.manifest.components,treeDigest:digest(files),files});
  const archive=join(base,'archive.tgz');await command('tar',['-czf',archive,'-C',source,'.']);let pkg={...await fileDigest(archive),platform:process.platform,arch:process.arch,format:'native-tar'};let fences=0;
  const coordinator={assertFence:async()=>{fences++;},snapshot:async()=>({attempt:{instanceId:'instance',actorId:'explicit-user',requestId:'explicit-request'},plan:{package:pkg},manifest:f.manifest})};
  const supervisor=await createCandidateSupervisor({root,publicationRoot,instanceId:'instance',key:'s'.repeat(32),coordinator,controlEnv:{PLATFORM_CONTROL_RPC_KEY:'c'.repeat(32)}});t.after(()=>supervisor.close());
  const download=join(root,'downloads',pkg.digest.slice(7)+'.tgz');await fs.copyFile(archive,download);
  const publish=()=>fetch(supervisor.origin+'/publish',{method:'POST',headers:{'x-platform-internal-key':'s'.repeat(32)},body:JSON.stringify({attemptId:id,fence:7,kind:'installer'})});
  let result=await publish();assert.equal(result.status,200);const receipt=await result.json();assert.equal(receipt.packageDigest,pkg.digest);assert.equal(await fs.readFile(join(receipt.root,'web/page.html'),'utf8'),'real archive');
  const privateCopy=join(publicationRoot,pkg.digest.slice(7)+'.tgz');assert.equal((await fs.stat(privateCopy)).mode&0o777,0o400);assert.ok(fences>=5);
  await fs.writeFile(download,'caller mutated the staging input');result=await publish();assert.equal(result.status,200);assert.deepEqual(await fileDigest(privateCopy),{digest:pkg.digest,bytes:pkg.bytes});
  pkg={...pkg,digest:V};await fs.symlink(archive,join(root,'downloads',pkg.digest.slice(7)+'.tgz'));result=await publish();assert.equal(result.status,409);assert.equal(await fs.lstat(join(root,'artifacts',pkg.digest.slice(7))).catch(()=>null),null);assert.equal(await fs.lstat(join(publicationRoot,pkg.digest.slice(7)+'.tgz')).catch(()=>null),null);
});
