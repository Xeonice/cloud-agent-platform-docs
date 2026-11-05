import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { createMigrationCapacityHandoff, projectMigrationNormalCapacity, readMigrationDefaultOwner, verifyMigrationDefaultOwnerSource } from './control-migration-handoff.mjs';
import { createMigrationCapacity } from './control-migration-capacity.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { createSupervisorControlRuntime } from './supervisor-control-runtime.mjs';
import { createCandidateSupervisor } from './candidate-supervisor.mjs';
import { freezeCapacityBudget } from './capacity-admission.mjs';
import { capacityHostIdentity, capacityResidentIdentity } from './control-capacity-collector.mjs';
import { digest, DIGEST, signQualificationManifest, runInputFingerprint } from './trust.mjs';
import { atomicJson, treeManifest, fileDigest } from './io.mjs';

const Database=createRequire(new URL('../../api/package.json',import.meta.url))('better-sqlite3');
const MiB=1024**2, GiB=1024**3;
const vector=(cpu,memory=64*MiB,io=0)=>({cpuMilliCores:cpu,memoryBytes:memory,ioBytesPerSecond:io,disks:{data:0}});
const identity=n=>({artifactDigest:digest('artifact-'+n),inputFingerprint:digest('input-'+n)});

/** Actual SQLite journals/bookkeepers/collector/admission, with explicit physical
 * and monotonic counter ports. No Native, SDK, Guest, network or real admission. */
