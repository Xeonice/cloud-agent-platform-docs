import * as fs from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { atomicJson, inside, secureDirectory, treeManifest } from './io.mjs';
import { canonical, digest, invariant, DIGEST, loadTrustRoot, verifySignedManifest, runInputFingerprint } from './trust.mjs';
import { readSupervisorFact } from './supervisor-control.mjs';
import { freezeCapacityBudget, evaluateCapacityAdmission } from './capacity-admission.mjs';
import { createControlCapacityCollector, sampleLinuxCapacity } from './control-capacity-collector.mjs';
import { createPrivateControlRpc } from './control-rpc.mjs';

const same = (a, b) => canonical(a) === canonical(b);
const component = value => value && DIGEST.test(value.artifactDigest) && DIGEST.test(value.inputFingerprint);
const componentSame = (a,b) => component(a) && component(b) && a.artifactDigest===b.artifactDigest && a.inputFingerprint===b.inputFingerprint;
const vector = plan => ({ limits: plan.limits, allocations: Object.fromEntries(Object.entries(plan.allocations).map(([k, rows]) => [k, rows.map(({id, resources}) => ({id, resources}))])) });
const physical = (a, b) => ['containerId','startIdentity','artifactDigest','startedAt','hostPid','role','imageDigest'].every(k => a[k] === b[k]);
const fact = async path => readSupervisorFact(path, 1048576);
const optional = async path => fact(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const verifiedOwnerSources = new WeakSet();

/** Same binding precedence as the business Owner factory, without importing the
 * API/SDK or opening any business database. Keys are only passed to the RPC. */
export async function readMigrationDefaultOwner({env,instanceId,rpcFactory=createPrivateControlRpc}) {
  const path=env.PLATFORM_RUNTIME_OWNER_BINDING_PATH,before=path?await fact(path):null,
    binding=before?.value;
  if(binding) invariant(binding.instanceId===instanceId && typeof binding.activeOwnerId==='string' &&
    Array.isArray(binding.owners) && binding.owners.length>0 && binding.owners.length<=128 &&
    new Set(binding.owners.map(o=>o.ownerId)).size===binding.owners.length,
  'MIGRATION_NORMAL_OWNER_BINDING_INVALID');
  const route=binding?.owners.find(o=>o.ownerId===binding.activeOwnerId);
  invariant(!binding || route && typeof route.endpoint==='string','MIGRATION_NORMAL_OWNER_BINDING_INVALID');
  const rpc=rpcFactory({origin:route?.endpoint??env.RUNTIME_OWNER_RPC_URL,instanceId,key:env.PLATFORM_COORDINATOR_RPC_KEY}),
    owner=await rpc('/runtime/metadata');
  invariant(owner.instanceId===instanceId && typeof owner.ownerId==='string' && typeof owner.startIdentity==='string' &&
    (!route || owner.ownerId===route.ownerId),'MIGRATION_NORMAL_DEFAULT_OWNER_CHANGED');
  if(before) invariant((await fact(path)).digest===before.digest,'MIGRATION_NORMAL_OWNER_BINDING_CHANGED');
  return {owner,bindingRawDigest:before?.digest??null,origin:route?.endpoint??env.RUNTIME_OWNER_RPC_URL};
}

/** A selected historical Owner may legitimately differ from both confirmed and
 * target. Its original signed package, process record and complete installed
 * tree are evidence; a historical Owner name or unsigned marker is not. */
export async function verifyMigrationDefaultOwnerSource({reference,trustRootPath,installerRoot,
  instanceId,owner,bindingRawDigest,origin,protectedOwners,inspect,clock=Date.now}) {
  invariant(reference?.sourceRef && reference.recordRef && DIGEST.test(bindingRawDigest) &&
    isAbsolute(installerRoot) && dirname(reference.recordRef.path)===join(installerRoot,'processes') &&
    typeof inspect==='function','MIGRATION_NORMAL_OWNER_SOURCE_REQUIRED');
  const readRef=async ref=>{invariant(isAbsolute(ref.path)&&DIGEST.test(ref.rawDigest),'MIGRATION_NORMAL_OWNER_SOURCE_REF_INVALID');
    const got=await fact(ref.path);invariant(got.digest===ref.rawDigest,'MIGRATION_NORMAL_OWNER_SOURCE_CHANGED');return got;};
  const source=await readRef(reference.sourceRef),record=await readRef(reference.recordRef),s=source.value,r=record.value;
  invariant(s.kind==='actual-readonly-selected-default-owner-signed-historical-source' &&
    s.instanceId===instanceId && s.activeOwnerId===owner.ownerId && s.bindingRawDigest===bindingRawDigest &&
    Array.isArray(s.matches)&&s.matches.length===1 && r.instanceId===instanceId && r.kind==='owner' &&
    r.ownerId===owner.ownerId && r.startIdentity===owner.startIdentity && r.origin===origin && componentSame(r,owner),
  'MIGRATION_NORMAL_OWNER_SOURCE_IDENTITY_CHANGED');
  const roots=await loadTrustRoot(trustRootPath),verified=verifySignedManifest(s.matches[0].envelope,roots,clock()),
    manifest=verified.manifest,pkg=s.matches[0].package,part=manifest.components.owner;
  invariant((verified.purpose!=='qualification' || roots.qualificationInstanceId===instanceId &&
    manifest.qualification?.instanceId===instanceId && manifest.qualification.inputFingerprint===runInputFingerprint(manifest)) &&
    componentSame(part,owner) && manifest.packages.some(p=>same(p,pkg)) &&
    s.artifactRoot===join(installerRoot,'artifacts',pkg.digest.slice(7)) && r.artifactRoot===s.artifactRoot &&
    resolve(s.artifactRoot)===s.artifactRoot && await fs.realpath(s.artifactRoot)===s.artifactRoot,
  'MIGRATION_NORMAL_OWNER_SIGNED_SOURCE_CHANGED');
  // A legacy Docker artifact label may be null. Preserve that physical label;
  // the separately verified signed component is not a replacement label.
  const matches=protectedOwners.filter(p=>p.startIdentity===owner.startIdentity && p.containerId===r.containerId &&
    p.startedAt===r.startedAt && p.role==='owner');
  invariant(matches.length===1,'MIGRATION_NORMAL_OWNER_PROTECTED_BIRTH_UNKNOWN');const expected=matches[0];
  invariant(/^\d+$/.test(expected.birthTicks??'') && DIGEST.test(expected.cgroupDigest),
    'MIGRATION_NORMAL_OWNER_KERNEL_BIRTH_UNKNOWN');
  const checkBirth=async()=>{const p=await inspect(expected);invariant(physical(p,expected) && p.running===true &&
    p.hostPid===expected.hostPid && p.paused===false && p.restartPolicy==='no' && p.restartCount===expected.restartCount &&
    p.oomKilled===false && p.birthTicks===expected.birthTicks && p.cgroupDigest===expected.cgroupDigest,
  'MIGRATION_NORMAL_OWNER_PROTECTED_BIRTH_CHANGED');};
  await checkBirth();
  const marker=await readSupervisorFact(join(s.artifactRoot,'installed.json'),1048576),
    bundle=await readSupervisorFact(join(s.artifactRoot,'upgrade-artifact.json'),16*1048576),
    files=(await treeManifest(s.artifactRoot)).filter(f=>!['installed.json','upgrade-artifact.json'].includes(f.path));
  invariant(marker.digest===s.markers?.['installed.json']?.rawDigest && bundle.digest===s.markers?.['upgrade-artifact.json']?.rawDigest &&
    marker.value.packageDigest===pkg.digest && marker.value.treeDigest===bundle.value.treeDigest &&
    same(marker.value.components,manifest.components) && same(bundle.value.components,manifest.components) &&
    bundle.value.releaseId===manifest.releaseId && bundle.value.platform===pkg.platform && bundle.value.arch===pkg.arch &&
    same(files,bundle.value.files) && digest(files)===bundle.value.treeDigest &&
    ['api','web','installer'].every(role=>digest(files.filter(f=>f.path.startsWith(role+'/')))===manifest.components[role].artifactDigest) &&
    digest(files.filter(f=>f.path.startsWith('api/')))===part.artifactDigest &&
    (pkg.unpackedBytes===undefined || files.reduce((n,f)=>n+(f.bytes||0),0)===pkg.unpackedBytes),
  'MIGRATION_NORMAL_OWNER_INSTALLED_TREE_CHANGED');
  await checkBirth();
  for(const ref of [reference.sourceRef,reference.recordRef])await readRef(ref);
  invariant((await fact(join(s.artifactRoot,'installed.json'))).digest===marker.digest &&
    (await readSupervisorFact(join(s.artifactRoot,'upgrade-artifact.json'),16*1048576)).digest===bundle.digest,
  'MIGRATION_NORMAL_OWNER_SOURCE_CHANGED');
  const proof={kind:'verified-selected-historical-owner-installed-source',instanceId,ownerId:owner.ownerId,
    startIdentity:owner.startIdentity,bindingRawDigest,component:{artifactDigest:part.artifactDigest,inputFingerprint:part.inputFingerprint},
    artifactRoot:s.artifactRoot,manifestDigest:verified.manifestDigest,packageDigest:pkg.digest,treeDigest:bundle.value.treeDigest,
    sourceRawDigest:source.digest,recordRawDigest:record.digest};verifiedOwnerSources.add(proof);return proof;
}

/** A projection is explicitly not a measured sourceActual or a confirmation.
 * API/Coordinator/installer will use the verified target; Web/default Owner keep
 * the identities actually selected by the installation. Both digest and input
 * fingerprint participate in the ordinary product's reuse decision. */
export function projectMigrationNormalCapacity({ plan, templates, context, instanceId, migrationId }) {
  invariant(context?.instanceId === instanceId && DIGEST.test(context.manifestDigest) &&
    context.sourceComponents && context.targetComponents && context.installedComponents && context.web && context.owner,
  'MIGRATION_NORMAL_REPAIR_CONTEXT_UNKNOWN');
  const projected = {};
  for (const role of ['api','coordinator','installer','web','owner']) {
    const target = context.targetComponents[role];
    if (role === 'owner' && !target) continue;
    invariant(component(target), 'MIGRATION_NORMAL_COMPONENT_UNKNOWN');
    const current = ['web','owner'].includes(role) ? context[role] : context.installedComponents[role];
    invariant(component(current), 'MIGRATION_NORMAL_COMPONENT_UNKNOWN');
    if(!['web','owner'].includes(role)) invariant(componentSame(current,target),'MIGRATION_NORMAL_INSTALLED_COMPONENT_CHANGED');
    if (['web','owner'].includes(role)) invariant(
      [context.sourceComponents[role], target].some(c => componentSame(c, current)) || role==='owner' &&
        verifiedOwnerSources.has(context.ownerSource) && context.ownerSource.instanceId===instanceId &&
        context.ownerSource.ownerId===context.defaultOwner?.ownerId && context.ownerSource.startIdentity===context.defaultOwner?.startIdentity &&
        context.ownerSource.bindingRawDigest===context.defaultOwner?.bindingRawDigest && componentSame(context.ownerSource.component,current),
      'MIGRATION_NORMAL_COMPONENT_PROVENANCE_UNKNOWN');
    projected[role] = current;
  }
  const roles = ['api','coordinator','owner','web'].filter(role => projected[role] &&
    !componentSame(projected[role], context.targetComponents[role])).sort();
  const next = structuredClone(plan), slots = [];
  for (const role of roles) {
    const t = templates[role];
    invariant(t && typeof t.allocationId === 'string' && t.resources,
      'MIGRATION_NORMAL_TEMPLATE_REQUIRED');
    const old = Object.entries(next.allocations).flatMap(([category, rows]) => rows.filter(r => r.id === t.allocationId).map(row => ({category, row})));
    invariant(old.length===0,'MIGRATION_NORMAL_TEMPLATE_CONFLICT');
    next.allocations.candidate.push({id:t.allocationId, resident:false,
      identityDigest:digest({instanceId,migrationId,role,kind:'normal-installation-template'}),resources:structuredClone(t.resources)});
    slots.push({role,id:t.allocationId,resources:structuredClone(t.resources)});
  }
  return {kind:'projected-after-migration-normal-repair', measuredSourceActual:false,
    manifestDigest:context.manifestDigest, projected, requiredRoles:roles, slots,
    plan:freezeCapacityBudget(next)};
}

/** One installation-owned handoff. Native files, old reservations, original
 * commands and rollback deadlines are never changed. The Supervisor remains the
 * sole continuous publisher after its collector configuration is published last. */
export function createMigrationCapacityHandoff({sqlite, Database, journal, instanceId, migrationId,
  configDigest, deadline, rollbackDeadline, native, normal, source, targets,
  protectedRoots = [], capacityStatus, readRepairContext, inspect,
  sample = sampleLinuxCapacity, clock = Date.now, monotonic, write = atomicJson}) {
  invariant(sqlite && Database && journal?.lookup && typeof capacityStatus === 'function' &&
    typeof readRepairContext === 'function' && typeof inspect === 'function' && DIGEST.test(configDigest) &&
    Number.isSafeInteger(deadline) && rollbackDeadline > deadline && normal?.templates,
  'MIGRATION_NORMAL_HANDOFF_CONFIG_REQUIRED');
  const paths = [normal.root, normal.planPath, normal.configPath, normal.observationPath, normal.transitionRoot,
    native.planPath, native.configPath, native.observationPath];
  invariant(paths.every(isAbsolute) && new Set(paths).size === paths.length &&
    normal.planPath === join(normal.root,'plan.json') && normal.configPath === join(normal.root,'collector.json') &&
    normal.observationPath === join(normal.root,'observation.json') && normal.transitionRoot === join(normal.root,'transitions') &&
    [native.planPath,native.configPath,native.observationPath,...protectedRoots].every(p =>
      isAbsolute(p) && !inside(normal.root,p) && !inside(p,normal.root)) &&
    protectedRoots.every(p => resolve(p) === p),
  'MIGRATION_NORMAL_HANDOFF_PATH_SCOPE_INVALID');
  sqlite.exec('CREATE TABLE IF NOT EXISTS control_migration_normal_handoff(singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance_id TEXT NOT NULL,migration_id TEXT NOT NULL,config_digest TEXT NOT NULL,data TEXT NOT NULL)');
  const load = () => {
    const row=sqlite.prepare('SELECT * FROM control_migration_normal_handoff WHERE singleton=1').get();
    if (!row) return {};
    invariant(row.instance_id===instanceId && row.migration_id===migrationId && row.config_digest===configDigest,
      'MIGRATION_NORMAL_HANDOFF_SCOPE_CHANGED');
    return JSON.parse(row.data);
  };
  const save = data => sqlite.prepare('INSERT OR REPLACE INTO control_migration_normal_handoff VALUES(1,?,?,?,?)')
    .run(instanceId,migrationId,configDigest,canonical(data));
  const bounded = () => {
    invariant(clock()<deadline,'MIGRATION_NORMAL_HANDOFF_DEADLINE_EXPIRED');
    return AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-clock())));
  };
  async function files() {
    const [p,c]=await Promise.all([fact(native.planPath),fact(native.configPath)]), s=capacityStatus();
    invariant(s && !s.pending && s.planHash===digest(p.value) && s.configHash===digest(c.value) &&
      s.planDigest===p.value.planDigest && freezeCapacityBudget(p.value).planDigest===s.planDigest &&
      p.value.instanceId===instanceId && c.value.instanceId===instanceId && c.value.sourceDigest===p.value.sourceDigest &&
      c.value.observationPath===native.observationPath && same(vector(p.value),{limits:s.peak.limits,allocations:s.peak.allocations}),
    'MIGRATION_NORMAL_NATIVE_CHAIN_CHANGED');
    return {plan:p.value,config:c.value,state:s,refs:{plan:{path:native.planPath,rawDigest:p.digest},config:{path:native.configPath,rawDigest:c.digest}}};
  }
  async function directories() {
    for (const p of [normal.root,normal.transitionRoot]) {
      await secureDirectory(p);
      const s=await fs.lstat(p);
      invariant(await fs.realpath(p)===p && (!process.getuid || s.uid===process.getuid()),'MIGRATION_NORMAL_HANDOFF_PATH_CHANGED');
    }
    // Owner data is deliberately outside the control container's mount namespace.
    // Protected roots are canonical exclusion boundaries, not readable inputs.
    for (const p of [native.planPath,native.configPath,native.observationPath])
      invariant(await fs.realpath(p)===p,'MIGRATION_NORMAL_HANDOFF_PATH_CHANGED');
  }
  async function collect(plan,config,publicationLock) {
    const previous=await optional(config.observationPath);
    if(previous) invariant(previous.value.instanceId===instanceId && previous.value.sourceDigest===plan.sourceDigest &&
      previous.value.known===true && same(previous.value.limits,plan.limits) &&
      same(previous.value.residents?.map(({id,identityDigest})=>({id,identityDigest})).sort((a,b)=>a.id.localeCompare(b.id)),
        Object.values(plan.allocations).flat().filter(r=>r.resident).map(({id,identityDigest})=>({id,identityDigest})).sort((a,b)=>a.id.localeCompare(b.id))),
    'MIGRATION_NORMAL_OBSERVATION_CONFLICT');
    return createControlCapacityCollector({config,sample,clock,...(monotonic?{monotonic}:{}),...(publicationLock?{publicationLock}:{})})
      .collect({plan,expectedRevision:previous?.value.revision??0,signal:bounded()});
  }
  function admit(plan,observation) {
    const proof=evaluateCapacityAdmission({plan,observation,now:clock()});
    invariant(proof.qualified,proof.reason??'MIGRATION_NORMAL_CAPACITY_UNKNOWN');
    return proof;
  }
  function originalStopsStarted() {
    return Object.keys(source).some(role => {
      const row=journal.lookup({operationId:migrationId,commandId:migrationId+':'+(role==='coordinator'?'stop-writer':'stop-'+role)});
      return row && !['planned','definitely-not-applied'].includes(row.state);
    });
  }
  async function preflight() {
    await directories();
    const f=await files(), context=await readRepairContext('projected'),
      projection=projectMigrationNormalCapacity({plan:f.plan,templates:normal.templates,context,instanceId,migrationId}), old=load();
    const scope=digest({instanceId,migrationId,configDigest,deadline,rollbackDeadline,
      sourceDigest:f.plan.sourceDigest,originalPeak:f.state.peak,context,roles:projection.requiredRoles,slots:projection.slots});
    if (originalStopsStarted()) {
      invariant(old.preflight?.scopeDigest===scope,'MIGRATION_NORMAL_PREFLIGHT_MISSING');
      return old.preflight;
    }
    for(const path of [normal.planPath,normal.configPath,normal.observationPath])
      invariant(!await optional(path),'MIGRATION_NORMAL_PUBLICATION_ALREADY_EXISTS');
    const projectedPlan=freezeCapacityBudget({...projection.plan,sourceDigest:digest({kind:'normal-headroom-preflight',scope})}),
      config={...f.config,sourceDigest:projectedPlan.sourceDigest,observationPath:join(normal.transitionRoot,'preflight-observation.json')};
    invariant(!old.preflightIntent || old.preflightIntent.scopeDigest===scope,'MIGRATION_NORMAL_PREFLIGHT_SCOPE_CHANGED');
    save({...old,preflightIntent:{scopeDigest:scope,planDigest:projectedPlan.planDigest,sourceDigest:projectedPlan.sourceDigest}});
    const observation=await collect(projectedPlan,config),admission=admit(projectedPlan,observation);
    const proof={kind:'normal-repair-headroom-before-first-stop',scopeDigest:scope,projected:true,
      context,requiredRoles:projection.requiredRoles,slots:projection.slots,planDigest:projectedPlan.planDigest,
      nativeRefs:f.refs,capacitySequence:f.state.sequence,capacityChainDigest:f.state.chainDigest,
      originalPeakDigest:digest(f.state.peak),admission};
    save({...load(),preflight:proof});return proof;
  }
  async function actualCommands(f) {
    const receipts=[];
    for (const [role,target] of Object.entries(source)) {
      const id=migrationId+':'+(role==='coordinator'?'stop-writer':'stop-'+role),row=journal.lookup({operationId:migrationId,commandId:id});
      invariant(row?.state==='applied' && row.specDigest===digest(row.spec) && row.spec.configDigest===configDigest &&
        row.spec.targetDigest===digest(target) && row.spec.deadline===deadline,
      'MIGRATION_NORMAL_SOURCE_STOP_UNPROVEN');
      const p=await inspect(target);
      invariant(p.running===false && p.hostPid===0 && p.paused===false && p.oomKilled===false &&
        p.restartPolicy==='no' && p.restartCount===target.restartCount && [0,143].includes(p.exitCode) &&
        ['containerId','startIdentity','artifactDigest','startedAt','role','imageDigest'].every(k=>p[k]===target[k]),
      'MIGRATION_NORMAL_SOURCE_STOP_UNPROVEN');
      receipts.push({id,row});
    }
    for (const [role,target] of Object.entries(targets)) {
      const id=migrationId+':start-'+role,row=journal.lookup({operationId:migrationId,commandId:id});
      invariant(row?.state==='applied' && row.specDigest===digest(row.spec) && row.spec.configDigest===configDigest &&
        row.spec.targetDigest===digest(target) && row.spec.deadline===deadline,
      'MIGRATION_NORMAL_TARGET_START_UNPROVEN');
      const p=await inspect(row.result);
      invariant(physical(p,row.result) && p.running===true && p.paused===false && p.hostPid>0 &&
        p.oomKilled===false && p.restartPolicy==='no' && p.restartCount===0 &&
        p.startIdentity===target.record.startIdentity && p.artifactDigest===target.record.artifactDigest,
      'MIGRATION_NORMAL_TARGET_START_UNPROVEN');
      receipts.push({id,row});
    }
    for (const {id,row} of receipts) {
      const r=sqlite.prepare('SELECT * FROM control_migration_capacity_receipts WHERE command_id=?').get(id);
      invariant(r?.spec_digest===row.specDigest,'MIGRATION_NORMAL_CAPACITY_RECEIPT_MISSING');
    }
    invariant(journal.pending().length===0 && !f.state.pending,'MIGRATION_NORMAL_FOREIGN_PENDING');
    return digest(receipts);
  }
  async function cas(path,value,expectedAbsent,previousValue) {
    const current=await optional(path);
    invariant(!current || !expectedAbsent && (same(current.value,value) || previousValue && same(current.value,previousValue)),
      'MIGRATION_NORMAL_PUBLICATION_CONFLICT');
    if (!current || !same(current.value,value)) await write(path,value);
  }
  async function publication(work) {
    // Same cross-process mutex used by the already running Supervisor. Never
    // seed or replace its database, and never hold it across an RPC to itself.
    const path=join(normal.transitionRoot,'capacity-publication.db'),before=await fs.lstat(path);
    invariant(before.isFile()&&!before.isSymbolicLink()&&(before.mode&0o077)===0&&await fs.realpath(path)===path&&
      (!process.getuid || before.uid===process.getuid()),
      'MIGRATION_NORMAL_PUBLICATION_LOCK_INSECURE');
    const db=new Database(path,{fileMustExist:true});
    try {
      db.pragma('busy_timeout=50');
      invariant(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().every(r=>r.name==='publication_mutex'),
        'MIGRATION_NORMAL_PUBLICATION_LOCK_SCOPE_CHANGED');
      db.exec('BEGIN IMMEDIATE');
      try { return await work({acquire(){},release(){}}); }
      finally { db.exec('COMMIT'); }
    } finally {db.close();}
  }
  async function publish() {
    bounded();await directories();
    const f=await files(), old=load();
    invariant(old.preflight,'MIGRATION_NORMAL_PREFLIGHT_MISSING');
    const context=await readRepairContext('actual');
    invariant(same(context,old.preflight.context),'MIGRATION_NORMAL_ACTUAL_REPAIR_CHANGED');
    const projection=projectMigrationNormalCapacity({plan:f.plan,templates:normal.templates,context,instanceId,migrationId});
    invariant(same(projection.requiredRoles,old.preflight.requiredRoles) && same(projection.slots,old.preflight.slots) &&
      digest(f.state.peak)===old.preflight.originalPeakDigest,'MIGRATION_NORMAL_APPROVED_VECTOR_CHANGED');
    const commandsDigest=await actualCommands(f);
    let intent=old.intent;
    const evidence={instanceId,migrationId,configDigest,deadline,rollbackDeadline,context,
      capacitySequence:f.state.sequence,capacityChainDigest:f.state.chainDigest,commandsDigest,nativeRefs:f.refs,
      originalPeakDigest:digest(f.state.peak),preflightDigest:digest(old.preflight)};
    const sourceDigest=digest({kind:'migration-normal-capacity-basis',...evidence}),
      nextPlan=freezeCapacityBudget({...projection.plan,sourceDigest}),
      nextConfig={...f.config,sourceDigest,observationPath:normal.observationPath};
    if (!intent) {
      for(const path of [normal.planPath,normal.configPath,normal.observationPath])
        invariant(!await optional(path),'MIGRATION_NORMAL_PUBLICATION_ALREADY_EXISTS');
      intent={kind:'migration-normal-capacity-handoff',state:'pending',evidence,nextPlan,nextConfig};
      intent.intentDigest=digest(intent);save({...old,intent});
    } else {
      const {intentDigest,...facts}=intent;
      invariant(digest(facts)===intentDigest && same(intent.evidence,evidence) && same(intent.nextPlan,nextPlan) &&
        same(intent.nextConfig,nextConfig),'MIGRATION_NORMAL_HANDOFF_INTENT_CHANGED');
    }
    return publication(async publicationLock=>{
      await cas(normal.planPath,nextPlan,false);
      const publishedConfig=await optional(normal.configPath);
      let observation;
      if(publishedConfig){
        invariant(same(publishedConfig.value,nextConfig),'MIGRATION_NORMAL_PUBLICATION_CONFLICT');
        // The original collector-last write already completed. Reconcile its
        // actual Supervisor output; never overwrite that output with a new seed.
        observation=(await fact(normal.observationPath)).value;
        invariant(observation.instanceId===instanceId && observation.sourceDigest===sourceDigest,
          'MIGRATION_NORMAL_OBSERVATION_CONFLICT');
      }else{
        const seedConfig={...nextConfig,observationPath:join(normal.transitionRoot,'handoff-observation.json')};
        const [priorNormal,priorSeed]=await Promise.all([optional(normal.observationPath),optional(seedConfig.observationPath)]);
        invariant(!priorNormal || priorSeed && same(priorNormal.value,priorSeed.value),
          'MIGRATION_NORMAL_OBSERVATION_CONFLICT');
        observation=await collect(nextPlan,seedConfig,publicationLock);
        admit(nextPlan,observation);
        await cas(normal.observationPath,observation,false,priorNormal?.value);
      }
      const admission=admit(nextPlan,observation);
      // Re-read original chain and all physical births after the real two-frame collection.
      const after=await files();invariant(same(after.refs,f.refs) && await actualCommands(after)===commandsDigest,
        'MIGRATION_NORMAL_HANDOFF_PHYSICAL_CHANGED');
      await cas(normal.configPath,nextConfig,false);
      const proof={instanceId,migrationId,configDigest,intentDigest:intent.intentDigest,planDigest:nextPlan.planDigest,
        configDigestValue:digest(nextConfig),sourceDigest,observationDigest:digest(observation),admission,
        capacitySequence:f.state.sequence,capacityChainDigest:f.state.chainDigest,requiredRoles:projection.requiredRoles};
      save({...load(),published:proof});return proof;
    });
  }
  async function assertReady(supervisorReadiness) {
    bounded();const old=load(),p=old.published;
    invariant(p && typeof supervisorReadiness==='function','MIGRATION_NORMAL_HANDOFF_NOT_READY');
    const [plan,config]=await Promise.all([fact(normal.planPath),fact(normal.configPath)]),
      actual=await supervisorReadiness();
    invariant(plan.value.planDigest===p.planDigest && digest(config.value)===p.configDigestValue &&
      actual?.instanceId===instanceId && actual.planDigest===p.planDigest && actual.configDigest===p.configDigestValue &&
      actual.supervisorStartIdentity===targets['control-supervisor'].record.startIdentity &&
      actual.sourceDigest===p.sourceDigest && actual.qualified===true && Number.isSafeInteger(actual.revision) &&
      clock()>=Date.parse(actual.observedAt) && clock()-Date.parse(actual.observedAt)<=plan.value.maxObservationAgeMs &&
      DIGEST.test(actual.observationDigest),'MIGRATION_NORMAL_SUPERVISOR_NOT_READY');
    const observation=await fact(normal.observationPath);
    invariant(observation.value.revision>=actual.revision && (observation.value.revision>actual.revision || digest(observation.value)===actual.observationDigest),
      'MIGRATION_NORMAL_SUPERVISOR_OBSERVATION_CHANGED');
    admit(plan.value,observation.value);
    const result={...p,supervisor:actual};save({...old,ready:result});return result;
  }
  return {preflight,publish,assertReady,status:load};
}
