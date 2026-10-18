import { join } from 'node:path';
import { invariant, canonical, digest, DIGEST } from './trust.mjs';
import { inspectObservation } from './circuit-breaker.mjs';
function fixedBinding(value) {
  const result={...value};for(const key of ['inFlight','activeWS','wsByDigest','httpByDigest'])delete result[key];return result;
}
function servingBinding(value) {
  const result=fixedBinding(value);delete result.fence;delete result.routeGeneration;return result;
}
// A Controller reclaim changes its lease fence, never the immutable activation
// receipt. Bridge that historical gap only for the exact confirmed serving
// binding; arbitrary older fences are not evidence of a confirmed source.
function confirmedBindingReceipt(snapshot,current,instanceId) {
  const step=snapshot.appliedSteps?.find(step=>step.stepId==='activation-confirm'),evidence=step?.evidence,actual=evidence?.actual;
  invariant(snapshot.attempt?.state==='activation-confirmed'&&DIGEST.test(snapshot.attempt.targetDigest)&&evidence&&step.receiptDigest===digest(evidence)&&evidence.instanceId===instanceId&&evidence.manifestDigest===snapshot.attempt.targetDigest&&evidence.compatibility?.qualified===true&&evidence.continuity?.qualified===true&&actual?.instanceId===instanceId&&actual.attemptId===snapshot.attempt.attemptId&&current.attemptId===snapshot.attempt.attemptId&&[0,100].includes(actual.weight)&&Number.isSafeInteger(actual.fence)&&actual.fence>0&&Number.isSafeInteger(current.fence)&&current.fence>=actual.fence&&Number.isSafeInteger(actual.routeGeneration)&&actual.routeGeneration>0&&Number.isSafeInteger(current.routeGeneration)&&current.routeGeneration>=actual.routeGeneration&&canonical(servingBinding(actual))===canonical(servingBinding(current)),'CONFIRMED_SOURCE_ACTIVATION_RECEIPT_REQUIRED');
  return {step,evidence};
}
export function createNativeExecutor({root,instanceId,coordinator,entryOrigin,entryKey,supervisorOrigin,supervisorKey,fetcher=fetch}) {
  invariant(supervisorOrigin&&supervisorKey?.length>=32,'SEPARATE_SUPERVISOR_REQUIRED');
  async function entry(path,body,requestTimeoutMs=5000) { const r=await fetcher(entryOrigin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-platform-internal-key':entryKey},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(requestTimeoutMs)});invariant(r.ok,'ENTRY_RPC_FAILED');return r.json(); }
  async function supervise(path,attempt,fence,kind,requestTimeoutMs=120000) {const r=await fetcher(supervisorOrigin+path,{method:'POST',headers:{'content-type':'application/json','x-platform-internal-key':supervisorKey},body:JSON.stringify({attemptId:attempt.attemptId,fence,kind}),signal:AbortSignal.timeout(requestTimeoutMs)});const result=await r.json();invariant(r.ok,result.code||'SUPERVISOR_RPC_FAILED');return result;}
  const start=(kind,artifact,attempt,fence,requestTimeoutMs)=>supervise('/start',attempt,fence,kind,requestTimeoutMs);
  function remainingStartup(deadline,code='ROLE_PREPARATION_STARTUP_EXCEEDED'){const remaining=deadline-Date.now();invariant(remaining>0,code);return Math.min(120000,remaining);}
  async function boundedObservation(attempt,fence,weight,deadline,code,onStale) {
    while(true) {
      const timeoutMs=remainingStartup(deadline,code);
      try {
        const measured=await coordinator.observation(attempt.attemptId,{fence,weight},{timeoutMs});
        remainingStartup(deadline,code);return measured;
      } catch(error) {
        // Only a completed HTTP rejection proves that the previous read and
        // its worker have finished. Never overlap scans after an unknown result,
        // retry a mutation, or weaken scope/integrity/freshness qualification.
        if(error.code!=='OBSERVATION_STALE'||!Number.isInteger(error.status)||error.status<400)throw error;
        remainingStartup(deadline,code);onStale?.();
        await coordinator.assertFence(attempt.attemptId,fence);
        await new Promise(ok=>setTimeout(ok,Math.min(100,remainingStartup(deadline,code))));
      }
    }
  }
  async function webHealth(actual,requestTimeoutMs=2000){const web=actual.web;try{invariant(web?.origin,'WEB_ORIGIN_UNKNOWN');const u=new URL(web.origin);invariant(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'WEB_ORIGIN_UNKNOWN');const [processResponse,buildResponse]=await Promise.all([fetcher(u.origin+'/web-process',{signal:AbortSignal.timeout(requestTimeoutMs)}),fetcher(u.origin+'/web-build',{signal:AbortSignal.timeout(requestTimeoutMs)})]);invariant(processResponse.ok&&buildResponse.ok,'WEB_PROCESS_UNHEALTHY');const identity=await processResponse.json(),build=await buildResponse.json();invariant(identity.instanceId===instanceId&&identity.artifactDigest===web.digest&&Number.isSafeInteger(identity.pid)&&identity.pid>0&&typeof identity.startIdentity==='string'&&/^[a-f0-9]{40}$/.test(build.webRevision)&&identity.webRevision===build.webRevision,'WEB_PROCESS_IDENTITY_MISMATCH');return {qualified:true,artifactDigest:identity.artifactDigest,webRevision:build.webRevision,startIdentity:identity.startIdentity,pid:identity.pid,observedAt:new Date().toISOString()};}catch(error){return {qualified:false,artifactDigest:web?.digest||null,reason:error.code||'WEB_PROCESS_UNREACHABLE',observedAt:new Date().toISOString()};}}

  async function waitProcess(kind,attempt,fence,deadline=Date.now()+120000){while(true){remainingStartup(deadline,'CANDIDATE_PROCESS_STARTUP_EXCEEDED');await coordinator.assertFence(attempt.attemptId,fence);const observed=await supervise('/observe',attempt,fence,kind,remainingStartup(deadline,'CANDIDATE_PROCESS_STARTUP_EXCEEDED'));remainingStartup(deadline,'CANDIDATE_PROCESS_STARTUP_EXCEEDED');if(observed.qualified===true)return observed;await new Promise(ok=>setTimeout(ok,Math.min(100,Math.max(1,deadline-Date.now()))));}}
  async function admitWeightZero(attempt,fence,current) {
    await coordinator.assertFence(attempt.attemptId,fence);
    invariant(current.instanceId===instanceId&&current.weight===0,'COORDINATOR_SOURCE_BASELINE_ROUTE_CHANGED');
    if(current.attemptId===attempt.attemptId&&current.fence===fence)return {binding:current,receipt:null};
    const snapshot=await coordinator.snapshot(attempt.attemptId),source=(snapshot.sourceActual?.components||snapshot.sourceActivation?.components)?.api;
    invariant(source?.artifactDigest&&current.oldApi?.digest===source.artifactDigest&&Number.isSafeInteger(current.fence)&&current.fence<=fence&&Number.isSafeInteger(current.routeGeneration),'COORDINATOR_SOURCE_BASELINE_SOURCE_UNKNOWN');
    const before={...current};for(const key of ['inFlight','activeWS','wsByDigest','httpByDigest'])delete before[key];
    // /fence admits this writer without altering the serving binding. Stamp only
    // its authority metadata; the Entry CAS rejects concurrent/stale writers.
    const next={...before,attemptId:attempt.attemptId,fence,routeGeneration:before.routeGeneration+1};
    const binding=await entry('/binding',next);
    invariant(canonical(binding)===canonical(next),'COORDINATOR_SOURCE_BASELINE_ADMISSION_UNKNOWN');
    await coordinator.assertFence(attempt.attemptId,fence);
    return {binding,receipt:{metadataOnly:true,before,after:binding}};
  }
  async function admitConfirmedSource(attempt,fence,current,deadline,code='ROLE_PREPARATION_STARTUP_EXCEEDED') {
    if(current.weight===0)return admitWeightZero(attempt,fence,current);
    const remaining=()=>remainingStartup(deadline,code),read=async work=>{const budget=remaining();let timer;try{return await Promise.race([work(),new Promise((_,fail)=>{timer=setTimeout(()=>fail(Object.assign(Error(code),{code})),budget)})]);}finally{clearTimeout(timer);}};
    const fixed=fixedBinding;
    invariant(current.instanceId===instanceId&&current.weight===100&&typeof current.attemptId==='string'&&current.attemptId!==attempt.attemptId&&Number.isSafeInteger(current.fence)&&current.fence<fence&&Number.isSafeInteger(current.routeGeneration)&&current.routeGeneration>0,'CONFIRMED_SOURCE_ROUTE_REQUIRED');
    await read(()=>coordinator.assertFence(attempt.attemptId,fence));
    const snapshot=await read(()=>coordinator.snapshot(attempt.attemptId)),activation=snapshot.sourceActivation,actual=snapshot.sourceActual;
    invariant(snapshot.attempt?.attemptId===attempt.attemptId&&snapshot.attempt.instanceId===instanceId&&Number.isSafeInteger(snapshot.attempt.generation)&&snapshot.fence===fence&&snapshot.plan?.planDigest===attempt.plan.planDigest&&typeof activation?.releaseId==='string'&&Number.isSafeInteger(activation.activationGeneration)&&activation.activationGeneration>0&&snapshot.plan.sourceActivationGeneration===activation.activationGeneration&&attempt.plan.sourceActivationGeneration===activation.activationGeneration,'CONFIRMED_SOURCE_SNAPSHOT_REQUIRED');
    if(actual){const proof={...actual};delete proof.proofDigest;invariant(actual.schemaVersion===1&&actual.qualified===true&&actual.partial===true&&actual.instanceId===instanceId&&actual.baseConfirmedReleaseId===activation.releaseId&&actual.activationGeneration===activation.activationGeneration&&digest(proof)===actual.proofDigest,'SOURCE_ACTUAL_UNQUALIFIED');}
    const source=(actual?.components||activation.components)?.api,selected=current.candidateApi;
    invariant(source&&selected?.digest===source.artifactDigest&&typeof selected.origin==='string','CONFIRMED_SOURCE_COMPONENT_MISMATCH');
    const prior=await read(()=>coordinator.snapshot(current.attemptId));
    // Failed attempts consume attempt generations; only successful confirmation
    // advances activation generation. Bind each sequence to its durable source.
    const priorActivation=prior.sourceActivation?.activationGeneration;
    invariant(prior.attempt?.attemptId===current.attemptId&&prior.attempt.instanceId===instanceId&&prior.attempt.state==='activation-confirmed'&&Number.isSafeInteger(prior.fence)&&prior.fence>=current.fence&&prior.fence<fence&&Number.isSafeInteger(prior.attempt.generation)&&prior.attempt.generation>=activation.activationGeneration&&prior.attempt.generation<snapshot.attempt.generation&&Number.isSafeInteger(priorActivation)&&priorActivation>0&&prior.plan?.sourceActivationGeneration===priorActivation&&priorActivation+1===activation.activationGeneration&&prior.attempt.targetReleaseId===activation.releaseId&&prior.manifest?.releaseId===activation.releaseId&&canonical(prior.manifest.components?.api)===canonical(source),'CONFIRMED_SOURCE_HISTORY_MISMATCH');
    const activationReceipt=prior.fence===current.fence?null:confirmedBindingReceipt(prior,current,instanceId);
    const step=prior.appliedSteps?.find(step=>step.stepId==='candidate'),record=step?.evidence;
    invariant(record&&step.receiptDigest===digest(record)&&record.instanceId===instanceId&&record.attemptId===current.attemptId&&record.kind==='api'&&record.origin===selected.origin&&record.artifactDigest===source.artifactDigest&&typeof record.startIdentity==='string'&&record.startIdentity.length>0&&Number.isSafeInteger(record.pid)&&record.pid>0,'CONFIRMED_SOURCE_CANDIDATE_RECEIPT_REQUIRED');
    invariant(typeof coordinator.processObserve==='function','SOURCE_PROCESS_OBSERVATION_REQUIRED');
    const observed=await read(()=>coordinator.processObserve({instanceId,attemptId:current.attemptId,kind:'api',origin:record.origin,startIdentity:record.startIdentity,artifactDigest:record.artifactDigest,pid:record.pid}));
    const fresh=()=>{const age=Date.now()-Date.parse(observed.observedAt);return Number.isFinite(age)&&age>=-1000&&age<=attempt.plan.policy.observationFreshnessMs;};
    invariant(observed.qualified===true&&observed.startIdentity===record.startIdentity&&observed.artifactDigest===record.artifactDigest&&observed.pid===record.pid&&fresh(),'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED');
    const before=fixed(current),latest=await read(()=>entry('/binding'));
    invariant(canonical(fixed(latest))===canonical(before),'CONFIRMED_SOURCE_BINDING_CHANGED');
    await read(()=>coordinator.assertFence(attempt.attemptId,fence));remaining();invariant(fresh(),'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED');
    // All future HTTP requests still select exactly the currently serving API.
    // The stable Entry keeps existing HTTP/WS transports and retained Webs.
    const next={...before,attemptId:attempt.attemptId,fence,routeGeneration:before.routeGeneration+1,weight:0,oldApi:{...selected},candidateApi:null};
    let binding;try{binding=await entry('/binding',next,Math.min(5000,remaining()));}catch(error){remaining();throw error;}remaining();
    invariant(canonical(binding)===canonical(next),'CONFIRMED_SOURCE_ADMISSION_UNKNOWN');
    await read(()=>coordinator.assertFence(attempt.attemptId,fence));
    return {binding,receipt:{servingEquivalent:true,before,after:binding,sourceReleaseId:activation.releaseId,sourceActivationGeneration:activation.activationGeneration,sourceComponent:source,sourceCandidateReceiptDigest:step.receiptDigest,...(activationReceipt?{sourceActivationReceiptDigest:activationReceipt.step.receiptDigest}:{}),sourceProcess:observed}};
  }
  async function refreshConfirmedFence({attempt,fence,current}) {
    await coordinator.assertFence(attempt.attemptId,fence);
    const snapshot=await coordinator.snapshot(attempt.attemptId);
    invariant(snapshot.attempt?.attemptId===attempt.attemptId&&snapshot.attempt.instanceId===instanceId&&snapshot.attempt.state==='activation-confirmed'&&snapshot.fence===fence&&snapshot.attempt.targetDigest===attempt.targetDigest&&snapshot.plan?.planDigest===attempt.plan.planDigest&&canonical(snapshot.manifest?.components)===canonical(attempt.manifest.components)&&current.instanceId===instanceId&&current.attemptId===attempt.attemptId&&Number.isSafeInteger(current.fence)&&current.fence<fence&&(current.weight===100||current.weight===0&&attempt.plan.apiReused===true),'CONFIRMED_RETENTION_SCOPE_CHANGED');
    const anchor=confirmedBindingReceipt(snapshot,current,instanceId),selected=current.weight===100?current.candidateApi:current.oldApi,component=attempt.manifest.components.api;
    invariant(selected?.digest===component.artifactDigest,'CONFIRMED_SOURCE_COMPONENT_MISMATCH');
    const candidate=snapshot.appliedSteps?.find(step=>step.stepId==='candidate'),record=current.weight===100?candidate?.evidence:anchor.evidence.compatibility.identity;
    invariant(record&&(current.weight!==100||candidate.receiptDigest===digest(record)&&record.attemptId===attempt.attemptId&&record.kind==='api'&&record.origin===selected.origin)&&record.instanceId===instanceId&&record.artifactDigest===component.artifactDigest&&typeof record.startIdentity==='string'&&record.startIdentity.length>0&&Number.isSafeInteger(record.pid)&&record.pid>0,'CONFIRMED_SOURCE_CANDIDATE_RECEIPT_REQUIRED');
    const observed=await coordinator.processObserve({instanceId,attemptId:attempt.attemptId,kind:'api',origin:selected.origin,startIdentity:record.startIdentity,artifactDigest:record.artifactDigest,pid:record.pid});
    const fresh=()=>{const age=Date.now()-Date.parse(observed.observedAt);return Number.isFinite(age)&&age>=-1000&&age<=attempt.plan.policy.observationFreshnessMs;};
    invariant(observed.qualified===true&&observed.startIdentity===record.startIdentity&&observed.artifactDigest===record.artifactDigest&&observed.pid===record.pid&&fresh(),'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED');
    const before=fixedBinding(current),latest=await entry('/binding');
    invariant(canonical(fixedBinding(latest))===canonical(before),'CONFIRMED_SOURCE_BINDING_CHANGED');
    await coordinator.assertFence(attempt.attemptId,fence);invariant(fresh(),'CONFIRMED_SOURCE_PROCESS_UNQUALIFIED');
    // Only authority metadata advances. StableEntry's generation CAS rejects a
    // competing route commit and preserves every established HTTP/WS transport.
    const next={...before,fence,routeGeneration:before.routeGeneration+1},binding=await entry('/binding',next);
    invariant(canonical(binding)===canonical(next),'CONFIRMED_SOURCE_ADMISSION_UNKNOWN');
    await coordinator.assertFence(attempt.attemptId,fence);
    return {binding,receipt:{servingEquivalent:true,before,after:binding,activationReceiptDigest:anchor.step.receiptDigest,sourceProcess:observed}};
  }
  async function sourceBaseline(attempt,fence,expectedGeneration) {
    const policy=attempt.plan.policy,windowMs=Math.max(60000,policy.stageDurationMs||0);
    const deadline=Date.now()+Math.max(policy.candidateStartupMs||120000,windowMs+policy.observationFreshnessMs);
    const snapshot=await coordinator.snapshot(attempt.attemptId),source=(snapshot.sourceActual?.components||snapshot.sourceActivation?.components)?.api;
    invariant(source?.artifactDigest,'COORDINATOR_SOURCE_BASELINE_SOURCE_UNKNOWN');
    let bindingAdmission=null;
    while(true) {
      await coordinator.assertFence(attempt.attemptId,fence);
      const admitted=await admitConfirmedSource(attempt,fence,await entry('/binding'),deadline,'COORDINATOR_SOURCE_BASELINE_NOT_QUALIFIED'),current=admitted.binding;
      bindingAdmission ||= admitted.receipt;
      invariant(current.instanceId===instanceId&&current.attemptId===attempt.attemptId&&current.fence===fence&&current.weight===0&&current.oldApi?.digest===source.artifactDigest,'COORDINATOR_SOURCE_BASELINE_ROUTE_CHANGED');
      // The Observer collects the real window independently. A read also waits
      // for its uncached read-only integrity worker, within this same deadline.
      const measured=await boundedObservation(attempt,fence,0,deadline,'COORDINATOR_SOURCE_BASELINE_NOT_QUALIFIED'),baseline=measured.baseline,p=measured.probes,hard=measured.invariants;
      invariant(typeof baseline?.known==='boolean'&&typeof baseline.qualified==='boolean'&&Number.isSafeInteger(measured.coordinatorGeneration)&&measured.coordinatorGeneration>0&&typeof measured.observerEpoch==='string'&&measured.observerEpoch.length>0,'COORDINATOR_SOURCE_BASELINE_PROTOCOL_REQUIRED');
      invariant(expectedGeneration===undefined||measured.coordinatorGeneration===expectedGeneration,'COORDINATOR_SOURCE_BASELINE_GENERATION_CHANGED');
      // A newly admitted scope has no measurements before the first real
      // Observer request completes. It is pending, never a qualifying window.
      // Any recorded failure or measured deadline breach still refuses at once.
      const emptyProbes=p?.known===false&&p.samples===0&&p.failures===0;
      const latencySafe=Number.isFinite(p?.maxLatencyMs)?p.maxLatencyMs<=policy.requestDeadlineMs:emptyProbes&&p.maxLatencyMs===null;
      const attachSafe=Number.isFinite(p?.attachMaxMs)?p.attachMaxMs<=policy.attachDeadlineMs:emptyProbes&&p.attachMaxMs===null;
      invariant(measured.fenceValid===true&&measured.ownerGenerationsValid===true&&measured.routeGenerationValid===true&&measured.sharedStateHealthy===true&&measured.continuity?.qualified===true&&hard&&['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].every(k=>hard[k]===0)&&p&&p.failures===0&&latencySafe&&attachSafe,'COORDINATOR_SOURCE_BASELINE_UNSAFE');
      let enough=false;
      if(baseline.known) {
        const proof=baseline.source;
        invariant(proof&&proof.instanceId===instanceId&&proof.attemptId===attempt.attemptId&&proof.fence===fence&&proof.routeGeneration===current.routeGeneration&&proof.coordinatorGeneration===measured.coordinatorGeneration&&proof.observerEpoch===measured.observerEpoch&&proof.artifactDigest===source.artifactDigest&&typeof proof.startIdentity==='string'&&proof.startIdentity.length>0&&proof.origin===current.oldApi.origin&&proof.weight===0&&proof.routeWeight===0,'COORDINATOR_SOURCE_BASELINE_PROOF_MISMATCH');
        const age=Date.now()-Date.parse(proof.observedAt);
        enough=baseline.qualified===true&&Number.isFinite(baseline.requests)&&baseline.requests>=policy.minRequests&&Number.isFinite(baseline.windowMs)&&baseline.windowMs>=windowMs&&baseline.errorRate===0&&Number.isFinite(baseline.p95Ms)&&Number.isFinite(age)&&age>=-1000&&age<=policy.observationFreshnessMs&&Number.isFinite(p.hz)&&p.hz>=policy.probeHz&&Number.isFinite(p.samples)&&p.samples>=policy.probeHz*windowMs/1000;
      }
      const latest=await entry('/binding');
      invariant(latest.instanceId===current.instanceId&&latest.attemptId===current.attemptId&&latest.fence===current.fence&&latest.routeGeneration===current.routeGeneration&&latest.weight===0&&latest.oldApi?.digest===current.oldApi.digest&&latest.oldApi?.origin===current.oldApi.origin,'COORDINATOR_SOURCE_BASELINE_ROUTE_CHANGED');
      await coordinator.assertFence(attempt.attemptId,fence);
      invariant(Date.now()<deadline,'COORDINATOR_SOURCE_BASELINE_NOT_QUALIFIED');
      if(enough)return {binding:latest,baseline,bindingAdmission};
      await new Promise(ok=>setTimeout(ok,Math.min(100,Math.max(1,deadline-Date.now()))));
    }
  }
  // A Web binding commit changes the probe scope even at an unchanged 100% API
  // weight. Keep that exact serving binding while the independent Observer
  // gathers its new window; a prior route's counts cannot authorize activation.
  async function changedApiActivation(attempt,fence) {
    const policy=attempt.plan.policy,windowMs=Math.max(60000,policy.stageDurationMs),budget=policy.candidateStartupMs||120000;
    invariant(Number.isFinite(budget)&&budget>0&&Number.isFinite(policy.evaluationIntervalMs)&&policy.evaluationIntervalMs>0,'ACTIVATION_SCOPE_BUDGET_INVALID');
    const deadline=Date.now()+budget;
    const read=async work=>{const remaining=deadline-Date.now();invariant(remaining>0,'ACTIVATION_SCOPE_COLLECTION_EXCEEDED');let timer;try{return await Promise.race([work(),new Promise((_,fail)=>{timer=setTimeout(()=>fail(Object.assign(Error('Activation observation budget exceeded'),{code:'ACTIVATION_SCOPE_COLLECTION_EXCEEDED'})),remaining);})]);}finally{clearTimeout(timer);}};
    const fixed=value=>{const result={...value};for(const key of ['inFlight','activeWS','wsByDigest','httpByDigest'])delete result[key];return result;};
    const fenceCheck=()=>read(()=>coordinator.assertFence(attempt.attemptId,fence));
    await fenceCheck();
    const actual=await read(()=>entry('/binding')),frozen=canonical(fixed(actual)),target=attempt.manifest.components;
    invariant(actual.instanceId===instanceId&&actual.attemptId===attempt.attemptId&&actual.fence===fence&&Number.isSafeInteger(actual.routeGeneration)&&actual.routeGeneration>0&&actual.weight===100&&actual.candidateApi?.digest===target.api.artifactDigest&&actual.web?.digest===target.web.artifactDigest,'ACTIVATION_BINDING_UNKNOWN');
    const snapshot=await read(()=>coordinator.snapshot(attempt.attemptId)),source=(snapshot.sourceActual?.components||snapshot.sourceActivation?.components)?.api;
    invariant(source?.artifactDigest===actual.oldApi?.digest,'ACTIVATION_SOURCE_IDENTITY_UNKNOWN');
    const candidate=snapshot.appliedSteps?.find(step=>step.stepId==='candidate')?.evidence;
    invariant(candidate?.artifactDigest===target.api.artifactDigest&&candidate.origin===actual.candidateApi.origin&&typeof candidate.startIdentity==='string'&&candidate.startIdentity.length>0,'ACTIVATION_CANDIDATE_RECEIPT_UNKNOWN');
    const handoff=snapshot.appliedSteps?.find(step=>step.stepId==='coordinator-handoff')?.evidence;
    if(handoff)invariant(Number.isSafeInteger(handoff.generation)&&handoff.generation>0,'ACTIVATION_COORDINATOR_RECEIPT_UNKNOWN');
    const priorObservation=snapshot.appliedSteps?.findLast(step=>step.stepId==='observe-100')?.evidence;
    const sourceAnchor=priorObservation?.baseline||handoff?.sourceBaseline,anchor=sourceAnchor?.source;
    invariant(sourceAnchor?.known===true&&sourceAnchor.qualified===true&&anchor?.instanceId===instanceId&&anchor.attemptId===attempt.attemptId&&anchor.fence===fence&&Number.isSafeInteger(anchor.routeGeneration)&&(priorObservation?anchor.routeGeneration+(attempt.plan.webReused===true?0:1)===actual.routeGeneration:anchor.routeGeneration<actual.routeGeneration)&&anchor.weight===0&&anchor.routeWeight===(priorObservation?100:0)&&anchor.origin===actual.oldApi.origin&&anchor.artifactDigest===source.artifactDigest&&typeof anchor.startIdentity==='string'&&anchor.startIdentity.length>0&&Number.isSafeInteger(anchor.coordinatorGeneration)&&anchor.coordinatorGeneration>0&&typeof anchor.observerEpoch==='string'&&anchor.observerEpoch.length>0,'ACTIVATION_SOURCE_ANCHOR_UNKNOWN');
    invariant(!handoff||(handoff.generation===anchor.coordinatorGeneration&&handoff.sourceBaseline?.source?.observerEpoch===anchor.observerEpoch),'ACTIVATION_COORDINATOR_RECEIPT_UNKNOWN');
    const generation=anchor.coordinatorGeneration,epoch=anchor.observerEpoch,sourceStart=anchor.startIdentity;
    let previous={},nextEvaluation=0;
    const unchanged=async()=>{const current=await read(()=>entry('/binding'));invariant(canonical(fixed(current))===frozen,'ACTIVATION_BINDING_CHANGED');return current;};
    while(true) {
      await fenceCheck();await unchanged();
      const measured=await read(()=>boundedObservation(attempt,fence,100,deadline,'ACTIVATION_SCOPE_COLLECTION_EXCEEDED',()=>{previous={};nextEvaluation=0;}));
      invariant(Number.isSafeInteger(measured.coordinatorGeneration)&&measured.coordinatorGeneration>0&&typeof measured.observerEpoch==='string'&&measured.observerEpoch.length>0,'ACTIVATION_OBSERVATION_PROTOCOL_REQUIRED');
      invariant(measured.coordinatorGeneration===generation&&measured.observerEpoch===epoch,'ACTIVATION_OBSERVER_SCOPE_CHANGED');
      const at=Date.parse(measured.observedAt),now=Date.now();
      invariant(Number.isFinite(at)&&at<=now+1000&&now-at<=policy.observationFreshnessMs,'OBSERVATION_STALE');
      invariant(measured.fenceValid===true&&measured.ownerGenerationsValid===true&&measured.routeGenerationValid===true,'CONTROL_OR_OWNERSHIP_UNKNOWN');
      const hard=measured.invariants;
      invariant(hard&&['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].every(k=>typeof hard[k]==='number'),'INVARIANT_EVIDENCE_MISSING');
      invariant(Object.values(hard).every(value=>value===0),'HARD_INVARIANT_VIOLATION');
      invariant(measured.sharedStateHealthy===true&&measured.continuity?.qualified===true,'SHARED_STATE_OR_CONTINUITY_UNKNOWN');
      const web=measured.webHealth,baseline=measured.baseline,p=measured.probes,cp=measured.candidateProbes;
      if(!(web?.known===true&&web.healthy===true&&web.artifactDigest===actual.web.digest))throw Object.assign(Error('Web unhealthy during activation collection'),{code:'WEB_UNHEALTHY',faultEvidence:measured,componentScope:['web']});
      invariant(baseline&&typeof baseline.known==='boolean'&&typeof baseline.qualified==='boolean'&&Number.isFinite(baseline.requests)&&baseline.requests>=0&&Number.isFinite(baseline.windowMs)&&baseline.windowMs>=0,'ACTIVATION_OBSERVATION_PROTOCOL_REQUIRED');
      invariant(baseline.failures===0,'ACTIVATION_SOURCE_BASELINE_UNSAFE');
      const proof=baseline.source;
      if(proof) {
        invariant(proof.instanceId===instanceId&&proof.attemptId===attempt.attemptId&&proof.fence===fence&&proof.routeGeneration===actual.routeGeneration&&proof.routeWeight===100&&proof.weight===0&&proof.coordinatorGeneration===generation&&proof.observerEpoch===epoch&&proof.origin===actual.oldApi.origin&&proof.artifactDigest===source.artifactDigest&&typeof proof.startIdentity==='string'&&proof.startIdentity.length>0,'ACTIVATION_SOURCE_SCOPE_CHANGED');
        invariant(proof.startIdentity===sourceStart,'ACTIVATION_SOURCE_SCOPE_CHANGED');
        // begin() can expose the exact cohort identity before its first sample.
        // Only that empty state may lack a source timestamp.
        const emptySource=baseline.known===false&&baseline.qualified===false&&baseline.requests===0&&baseline.windowMs===0&&proof.observedAt===null,age=Date.now()-Date.parse(proof.observedAt);
        invariant(emptySource||(Number.isFinite(age)&&age>=-1000&&age<=policy.observationFreshnessMs),'OBSERVATION_STALE');
      } else invariant(baseline.known===false&&baseline.requests===0&&baseline.windowMs===0,'ACTIVATION_SOURCE_SCOPE_CHANGED');
      const empty=lane=>lane?.known===false&&lane.samples===0&&lane.failures===0;
      for(const lane of [p,cp])invariant(lane&&typeof lane.known==='boolean'&&Number.isFinite(lane.samples)&&lane.samples>=0&&lane.failures===0&&((empty(lane)&&lane.maxLatencyMs===null)||(Number.isFinite(lane.maxLatencyMs)&&lane.maxLatencyMs<=policy.requestDeadlineMs)),'SLO_PROBE_FAILED');
      invariant((empty(p)&&p.attachMaxMs===null)||(Number.isFinite(p.attachMaxMs)&&p.attachMaxMs<=policy.attachDeadlineMs),'SLO_PROBE_FAILED');
      // An exactly empty new cohort has no measured attach latency yet. Keep
      // its nulls, but continue every physical/shared-state guard above/below.
      const emptyAttach=empty(p)&&p.attachMaxMs===null;
      const observed={...measured,web:{qualified:true,artifactDigest:web.artifactDigest}};
      const hardInspection=emptyAttach?null:inspectObservation(observed,policy,now,{consecutive:0});
      if(hardInspection?.fault&&hardInspection.fault!=='SOFT_TRAFFIC_DEGRADATION')throw Object.assign(Error(hardInspection.fault),{code:hardInspection.fault,faultEvidence:measured,shared:hardInspection.shared,componentScope:hardInspection.componentScope});
      const compatibility=await read(()=>coordinator.validateSwitch(attempt.attemptId,{fence,actual,manifestDigest:attempt.targetDigest}));
      invariant(['controlOnly','noRuntimeSideEffects','authContinuity','originalResourceAddressable','businessMatches','webMatches'].every(k=>compatibility[k]===true)&&compatibility.identity?.artifactDigest===target.api.artifactDigest&&compatibility.identity.startIdentity===candidate.startIdentity,'ACTIVATION_PHYSICAL_IDENTITY_CHANGED');
      await unchanged();await fenceCheck();
      const complete=!emptyAttach&&baseline.known===true&&baseline.qualified===true&&baseline.windowMs>=windowMs&&baseline.requests>=policy.minRequests&&Number.isFinite(baseline.errorRate)&&baseline.errorRate===0&&Number.isFinite(baseline.p95Ms)&&p.known===true&&cp.known===true&&p.windowMs>=windowMs&&cp.windowMs>=windowMs&&measured.windowMs>=windowMs&&p.samples>=policy.probeHz*windowMs/1000&&cp.samples>=policy.probeHz*windowMs/1000;
      if(!complete){previous={};nextEvaluation=0;}
      if(complete&&Date.now()>=nextEvaluation) {
        const inspection=inspectObservation(observed,policy,Date.now(),previous);previous=inspection;nextEvaluation=Date.now()+policy.evaluationIntervalMs;
        if(inspection.fault)throw Object.assign(Error(inspection.fault),{code:inspection.fault,faultEvidence:measured,shared:inspection.shared,componentScope:inspection.componentScope});
        if(inspection.qualified&&compatibility.qualified===true) {
          const continuity=await read(()=>coordinator.continuity(attempt.attemptId,{fence}));invariant(continuity.qualified===true,'SHARED_STATE_OR_CONTINUITY_UNKNOWN');
          const actualInstaller=await read(()=>supervise('/current-installer',attempt,fence,'installer'));
          await unchanged();await fenceCheck();invariant(Date.now()<deadline,'ACTIVATION_SCOPE_COLLECTION_EXCEEDED');
          const completedAt=Date.now();
          invariant([measured.observedAt,proof.observedAt].every(value=>{const age=completedAt-Date.parse(value);return Number.isFinite(age)&&age>=-1000&&age<=policy.observationFreshnessMs;}),'OBSERVATION_STALE');
          return {actual,actualInstaller,compatibility,continuity,activationObservation:measured,activationScope:{routeGeneration:actual.routeGeneration,weight:100,fence,coordinatorGeneration:generation,observerEpoch:epoch},observedAt:new Date().toISOString(),manifestDigest:attempt.targetDigest,instanceId};
        }
      }
      invariant(Date.now()<deadline,'ACTIVATION_SCOPE_COLLECTION_EXCEEDED');
      await read(()=>new Promise(ok=>setTimeout(ok,Math.min(1000,Math.max(1,deadline-Date.now())))));
    }
  }
  async function roleTransition(kind,{artifact,attempt,fence,operationId},statusOnly=false) {
    const deadline=statusOnly?0:Date.now()+(attempt.plan.policy.candidateStartupMs||120000);
    await coordinator.assertFence(attempt.attemptId,fence);const rpc=kind==='owner'?coordinator.ownerCandidate:coordinator.coordinatorHandoff;invariant(typeof rpc==='function','ROLE_TRANSITION_RPC_REQUIRED');
    if(statusOnly){const observed=await supervise('/observe',attempt,fence,kind);if(observed.definitelyAbsent)return {definitelyNotApplied:true};const result=await rpc(attempt.attemptId,{fence,operationId,planDigest:attempt.plan.planDigest,candidate:observed.record,action:'status'});if(result.applied===true&&result.evidence?.qualified===true){let evidence=result.evidence;if(kind==='coordinator'){invariant(Number.isSafeInteger(evidence.generation)&&evidence.generation>0,'COORDINATOR_SOURCE_BASELINE_GENERATION_UNKNOWN');const proof=await sourceBaseline(attempt,fence,evidence.generation);evidence={...evidence,sourceBaseline:proof.baseline,sourceBaselineAdmission:proof.bindingAdmission};}return {applied:true,evidence,completedWork:1};}invariant(result.definitelyNotApplied===true,'ROLE_TRANSITION_RESULT_UNKNOWN');return result;}
    const admission=kind==='owner'?await admitConfirmedSource(attempt,fence,await entry('/binding'),deadline):null;
    const candidate=await start(kind,artifact,attempt,fence,remainingStartup(deadline));await waitProcess(kind,attempt,fence,deadline);
    if(kind==='coordinator'){
      while(true){remainingStartup(deadline,'COORDINATOR_BASELINE_NOT_QUALIFIED');await coordinator.assertFence(attempt.attemptId,fence);const measured=await boundedObservation(attempt,fence,0,deadline,'COORDINATOR_BASELINE_NOT_QUALIFIED'),p=measured.probes,baseline=measured.baseline,hard=measured.invariants;remainingStartup(deadline,'COORDINATOR_BASELINE_NOT_QUALIFIED');
        const enough=Number(baseline?.requests)>=attempt.plan.policy.minRequests;
        const safe=measured.sharedStateHealthy===true&&measured.continuity?.qualified===true&&hard&&['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].every(k=>hard[k]===0)&&p?.hz>=attempt.plan.policy.probeHz&&p.failures===0&&p.maxLatencyMs<=attempt.plan.policy.requestDeadlineMs&&p.attachMaxMs<=attempt.plan.policy.attachDeadlineMs&&baseline?.errorRate===0;
        if(enough&&safe)break;invariant(Date.now()<deadline,'COORDINATOR_BASELINE_NOT_QUALIFIED');await new Promise(ok=>setTimeout(ok,100));
      }
    }
    let evidence;for(const action of kind==='owner'?['prepare','adopt']:['prepare','quiesce','release','adopt']){await coordinator.assertFence(attempt.attemptId,fence);if(action==='prepare'||action==='quiesce'||(kind==='owner'&&action==='adopt'))remainingStartup(deadline);evidence=await rpc(attempt.attemptId,{fence,operationId,planDigest:attempt.plan.planDigest,candidate,action},action==='prepare'?{timeoutMs:remainingStartup(deadline)}:undefined);if(action==='prepare')remainingStartup(deadline);invariant(evidence.commitKnown===true,'ROLE_TRANSITION_COMMIT_UNKNOWN');}
    const applied=evidence.evidence??evidence;invariant(applied.qualified===true&&applied.originalResourcesPreserved===true,'ROLE_TRANSITION_UNCONFIRMED');if(kind==='coordinator'){invariant(Number.isSafeInteger(applied.generation)&&applied.generation>0,'COORDINATOR_SOURCE_BASELINE_GENERATION_UNKNOWN');const proof=await sourceBaseline(attempt,fence,applied.generation);return {...applied,sourceBaseline:proof.baseline,sourceBaselineAdmission:proof.bindingAdmission};}return admission?.receipt?{...applied,sourceBindingAdmission:admission.receipt}:applied;
  }
  return {
    refreshConfirmedFence,
    async prepare({download,attempt,fence}) { invariant(attempt.plan.package.format==='native-tar','UNSUPPORTED_EXECUTOR_FORMAT'); await coordinator.assertFence(attempt.attemptId,fence); return supervise('/publish',attempt,fence,'installer'); },
    async installerIsCurrent({attempt,fence}){const identity=await supervise('/current-installer',attempt,fence,'installer');return identity.artifactDigest===attempt.manifest.components.installer.artifactDigest&&identity.inputFingerprint===attempt.manifest.components.installer.inputFingerprint;},
    async installerCandidate({artifact,attempt,fence}){const record=await start('installer',artifact,attempt,fence);const deadline=Date.now()+120000;while(true){const result=await supervise('/observe',attempt,fence,'installer');if(result.qualified===true)return {...record,...result.identity};invariant(Date.now()<deadline,'INSTALLER_CANDIDATE_STARTUP_EXCEEDED');await new Promise(ok=>setTimeout(ok,100));}},
    async installerHandoff({attempt,fence,operationId,candidate}){const evidence=await coordinator.controllerHandoff(attempt.attemptId,{fence,operationId,planDigest:attempt.plan.planDigest,candidate,action:'adopt'});invariant(evidence.commitKnown===true&&evidence.authorityTransferred===true,'CONTROLLER_HANDOFF_UNKNOWN');return supervise('/activate-installer',attempt,fence,'installer');},
    ownerCandidate:input=>roleTransition('owner',input),
    coordinatorHandoff:input=>roleTransition('coordinator',input),
    async candidate({artifact,attempt,fence}) {
      await coordinator.assertFence(attempt.attemptId,fence);const deadline=Date.now()+(attempt.plan.policy.candidateStartupMs||120000),binding=await entry('/binding'),admitted=await admitConfirmedSource(attempt,fence,binding,deadline,'CANDIDATE_STARTUP_BUDGET_EXCEEDED'),process=await start('api',artifact,attempt,fence);await waitProcess('api',attempt,fence,deadline);
      while(true) {
        invariant(Date.now()<deadline,'CANDIDATE_STARTUP_BUDGET_EXCEEDED');
        await coordinator.assertFence(attempt.attemptId,fence);
        let evidence;try{evidence=await coordinator.validateSwitch(attempt.attemptId,{fence,candidate:process,manifestDigest:attempt.targetDigest});}catch(e){if(!['CANDIDATE_NOT_READY','CANDIDATE_UNREACHABLE','COORDINATOR_RPC_FAILED'].includes(e.code))throw e;}
        if(evidence?.qualified===true) {invariant(Date.now()<deadline,'CANDIDATE_STARTUP_BUDGET_EXCEEDED');invariant(evidence.controlOnly===true&&evidence.noRuntimeSideEffects===true&&evidence.authContinuity===true&&evidence.originalResourceAddressable===true,'CANDIDATE_NOT_READY');return {...process,evidence,bindingAdmission:admitted?.receipt||null};}
        invariant(Date.now()<deadline,'CANDIDATE_STARTUP_BUDGET_EXCEEDED');await new Promise(ok=>setTimeout(ok,250));
      }
    },
    async reconcile({step,attempt,fence,local}) {
      await coordinator.assertFence(attempt.attemptId,fence);
      if(step.kind==='route'||step.kind==='web') {
        const actual=await entry('/binding');const applied=step.kind==='route'?actual.weight===step.weight&&actual.candidateApi?.digest===attempt.manifest.components.api.artifactDigest:actual.web.digest===attempt.manifest.components.web.artifactDigest;
        return applied?{applied:true,evidence:actual,completedWork:1}:{definitelyNotApplied:true};
      }
      if(step.kind==='installer-handoff'){const observed=await supervise('/observe',attempt,fence,'installer');if(observed.definitelyAbsent)return {definitelyNotApplied:true};invariant(observed.qualified===true,'INSTALLER_IDENTITY_UNKNOWN');return {definitelyNotApplied:true};}
      if(step.kind==='owner-candidate'||step.kind==='coordinator-handoff')return roleTransition(step.kind==='owner-candidate'?'owner':'coordinator',{attempt,fence,operationId:local.operationId},true);
      if(step.kind==='candidate') {
        const deadline=Date.now()+(attempt.plan.policy.candidateStartupMs||120000),binding=await entry('/binding'),admitted=await admitConfirmedSource(attempt,fence,binding,deadline,'CANDIDATE_STARTUP_BUDGET_EXCEEDED');
        const first=await supervise('/observe',attempt,fence,'api');const observed=first.definitelyAbsent?first:await waitProcess('api',attempt,fence,deadline);
        if(observed.definitelyAbsent)return {definitelyNotApplied:true};const record=observed.record;
        invariant(record&&observed.qualified&&observed.artifactDigest===attempt.manifest.components.api.artifactDigest&&observed.startIdentity===record.startIdentity,'CANDIDATE_PROCESS_IDENTITY_UNKNOWN');
        while(true){invariant(Date.now()<deadline,'CANDIDATE_STARTUP_BUDGET_EXCEEDED');await coordinator.assertFence(attempt.attemptId,fence);let ready;try{ready=await coordinator.validateSwitch(attempt.attemptId,{fence,candidate:record,manifestDigest:attempt.targetDigest});}catch(e){if(!['CANDIDATE_NOT_READY','CANDIDATE_UNREACHABLE','COORDINATOR_RPC_FAILED'].includes(e.code))throw e;}if(ready?.qualified===true){invariant(Date.now()<deadline,'CANDIDATE_STARTUP_BUDGET_EXCEEDED');return {applied:true,evidence:{...record,evidence:ready,bindingAdmission:admitted?.receipt||null},completedWork:1};}await new Promise(ok=>setTimeout(ok,250));}
      }
      return {definitelyNotApplied:true};
    },
    async observe({attempt,fence,weight}) {const deadline=Date.now()+Math.min(120000,attempt.plan.policy.candidateStartupMs||120000);await coordinator.assertFence(attempt.attemptId,fence);const observation=await boundedObservation(attempt,fence,weight,deadline,'OBSERVATION_COLLECTION_EXCEEDED');const continuity=await coordinator.continuity(attempt.attemptId,{fence});const web=await webHealth(await entry('/binding'));remainingStartup(deadline,'OBSERVATION_COLLECTION_EXCEEDED');return {...observation,continuity,web}; },
    async applyRoute({attempt,fence,weight,candidate}) {await coordinator.assertFence(attempt.attemptId,fence);let current=await entry('/binding'),proof;if(current.weight===0&&weight>0){proof=await sourceBaseline(attempt,fence);current=proof.binding;}const next={...current};delete next.inFlight;delete next.activeWS;delete next.wsByDigest;delete next.httpByDigest;Object.assign(next,{instanceId,attemptId:attempt.attemptId,fence,routeGeneration:current.routeGeneration+1,weight,candidateApi:{origin:candidate.origin,digest:candidate.artifactDigest}});const result=await entry('/binding',next);return proof?{...result,sourceBaseline:proof.baseline,sourceBaselineAdmission:proof.bindingAdmission}:result;},
    async bindWeb({attempt,fence,artifact}) {const deadline=Date.now()+(attempt.plan.policy.candidateStartupMs||120000);await coordinator.assertFence(attempt.attemptId,fence);const process=await start('web',artifact,attempt,fence,remainingStartup(deadline,'WEB_CANDIDATE_STARTUP_EXCEEDED')),observed=await waitProcess('web',attempt,fence,deadline);const web={origin:process.origin,root:join(artifact.root,'web'),digest:attempt.manifest.components.web.artifactDigest,treeDigest:artifact.treeDigest},health=await webHealth({web},Math.min(2000,remainingStartup(deadline,'WEB_CANDIDATE_STARTUP_EXCEEDED')));remainingStartup(deadline,'WEB_CANDIDATE_STARTUP_EXCEEDED');invariant(health.qualified===true&&health.webRevision===attempt.manifest.components.web.webRevision&&health.startIdentity===process.startIdentity&&health.pid===observed.pid,'WEB_CANDIDATE_NOT_READY');await coordinator.assertFence(attempt.attemptId,fence);const current=await entry('/binding');remainingStartup(deadline,'WEB_CANDIDATE_STARTUP_EXCEEDED');const next={...current};delete next.inFlight;delete next.activeWS;delete next.wsByDigest;delete next.httpByDigest;Object.assign(next,{fence,attemptId:attempt.attemptId,routeGeneration:current.routeGeneration+1,web,retainedWeb:current.web.digest===web.digest?current.retainedWeb:[current.web,...current.retainedWeb].filter((w,i,a)=>a.findIndex(x=>x.digest===w.digest)===i)});return entry('/binding',next);},
    async actual() {return entry('/binding');},
    // Full read-only integrity scans run outside the bounded writer batch and
    // keep the Coordinator responsive. Their control RPC has a separate bound;
    // batch writes and user-facing health/attachment deadlines remain unchanged.
    async migration({attempt,fence,operationId,action,checkpoint}) {return coordinator.migration(attempt.attemptId,{fence,operationId,action,planDigest:attempt.plan.migrationPath.migrationPlanDigest,checkpoint,policy:attempt.plan.policy},['prepare','status'].includes(action)?{timeoutMs:120000}:undefined);},
    async activationEvidence({attempt,fence}) {if(attempt.plan.apiReused!==true)return changedApiActivation(attempt,fence);await sourceBaseline(attempt,fence);const actual=await entry('/binding'),compatibility=await coordinator.validateSwitch(attempt.attemptId,{fence,actual,manifestDigest:attempt.targetDigest}),continuity=await coordinator.continuity(attempt.attemptId,{fence});const actualInstaller=await supervise('/current-installer',attempt,fence,'installer');return {actual,actualInstaller,compatibility,continuity,observedAt:new Date().toISOString(),manifestDigest:attempt.targetDigest,instanceId};},
    async fallbackEligibility({attempt,fence,fault}) {const deadline=Date.now()+120000;const actual=await entry('/binding'),result=await coordinator.fallbackEligibility(attempt.attemptId,{fence,fault,actual},{timeoutMs:remainingStartup(deadline,'FALLBACK_ELIGIBILITY_COLLECTION_EXCEEDED')});remainingStartup(deadline,'FALLBACK_ELIGIBILITY_COLLECTION_EXCEEDED');return result;},
    async recover({attempt,fence,recoveryPlan}) {await coordinator.assertFence(attempt.attemptId,fence);if(recoveryPlan.coordinator||recoveryPlan.owner){const transitioned=await coordinator.coordinatorRecovery(attempt.attemptId,{fence,recoveryPlanDigest:recoveryPlan.planDigest});invariant(transitioned.commitKnown===true&&transitioned.qualified===true&&transitioned.originalResourcesPreserved===true,'COORDINATOR_RECOVERY_UNCONFIRMED');}const current=await entry('/binding'),next={...current};delete next.inFlight;delete next.activeWS;delete next.wsByDigest;delete next.httpByDigest;Object.assign(next,{fence,attemptId:attempt.attemptId,routeGeneration:current.routeGeneration+1});if(recoveryPlan.api) {next.oldApi=recoveryPlan.api;next.weight=0;}if(recoveryPlan.web){next.retainedWeb=[current.web,...current.retainedWeb];next.web=recoveryPlan.web;}return entry('/binding',next);},
    // Deliberately no VM lifecycle, whole-volume restore, shell or scheduler method.
  };
}