async function fixture(t,{cpu=12000,write}={}) {
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'migration-handoff-')));
  await fs.chmod(root,0o700);t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let now=Date.parse('2026-11-05T12:00:00Z'),mono=1000,tick=0;
  const instanceId='instance',migrationId='migration',configDigest=digest('frozen-migration-config'),
    deadline=now+120000,rollbackDeadline=now+240000;
  const row=(n,role,own=true)=>({containerId:n.toString(16).repeat(64),pid:100+n,birthTicks:'90'+n,cgroupDigest:digest('cgroup'+n),
    startedAt:new Date(now-10000).toISOString(),restartCount:0,instanceId:own?instanceId:null,role:own?role:null,
    startIdentity:own?role+'-original-identity':null,artifactDigest:own?digest('artifact-'+role):null});
  const original=[row(1,'foundation',false),row(2,'installer'),row(3,'coordinator'),row(4,'owner'),row(5,'web')];
  let containers=structuredClone(original);
  const physical=r=>({...r,hostPid:r.pid,role:r.role??'foundation',startIdentity:r.startIdentity??'original-foundation-code',
    artifactDigest:r.artifactDigest??digest('foundation'),imageDigest:digest('runtime-image'),running:true,paused:false,
    restartPolicy:'no',oomKilled:false,exitCode:0});
  const states=new Map(original.map(r=>[r.containerId,physical(r)]));
  const source={foundation:{...physical(original[0]),capacityAllocationId:'host-overhead'},
    installer:{...physical(original[1]),capacityAllocationId:'legacy-controller'},
    coordinator:{...physical(original[2]),capacityAllocationId:'legacy-coordinator'}};
  const caps={'api':vector(150,320*MiB),'coordinator':vector(350,640*MiB),
    'control-agent':vector(200,512*MiB),'control-supervisor':vector(500,320*MiB),'control-entry':vector(50,128*MiB)};
  const targetRows=Object.keys(caps).map((role,k)=>({...row(k+6,role),startIdentity:role+'-new-identity'}));
  const targets=Object.fromEntries(targetRows.map(r=>[r.role,{kind:r.role,resources:caps[r.role],capacityAllocationId:'migration-'+r.role,
    record:{startIdentity:r.startIdentity,artifactDigest:r.artifactDigest}}]));
  const sample=async()=>{
    now+=250;mono+=250;tick++;
    return {vmBootId:'00112233-4455-6677-8899-aabbccddeeff',procIdentity:{path:'/host/proc',dev:'1',ino:'1'},
      cpu:{cpus:12,total:tick*10000,idle:tick*10000},memory:{total:20*GiB,free:20*GiB-200*MiB,available:20*GiB-200*MiB},
      devices:[{id:'data',dev:'2049',majorMinor:'8:1',capacityBytes:100*GiB,freeBytes:90*GiB,availableBytes:90*GiB,readBytes:1,writeBytes:1}],
      containers:containers.map(r=>({...r,memoryBytes:10*MiB,cpuNs:1,ioBytes:1,monotonic:mono})),startedAt:now,finishedAt:now,monotonic:mono};
  };
  const config={schemaVersion:1,instanceId,sourceDigest:digest('original-source'),hostProcRoot:'/host/proc',dockerSocketPath:'/fixture.sock',
    devices:[{id:'data',path:root,dev:'2049',majorMinor:'8:1'}],residents:[{id:'legacy-controller',containers:[original[1]]},
      {id:'legacy-coordinator',containers:[original[2]]},{id:'retained-owner-runtime',containers:[original[3]]},
      {id:'source-other',containers:[original[4]]}],sampleIntervalMs:250,timeoutMs:2000,
    ioQualificationPath:join(root,'io.json'),observationPath:join(root,'native-observation.json'),ioEffectiveBudgetBytesPerSecond:64*MiB};
  const ioFacts={schemaVersion:1,kind:'control-io-qualification',instanceId,vmBootId:'00112233-4455-6677-8899-aabbccddeeff',
    devices:[{id:'data',dev:'2049',majorMinor:'8:1'}],effectiveBudgetBytesPerSecond:64*MiB,windowMs:60000,
    observedAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+600000).toISOString(),qualified:true,
    measurement:{readBytes:64*MiB*60,writeBytes:0,maxLatencyMs:1,samples:600,unexpectedErrors:0}};
  const qualification={...ioFacts,receiptDigest:digest(ioFacts)},ioRaw=JSON.stringify(qualification);
  config.ioQualificationRawDigest=digest(ioRaw);await fs.writeFile(config.ioQualificationPath,ioRaw,{mode:0o600});
  const resident=(id,resources)=>({id,resident:true,resources,identityDigest:capacityResidentIdentity(config.residents.find(r=>r.id===id).containers)}),
    pending=(id,resources)=>({id,resident:false,resources,identityDigest:digest(id)});
  const initial=freezeCapacityBudget({instanceId,sourceDigest:config.sourceDigest,maxObservationAgeMs:5000,
    limits:{...vector(cpu,20*GiB,64*MiB),disks:{data:100*GiB}},allocations:{
      source:[resident('legacy-controller',vector(250,128*MiB)),resident('legacy-coordinator',vector(500,640*MiB)),
        resident('source-other',vector(100,208*MiB)),{id:'host-overhead',resident:true,identityDigest:capacityHostIdentity(await sample(),instanceId),
          resources:{...vector(1900,GiB,0),disks:{data:10*GiB}}}],
      retainedOwners:[resident('retained-owner-runtime',vector(1500,GiB))],retainedGuests:[],existingCandidates:[],
      candidate:['api','coordinator'].map(k=>pending('migration-'+k,caps[k])),
      control:['control-agent','control-supervisor','control-entry'].map(k=>pending('migration-'+k,caps[k])),verification:[],
      recovery:[pending('recovery-reserve',vector(250)),pending('pending-original-8932', {...vector(2000,2*GiB),disks:{data:2403*MiB}})]}});
  const native={planPath:join(root,'native-plan.json'),configPath:join(root,'native-collector.json'),observationPath:config.observationPath};
  await atomicJson(native.planPath,initial);await atomicJson(native.configPath,config);await atomicJson(native.observationPath,{revision:0});
  const db=new Database(join(root,'migration.db'));t.after(()=>db.close());
  const journal=createControlCommandJournal({sqlite:db,instanceId,clock:()=>now,assertAuthority:()=>{}}),authority={executorId:'migration',epoch:1,expiresAt:rollbackDeadline};
  const actions=[...Object.entries(source).map(([role,target])=>({commandId:migrationId+':'+(role==='coordinator'?'stop-writer':'stop-'+role),
    direction:'stop',role,target,targetDigest:digest(target),allocationId:target.capacityAllocationId,deadline})),
    ...Object.entries(targets).map(([role,target])=>({commandId:migrationId+':start-'+role,direction:'start',role,
      targetDigest:digest(target),allocationId:target.capacityAllocationId,deadline}))];
  const capacity=createMigrationCapacity({sqlite:db,journal,instanceId,migrationId,initialPlanDigest:initial.planDigest,...native,
    deadline:rollbackDeadline,actions,inspect:async r=>states.get(r.containerId),sample,clock:()=>now});
  await capacity.initialize();
  const normal={root:join(root,'normal'),planPath:join(root,'normal/plan.json'),configPath:join(root,'normal/collector.json'),
    observationPath:join(root,'normal/observation.json'),transitionRoot:join(root,'normal/transitions'),templates:{owner:{allocationId:'future-owner-template',resources:{...vector(2500,3*GiB),disks:{data:20*GiB}}}}};
  const context={instanceId,manifestDigest:digest('signed-target'),sourceComponents:{web:identity('web'),owner:identity('owner')},
    targetComponents:{api:identity('api'),coordinator:identity('coordinator'),installer:identity('new-installer'),web:identity('web'),owner:identity('new-owner')},
    installedComponents:{api:identity('api'),coordinator:identity('coordinator'),installer:identity('new-installer')},
    web:identity('web'),owner:identity('owner'),webBinding:{root:'/explicit-fixture/web'},defaultOwner:{ownerId:'retained-owner'}};
  let actualContext=structuredClone(context),writes=[];
  const create=()=>createMigrationCapacityHandoff({sqlite:db,Database,journal,instanceId,migrationId,configDigest,deadline,rollbackDeadline,native,normal,source,targets,
    capacityStatus:()=>capacity.status(),readRepairContext:async stage=>structuredClone(stage==='actual'?actualContext:context),
    inspect:async r=>states.get(r.containerId),sample,clock:()=>now,monotonic:()=>{mono+=250;return mono;},
    write:async(p,v)=>{writes.push(p);if(write)await write(p,v);else await atomicJson(p,v);}});
  let handoff=create();
  async function migrate() {
    for(const a of actions){
      let result;
      if(a.direction==='stop'){
        const r=states.get(a.target.containerId);result={...r,running:false,hostPid:0};states.set(r.containerId,result);containers=containers.filter(x=>x.containerId!==r.containerId);
      }else{
        const r=targetRows.find(x=>x.role===a.role);result=physical(r);states.set(r.containerId,result);containers.push(r);
      }
      const cmd={operationId:migrationId,commandId:a.commandId,stepId:a.commandId,authorization:authority,
        spec:{kind:'migration-'+a.commandId.split(':')[1],configDigest,targetDigest:a.targetDigest,deadline,budget:{maxDurationMs:120000}}};
      journal.prepare(cmd);journal.begin(cmd);journal.record({...cmd,state:'applied',result});await capacity.register(cmd);
    }
    await fs.mkdir(normal.transitionRoot,{recursive:true,mode:0o700});
    const pub=new Database(join(normal.transitionRoot,'capacity-publication.db'));pub.exec('CREATE TABLE publication_mutex(singleton INTEGER PRIMARY KEY CHECK(singleton=1))');pub.close();await fs.chmod(join(normal.transitionRoot,'capacity-publication.db'),0o600);
  }
  async function readiness(){
    const supDb=new Database(join(root,'supervisor.db'));
    const runtime=await createSupervisorControlRuntime({instanceId,config:{capacityPlanPath:normal.planPath,capacityCollectorConfigPath:normal.configPath,
      resourceObservationPath:normal.observationPath,capacityTransitionRoot:normal.transitionRoot},supervisor:{assembly:{sqlite:supDb},journal},Database,
      sample,clock:()=>now,monotonic:()=>{mono+=250;return mono;}});
    try{return {...await runtime.capacityReadiness(),supervisorStartIdentity:targets['control-supervisor'].record.startIdentity};}
    finally{await runtime.close();supDb.close();}
  }
  return {root,db,journal,capacity,native,normal,initial,context,targets,source,writes,migrate,readiness,
    get handoff(){return handoff;},reopen(){handoff=create();},mutateContext(fn){fn(actualContext);}};
}

test('missing normal Owner headroom refuses before any source stop and leaves original Native files and Guest reservations unchanged',async t=>{
  const f=await fixture(t,{cpu:7750}),before=await Promise.all([f.native.planPath,f.native.configPath].map(p=>fs.readFile(p)));
  await assert.rejects(f.handoff.preflight(),/CAPACITY_BUDGET_INSUFFICIENT/);
  assert.equal(f.journal.pending().length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM control_commands').get().n,0);
  assert.equal(f.capacity.status().sequence,0);
  const after=await Promise.all([f.native.planPath,f.native.configPath].map(p=>fs.readFile(p)));assert.deepEqual(after,before);
  assert.equal(f.capacity.status().peak.allocations.recovery.find(x=>x.id==='pending-original-8932').resources.memoryBytes,2*GiB);
  await assert.rejects(fs.stat(f.normal.configPath),{code:'ENOENT'});
});

test('real journals and capacity transitions seed normal facts, preserve every old amount, and require a fresh Supervisor consumer before activation',async t=>{
  const f=await fixture(t);const pre=await f.handoff.preflight();assert.deepEqual(pre.requiredRoles,['owner']);assert.equal(pre.projected,true);
  await f.migrate();const original=await fs.readFile(f.native.planPath),proof=await f.handoff.publish();
  assert.equal(proof.requiredRoles[0],'owner');assert.equal(f.writes.at(-1),f.normal.configPath);
  const normal=JSON.parse(await fs.readFile(f.normal.planPath));
  for(const [category,rows]of Object.entries(f.initial.allocations))for(const row of rows){
    const actual=normal.allocations[category].find(x=>x.id===row.id);assert(actual);assert.deepEqual(actual.resources,row.resources);
  }
  assert.equal(normal.allocations.candidate.find(x=>x.id==='future-owner-template').resources.memoryBytes,3*GiB);
  assert.deepEqual(await fs.readFile(f.native.planPath),original);
  await assert.rejects(f.handoff.assertReady(async()=>({qualified:true})),/SUPERVISOR_NOT_READY/);
  const ready=await f.handoff.assertReady(f.readiness);assert.equal(ready.supervisor.qualified,true);
});

test('an interrupted pending publication resumes only the same plan/config intent and never replaces conflicting state',async t=>{
  let once=true;const f=await fixture(t,{write:async(p,v)=>{if(p.endsWith('/collector.json')&&once){once=false;throw Error('explicit interrupted collector publication');}await atomicJson(p,v);}});
  await f.handoff.preflight();await f.migrate();await assert.rejects(f.handoff.publish(),/interrupted/);
  await assert.rejects(fs.stat(f.normal.configPath),{code:'ENOENT'});const intent=f.handoff.status().intent;
  f.reopen();await f.handoff.publish();assert.equal(f.handoff.status().intent.intentDigest,intent.intentDigest);
  await atomicJson(f.normal.configPath,{foreign:true});await assert.rejects(f.handoff.publish(),/PUBLICATION_CONFLICT/);
});

test('changed actual Owner/FP, missing receipt, foreign normal files and wrong/stale Supervisor facts stay closed',async t=>{
  const f=await fixture(t);await f.handoff.preflight();await f.migrate();
  f.mutateContext(c=>{c.owner.inputFingerprint=digest('other-owner-input')});await assert.rejects(f.handoff.publish(),/ACTUAL_REPAIR_CHANGED/);
  f.mutateContext(c=>{c.owner.inputFingerprint=f.context.owner.inputFingerprint});
  await atomicJson(f.normal.planPath,{foreign:true});await assert.rejects(f.handoff.publish(),/ALREADY_EXISTS/);await fs.unlink(f.normal.planPath);
  await f.handoff.publish();const good=await f.readiness();
  for(const patch of [{qualified:false},{planDigest:digest('other')},{configDigest:digest('other')},{sourceDigest:digest('other')},
    {supervisorStartIdentity:'foreign-supervisor'},{observedAt:'2000-01-01T00:00:00Z'}])
    await assert.rejects(f.handoff.assertReady(async()=>({...good,...patch})),/SUPERVISOR_NOT_READY/);
});

test('repair planning compares input fingerprints and refuses occupied/changed template slots',async t=>{
  const f=await fixture(t),args={plan:f.initial,templates:f.normal.templates,context:structuredClone(f.context),instanceId:'instance',migrationId:'migration'};
  args.context.owner={...args.context.targetComponents.owner,inputFingerprint:digest('wrong-input')};
  assert.throws(()=>projectMigrationNormalCapacity(args),/PROVENANCE_UNKNOWN/);
  args.context.owner=structuredClone(f.context.owner);args.templates={owner:{...f.normal.templates.owner,allocationId:'retained-owner-runtime'}};
  assert.throws(()=>projectMigrationNormalCapacity(args),/TEMPLATE_CONFLICT/);
});

test('a foreign observation inserted after durable intent is preserved rather than overwritten on resume',async t=>{
  let inserted=false;
  const f=await fixture(t,{write:async(p,v)=>{await atomicJson(p,v);if(p.endsWith('/normal/plan.json')&&!inserted){
    inserted=true;await atomicJson(p.replace('/plan.json','/observation.json'),{instanceId:'foreign',revision:77});
  }}});
  await f.handoff.preflight();await f.migrate();await assert.rejects(f.handoff.publish(),/OBSERVATION_CONFLICT/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.normal.observationPath)),{instanceId:'foreign',revision:77});
  f.reopen();await assert.rejects(f.handoff.publish(),/OBSERVATION_CONFLICT/);
  await assert.rejects(fs.stat(f.normal.configPath),{code:'ENOENT'});
});

test('an applied physical start without its original capacity receipt cannot publish normal state',async t=>{
  const f=await fixture(t);await f.handoff.preflight();await f.migrate();
  f.db.prepare('DELETE FROM control_migration_capacity_receipts WHERE command_id=?').run('migration:start-control-supervisor');
  await assert.rejects(f.handoff.publish(),/CAPACITY_RECEIPT_MISSING/);
  await assert.rejects(fs.stat(f.normal.configPath),{code:'ENOENT'});
});

test('default Owner follows the actual binding over fallback env and rejects wrong metadata or mid-read replacement',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'migration-default-owner-')));await fs.chmod(root,0o700);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));const path=join(root,'owners.json'),
    binding={instanceId:'instance',activeOwnerId:'current',owners:[{ownerId:'current',endpoint:'http://127.0.0.1:12345'}]},
    env={PLATFORM_RUNTIME_OWNER_BINDING_PATH:path,RUNTIME_OWNER_RPC_URL:'http://127.0.0.1:54321',PLATFORM_COORDINATOR_RPC_KEY:'explicit-fixture-key-only'.repeat(2)};
  await atomicJson(path,binding);let selected;
  const owner={instanceId:'instance',ownerId:'current',startIdentity:'actual-public-owner-start',...identity('owner')};
  const result=await readMigrationDefaultOwner({env,instanceId:'instance',rpcFactory:args=>{selected=args.origin;return async()=>owner;}});
  assert.equal(selected,binding.owners[0].endpoint);assert.equal(result.owner.ownerId,'current');assert(result.bindingRawDigest);
  await assert.rejects(readMigrationDefaultOwner({env,instanceId:'instance',rpcFactory:()=>async()=>({...owner,ownerId:'fallback'})}),/DEFAULT_OWNER_CHANGED/);
  await assert.rejects(readMigrationDefaultOwner({env,instanceId:'instance',rpcFactory:()=>async()=>{await atomicJson(path,{...binding,activeOwnerId:'other'});return owner;}}),/BINDING_CHANGED/);
});

test('real readiness HTTP accepts only the Supervisor key and instance, never business observer authority or a cached success',async t=>{
  const f=await fixture(t);await f.handoff.preflight();await f.migrate();await f.handoff.publish();
  const key='s'.repeat(32),observer='b'.repeat(32),stable={origin:'http://127.0.0.1:1',key:'a'.repeat(32),accessKey:'z'.repeat(32),
    agentStartIdentity:'original-agent-public-start-identity',
    statePath:join(f.root,'http-supervisor.db'),controlDbPath:join(f.root,'explicit-nonexistent-control.db'),
    capacityPlanPath:f.normal.planPath,capacityCollectorConfigPath:f.normal.configPath,resourceObservationPath:f.normal.observationPath,
    capacityTransitionRoot:f.normal.transitionRoot,referenceStatePath:join(f.root,'references.json')};
  await atomicJson(stable.referenceStatePath,{instanceId:'instance',candidates:[]});
  const sup=await createCandidateSupervisor({root:join(f.root,'installer'),instanceId:'instance',key,businessObserverKey:observer,
    coordinator:{origin:'http://127.0.0.1:1'},controlEnv:{PLATFORM_CONTROL_RPC_KEY:'x'.repeat(32)},stableControl:stable,Database,
    launchAdapter:{inspect:async()=>{throw Error('no lifecycle in readiness test');}}});
  t.after(()=>sup.close());
  for(const [auth,instance]of [[observer,'instance'],[stable.key,'instance'],[key,'wrong']]){
    const response=await fetch(sup.origin+'/capacity-readiness',{headers:{'x-platform-internal-key':auth,'x-platform-instance-id':instance}});
    assert.equal(response.status,403);
  }
  const response=await fetch(sup.origin+'/capacity-readiness',{headers:{'x-platform-internal-key':key,'x-platform-instance-id':'instance'}});
  assert.equal(response.status,200);const value=await response.json();
  // This test has no real Linux/Docker sampling endpoint. The actual collector
  // must report unknown, even though the seed previously qualified.
  assert.equal(value.qualified,false);assert.equal(value.instanceId,'instance');
  assert(value.revision>1);assert(DIGEST.test(value.planDigest));
});

test('selected historical Owner requires real signed complete installed tree and protected birth, while charging a separate full replacement',async t=>{
  const f=await fixture(t),installerRoot=join(f.root,'historical-installer'),packageDigest=digest('fixture-historical-tar'),
    artifactRoot=join(installerRoot,'artifacts',packageDigest.slice(7)),recordPath=join(installerRoot,'processes/old-owner.json');
  await fs.mkdir(join(installerRoot,'processes'),{recursive:true,mode:0o700});
  for(const path of ['api/code.js','web/server.js','installer/controller-main.mjs']){
    await fs.mkdir(join(artifactRoot,path.split('/')[0]),{recursive:true,mode:0o700});
    await fs.writeFile(join(artifactRoot,path),'export const historical = true;\n',{mode:0o600});
  }
  await fs.symlink('code.js',join(artifactRoot,'api/inside-link'));
  const files=await treeManifest(artifactRoot),part=role=>({artifactDigest:digest(files.filter(p=>p.path.startsWith((role==='owner'||role==='coordinator'?'api':role)+'/'))),
    inputFingerprint:digest('historical-input-'+(role==='owner'?'api':role)),sourceRevision:'a'.repeat(40),protocol:{min:1,max:1}}),
    components=Object.fromEntries(['api','web','installer','coordinator','owner'].map(role=>[role,part(role)]));
  components.web.webRevision='b'.repeat(40);
  const pkg={platform:'linux',arch:'arm64',name:'historical.tgz',url:'https://distribution.invalid/historical.tgz',digest:packageDigest,bytes:1000,
    format:'native-tar',unpackedBytes:files.reduce((n,p)=>n+(p.bytes||0),0)};
  const manifest={schemaVersion:2,purpose:'qualification',qualification:{instanceId:'instance',inputFingerprint:digest('pending')},
    releaseId:'v1.0.1',channel:'historical-fixture',publishedAt:new Date().toISOString(),commits:{project:'a'.repeat(40),api:'b'.repeat(40),web:'c'.repeat(40)},
    components,packages:[pkg],upgradePaths:[{fromRelease:'v1.0.0',minSchema:29,maxSchema:29,targetSchema:29,bridgeReleases:[],migrationPlanDigest:null}],
    policy:{id:'fixture',weights:[1,5,25,100],stageDurationMs:60000,minRequests:100,observationFreshnessMs:5000,probeHz:10,requestDeadlineMs:2000,
      attachDeadlineMs:5000,softErrorDelta:0.01,p95Ratio:2,p95FloorMs:1000,evaluationIntervalMs:10000,consecutiveEvaluations:2,retentionMs:60000,
      migrationBatchMs:500,maxWalBytes:1000,minFreeBytes:1000,fallbacks:[{releaseId:'v1.0.0',apiDigest:digest('old'),webDigest:digest('web'),rehearsed:false}],
      stopUserResources:false,restoreLiveVolume:false,contractInUpgrade:false},evidence:[]};
  manifest.qualification.inputFingerprint=runInputFingerprint(manifest);
  const keys=generateKeyPairSync('ed25519'),envelope=signQualificationManifest(manifest,'fixture',keys.privateKey.export({format:'pem',type:'pkcs8'})),
    trustRootPath=join(f.root,'historical-trust.json');
  await atomicJson(trustRootPath,{schemaVersion:1,purpose:'qualification',qualificationInstanceId:'instance',channel:manifest.channel,
    distributionOrigins:['https://distribution.invalid'],keys:[{id:'fixture',publicKey:keys.publicKey.export({format:'pem',type:'spki'})}]});
  await atomicJson(join(artifactRoot,'upgrade-artifact.json'),{schemaVersion:1,releaseId:manifest.releaseId,platform:pkg.platform,arch:pkg.arch,
    components,files,treeDigest:digest(files)});
  await atomicJson(join(artifactRoot,'installed.json'),{packageDigest,treeDigest:digest(files),components});
  const bindingRawDigest=digest('actual-current-binding'),owner={instanceId:'instance',ownerId:'historical-selected',startIdentity:'old-owner-birth',...components.owner},
    origin='http://127.0.0.1:40123',r={kind:'owner',instanceId:'instance',ownerId:owner.ownerId,startIdentity:owner.startIdentity,artifactRoot,
      ...components.owner,containerId:'f'.repeat(64),startedAt:new Date().toISOString(),origin};
  await atomicJson(recordPath,r);
  const s={kind:'actual-readonly-selected-default-owner-signed-historical-source',instanceId:'instance',activeOwnerId:owner.ownerId,bindingRawDigest,
    artifactRoot,matches:[{envelope,package:pkg}],markers:Object.fromEntries(await Promise.all(['installed.json','upgrade-artifact.json'].map(async name=>[name,{rawDigest:(await fileDigest(join(artifactRoot,name))).digest}])))};
  const sourcePath=join(f.root,'owner-signed-source.json');await atomicJson(sourcePath,s);
  const reference={sourceRef:{path:sourcePath,rawDigest:(await fileDigest(sourcePath)).digest},recordRef:{path:recordPath,rawDigest:(await fileDigest(recordPath)).digest}},
    protectedOwner={...r,role:'owner',artifactDigest:null,hostPid:123,birthTicks:'12345',cgroupDigest:digest('owner-kernel-cgroup'),
      imageDigest:digest('runtime-image'),running:true,paused:false,restartCount:0,restartPolicy:'no',oomKilled:false},
    args={reference,trustRootPath,installerRoot,instanceId:'instance',owner,bindingRawDigest,origin,protectedOwners:[protectedOwner],inspect:async()=>protectedOwner};
  const ownerSource=await verifyMigrationDefaultOwnerSource(args),context={...f.context,owner:{artifactDigest:owner.artifactDigest,inputFingerprint:owner.inputFingerprint},ownerSource,
    defaultOwner:{ownerId:owner.ownerId,startIdentity:owner.startIdentity,bindingRawDigest}};
  assert.notDeepEqual(context.owner,f.context.sourceComponents.owner);assert.notDeepEqual(context.owner,f.context.targetComponents.owner);
  const next=projectMigrationNormalCapacity({plan:f.initial,templates:f.normal.templates,context,instanceId:'instance',migrationId:'migration'});
  assert.deepEqual(next.requiredRoles,['owner']);assert.equal(next.slots[0].resources.cpuMilliCores,2500);assert.equal(next.slots[0].resources.memoryBytes,3*GiB);
  assert.throws(()=>projectMigrationNormalCapacity({plan:f.initial,templates:f.normal.templates,context:{...context,ownerSource:structuredClone(ownerSource)},instanceId:'instance',migrationId:'migration'}),/PROVENANCE_UNKNOWN/);
  await assert.rejects(verifyMigrationDefaultOwnerSource({...args,owner:{...owner,inputFingerprint:digest('forged-input')}}),/SOURCE_IDENTITY_CHANGED/);
  await assert.rejects(verifyMigrationDefaultOwnerSource({...args,inspect:async()=>({...protectedOwner,hostPid:124})}),/PROTECTED_BIRTH_CHANGED/);
  await assert.rejects(verifyMigrationDefaultOwnerSource({...args,inspect:async()=>({...protectedOwner,birthTicks:'12346'})}),/PROTECTED_BIRTH_CHANGED/);
  await assert.rejects(verifyMigrationDefaultOwnerSource({...args,inspect:async()=>({...protectedOwner,cgroupDigest:digest('other-owner-cgroup')})}),/PROTECTED_BIRTH_CHANGED/);
  await assert.rejects(verifyMigrationDefaultOwnerSource({...args,inspect:async()=>({...protectedOwner,artifactDigest:owner.artifactDigest})}),/PROTECTED_BIRTH_CHANGED/);
  const bad=structuredClone(s);bad.matches[0].envelope.signature.value='AAAA';await atomicJson(sourcePath,bad);
  await assert.rejects(verifyMigrationDefaultOwnerSource({...args,reference:{...reference,sourceRef:{path:sourcePath,rawDigest:(await fileDigest(sourcePath)).digest}}}),/SIGNATURE_OR_MANIFEST_DIGEST_INVALID/);
  await atomicJson(sourcePath,s);await fs.writeFile(join(artifactRoot,'api/code.js'),'tampered\n',{mode:0o600});
  await assert.rejects(verifyMigrationDefaultOwnerSource(args),/INSTALLED_TREE_CHANGED/);
});
