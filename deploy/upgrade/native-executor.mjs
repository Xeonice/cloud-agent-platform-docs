import { join } from 'node:path';
import { invariant, canonical } from './trust.mjs';
export function createNativeExecutor({root,instanceId,coordinator,entryOrigin,entryKey,supervisorOrigin,supervisorKey,fetcher=fetch}) {
  invariant(supervisorOrigin&&supervisorKey?.length>=32,'SEPARATE_SUPERVISOR_REQUIRED');
  async function entry(path,body) { const r=await fetcher(entryOrigin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-platform-internal-key':entryKey},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});invariant(r.ok,'ENTRY_RPC_FAILED');return r.json(); }
  async function supervise(path,attempt,fence,kind,requestTimeoutMs=120000) {const r=await fetcher(supervisorOrigin+path,{method:'POST',headers:{'content-type':'application/json','x-platform-internal-key':supervisorKey},body:JSON.stringify({attemptId:attempt.attemptId,fence,kind}),signal:AbortSignal.timeout(requestTimeoutMs)});const result=await r.json();invariant(r.ok,result.code||'SUPERVISOR_RPC_FAILED');return result;}
  const start=(kind,artifact,attempt,fence,requestTimeoutMs)=>supervise('/start',attempt,fence,kind,requestTimeoutMs);
  function remainingStartup(deadline,code='ROLE_PREPARATION_STARTUP_EXCEEDED'){const remaining=deadline-Date.now();invariant(remaining>0,code);return Math.min(120000,remaining);}
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
  async function sourceBaseline(attempt,fence,expectedGeneration) {
    const policy=attempt.plan.policy,windowMs=Math.max(60000,policy.stageDurationMs||0);
    const deadline=Date.now()+Math.max(policy.candidateStartupMs||120000,windowMs+policy.observationFreshnessMs);
    const snapshot=await coordinator.snapshot(attempt.attemptId),source=(snapshot.sourceActual?.components||snapshot.sourceActivation?.components)?.api;
    invariant(source?.artifactDigest,'COORDINATOR_SOURCE_BASELINE_SOURCE_UNKNOWN');
    let bindingAdmission=null;
    while(true) {
      await coordinator.assertFence(attempt.attemptId,fence);
      const admitted=await admitWeightZero(attempt,fence,await entry('/binding')),current=admitted.binding;
      bindingAdmission ||= admitted.receipt;
      invariant(current.instanceId===instanceId&&current.attemptId===attempt.attemptId&&current.fence===fence&&current.weight===0&&current.oldApi?.digest===source.artifactDigest,'COORDINATOR_SOURCE_BASELINE_ROUTE_CHANGED');
      // The 60s collection happens in the Observer. Each read remains an ordinary
      // short RPC, after adoption has already restored the unique live writer.
      const measured=await coordinator.observation(attempt.attemptId,{fence,weight:0}),baseline=measured.baseline,p=measured.probes,hard=measured.invariants;
      invariant(typeof baseline?.known==='boolean'&&typeof baseline.qualified==='boolean'&&Number.isSafeInteger(measured.coordinatorGeneration)&&measured.coordinatorGeneration>0&&typeof measured.observerEpoch==='string'&&measured.observerEpoch.length>0,'COORDINATOR_SOURCE_BASELINE_PROTOCOL_REQUIRED');
      invariant(expectedGeneration===undefined||measured.coordinatorGeneration===expectedGeneration,'COORDINATOR_SOURCE_BASELINE_GENERATION_CHANGED');
      invariant(measured.fenceValid===true&&measured.ownerGenerationsValid===true&&measured.routeGenerationValid===true&&measured.sharedStateHealthy===true&&measured.continuity?.qualified===true&&hard&&['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].every(k=>hard[k]===0)&&p&&p.failures===0&&Number.isFinite(p.maxLatencyMs)&&p.maxLatencyMs<=policy.requestDeadlineMs&&Number.isFinite(p.attachMaxMs)&&p.attachMaxMs<=policy.attachDeadlineMs,'COORDINATOR_SOURCE_BASELINE_UNSAFE');
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
  async function roleTransition(kind,{artifact,attempt,fence,operationId},statusOnly=false) {
    const deadline=statusOnly?0:Date.now()+(attempt.plan.policy.candidateStartupMs||120000);
    await coordinator.assertFence(attempt.attemptId,fence);const rpc=kind==='owner'?coordinator.ownerCandidate:coordinator.coordinatorHandoff;invariant(typeof rpc==='function','ROLE_TRANSITION_RPC_REQUIRED');
    if(statusOnly){const observed=await supervise('/observe',attempt,fence,kind);if(observed.definitelyAbsent)return {definitelyNotApplied:true};const result=await rpc(attempt.attemptId,{fence,operationId,planDigest:attempt.plan.planDigest,candidate:observed.record,action:'status'});if(result.applied===true&&result.evidence?.qualified===true){let evidence=result.evidence;if(kind==='coordinator'){invariant(Number.isSafeInteger(evidence.generation)&&evidence.generation>0,'COORDINATOR_SOURCE_BASELINE_GENERATION_UNKNOWN');const proof=await sourceBaseline(attempt,fence,evidence.generation);evidence={...evidence,sourceBaseline:proof.baseline,sourceBaselineAdmission:proof.bindingAdmission};}return {applied:true,evidence,completedWork:1};}invariant(result.definitelyNotApplied===true,'ROLE_TRANSITION_RESULT_UNKNOWN');return result;}
    const candidate=await start(kind,artifact,attempt,fence,remainingStartup(deadline));await waitProcess(kind,attempt,fence,deadline);
    if(kind==='coordinator'){
      while(true){remainingStartup(deadline,'COORDINATOR_BASELINE_NOT_QUALIFIED');await coordinator.assertFence(attempt.attemptId,fence);const measured=await coordinator.observation(attempt.attemptId,{fence,weight:0}),p=measured.probes,baseline=measured.baseline,hard=measured.invariants;remainingStartup(deadline,'COORDINATOR_BASELINE_NOT_QUALIFIED');
        const enough=Number(baseline?.requests)>=attempt.plan.policy.minRequests;
        const safe=measured.sharedStateHealthy===true&&measured.continuity?.qualified===true&&hard&&['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].every(k=>hard[k]===0)&&p?.hz>=attempt.plan.policy.probeHz&&p.failures===0&&p.maxLatencyMs<=attempt.plan.policy.requestDeadlineMs&&p.attachMaxMs<=attempt.plan.policy.attachDeadlineMs&&baseline?.errorRate===0;
        if(enough&&safe)break;invariant(Date.now()<deadline,'COORDINATOR_BASELINE_NOT_QUALIFIED');await new Promise(ok=>setTimeout(ok,100));
      }
    }
    let evidence;for(const action of kind==='owner'?['prepare','adopt']:['prepare','quiesce','release','adopt']){await coordinator.assertFence(attempt.attemptId,fence);if(action==='prepare'||action==='quiesce'||(kind==='owner'&&action==='adopt'))remainingStartup(deadline);evidence=await rpc(attempt.attemptId,{fence,operationId,planDigest:attempt.plan.planDigest,candidate,action},action==='prepare'?{timeoutMs:remainingStartup(deadline)}:undefined);if(action==='prepare')remainingStartup(deadline);invariant(evidence.commitKnown===true,'ROLE_TRANSITION_COMMIT_UNKNOWN');}
    const applied=evidence.evidence??evidence;invariant(applied.qualified===true&&applied.originalResourcesPreserved===true,'ROLE_TRANSITION_UNCONFIRMED');if(kind==='coordinator'){invariant(Number.isSafeInteger(applied.generation)&&applied.generation>0,'COORDINATOR_SOURCE_BASELINE_GENERATION_UNKNOWN');const proof=await sourceBaseline(attempt,fence,applied.generation);return {...applied,sourceBaseline:proof.baseline,sourceBaselineAdmission:proof.bindingAdmission};}return applied;
  }
  return {
    async prepare({download,attempt,fence}) { invariant(attempt.plan.package.format==='native-tar','UNSUPPORTED_EXECUTOR_FORMAT'); await coordinator.assertFence(attempt.attemptId,fence); return supervise('/publish',attempt,fence,'installer'); },
    async installerIsCurrent({attempt,fence}){const identity=await supervise('/current-installer',attempt,fence,'installer');return identity.artifactDigest===attempt.manifest.components.installer.artifactDigest&&identity.inputFingerprint===attempt.manifest.components.installer.inputFingerprint;},
    async installerCandidate({artifact,attempt,fence}){const record=await start('installer',artifact,attempt,fence);const deadline=Date.now()+120000;while(true){const result=await supervise('/observe',attempt,fence,'installer');if(result.qualified===true)return {...record,...result.identity};invariant(Date.now()<deadline,'INSTALLER_CANDIDATE_STARTUP_EXCEEDED');await new Promise(ok=>setTimeout(ok,100));}},
    async installerHandoff({attempt,fence,operationId,candidate}){const evidence=await coordinator.controllerHandoff(attempt.attemptId,{fence,operationId,planDigest:attempt.plan.planDigest,candidate,action:'adopt'});invariant(evidence.commitKnown===true&&evidence.authorityTransferred===true,'CONTROLLER_HANDOFF_UNKNOWN');return supervise('/activate-installer',attempt,fence,'installer');},
    ownerCandidate:input=>roleTransition('owner',input),
    coordinatorHandoff:input=>roleTransition('coordinator',input),
    async candidate({artifact,attempt,fence}) {
      await coordinator.assertFence(attempt.attemptId,fence);const deadline=Date.now()+(attempt.plan.policy.candidateStartupMs||120000),binding=await entry('/binding'),admitted=binding.weight===0?await admitWeightZero(attempt,fence,binding):null,process=await start('api',artifact,attempt,fence);await waitProcess('api',attempt,fence,deadline);
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
        const deadline=Date.now()+(attempt.plan.policy.candidateStartupMs||120000),binding=await entry('/binding'),admitted=binding.weight===0?await admitWeightZero(attempt,fence,binding):null;
        const first=await supervise('/observe',attempt,fence,'api');const observed=first.definitelyAbsent?first:await waitProcess('api',attempt,fence,deadline);
        if(observed.definitelyAbsent)return {definitelyNotApplied:true};const record=observed.record;
        invariant(record&&observed.qualified&&observed.artifactDigest===attempt.manifest.components.api.artifactDigest&&observed.startIdentity===record.startIdentity,'CANDIDATE_PROCESS_IDENTITY_UNKNOWN');
        while(true){invariant(Date.now()<deadline,'CANDIDATE_STARTUP_BUDGET_EXCEEDED');await coordinator.assertFence(attempt.attemptId,fence);let ready;try{ready=await coordinator.validateSwitch(attempt.attemptId,{fence,candidate:record,manifestDigest:attempt.targetDigest});}catch(e){if(!['CANDIDATE_NOT_READY','CANDIDATE_UNREACHABLE','COORDINATOR_RPC_FAILED'].includes(e.code))throw e;}if(ready?.qualified===true){invariant(Date.now()<deadline,'CANDIDATE_STARTUP_BUDGET_EXCEEDED');return {applied:true,evidence:{...record,evidence:ready,bindingAdmission:admitted?.receipt||null},completedWork:1};}await new Promise(ok=>setTimeout(ok,250));}
      }
      return {definitelyNotApplied:true};
    },
    async observe({attempt,fence,weight}) { await coordinator.assertFence(attempt.attemptId,fence);const observation=await coordinator.observation(attempt.attemptId,{fence,weight});const continuity=await coordinator.continuity(attempt.attemptId,{fence});const web=await webHealth(await entry('/binding'));return {...observation,continuity,web}; },
    async applyRoute({attempt,fence,weight,candidate}) {await coordinator.assertFence(attempt.attemptId,fence);let current=await entry('/binding'),proof;if(current.weight===0&&weight>0){proof=await sourceBaseline(attempt,fence);current=proof.binding;}const next={...current};delete next.inFlight;delete next.activeWS;delete next.wsByDigest;delete next.httpByDigest;Object.assign(next,{instanceId,attemptId:attempt.attemptId,fence,routeGeneration:current.routeGeneration+1,weight,candidateApi:{origin:candidate.origin,digest:candidate.artifactDigest}});const result=await entry('/binding',next);return proof?{...result,sourceBaseline:proof.baseline,sourceBaselineAdmission:proof.bindingAdmission}:result;},
    async bindWeb({attempt,fence,artifact}) {const deadline=Date.now()+(attempt.plan.policy.candidateStartupMs||120000);await coordinator.assertFence(attempt.attemptId,fence);const process=await start('web',artifact,attempt,fence,remainingStartup(deadline,'WEB_CANDIDATE_STARTUP_EXCEEDED')),observed=await waitProcess('web',attempt,fence,deadline);const web={origin:process.origin,root:join(artifact.root,'web'),digest:attempt.manifest.components.web.artifactDigest,treeDigest:artifact.treeDigest},health=await webHealth({web},Math.min(2000,remainingStartup(deadline,'WEB_CANDIDATE_STARTUP_EXCEEDED')));remainingStartup(deadline,'WEB_CANDIDATE_STARTUP_EXCEEDED');invariant(health.qualified===true&&health.webRevision===attempt.manifest.components.web.webRevision&&health.startIdentity===process.startIdentity&&health.pid===observed.pid,'WEB_CANDIDATE_NOT_READY');await coordinator.assertFence(attempt.attemptId,fence);const current=await entry('/binding');remainingStartup(deadline,'WEB_CANDIDATE_STARTUP_EXCEEDED');const next={...current};delete next.inFlight;delete next.activeWS;delete next.wsByDigest;delete next.httpByDigest;Object.assign(next,{fence,attemptId:attempt.attemptId,routeGeneration:current.routeGeneration+1,web,retainedWeb:current.web.digest===web.digest?current.retainedWeb:[current.web,...current.retainedWeb].filter((w,i,a)=>a.findIndex(x=>x.digest===w.digest)===i)});return entry('/binding',next);},
    async actual() {return entry('/binding');},
    async migration({attempt,fence,operationId,action,checkpoint}) {return coordinator.migration(attempt.attemptId,{fence,operationId,action,planDigest:attempt.plan.migrationPath.migrationPlanDigest,checkpoint,policy:attempt.plan.policy});},
    async activationEvidence({attempt,fence}) {const actual=await entry('/binding'),compatibility=await coordinator.validateSwitch(attempt.attemptId,{fence,actual,manifestDigest:attempt.targetDigest}),continuity=await coordinator.continuity(attempt.attemptId,{fence});const actualInstaller=await supervise('/current-installer',attempt,fence,'installer');return {actual,actualInstaller,compatibility,continuity,observedAt:new Date().toISOString(),manifestDigest:attempt.targetDigest,instanceId};},
    async fallbackEligibility({attempt,fence,fault}) {return coordinator.fallbackEligibility(attempt.attemptId,{fence,fault,actual:await entry('/binding')});},
    async recover({attempt,fence,recoveryPlan}) {await coordinator.assertFence(attempt.attemptId,fence);if(recoveryPlan.coordinator||recoveryPlan.owner){const transitioned=await coordinator.coordinatorRecovery(attempt.attemptId,{fence,recoveryPlanDigest:recoveryPlan.planDigest});invariant(transitioned.commitKnown===true&&transitioned.qualified===true&&transitioned.originalResourcesPreserved===true,'COORDINATOR_RECOVERY_UNCONFIRMED');}const current=await entry('/binding'),next={...current};delete next.inFlight;delete next.activeWS;delete next.wsByDigest;delete next.httpByDigest;Object.assign(next,{fence,attemptId:attempt.attemptId,routeGeneration:current.routeGeneration+1});if(recoveryPlan.api) {next.oldApi=recoveryPlan.api;next.weight=0;}if(recoveryPlan.web){next.retainedWeb=[current.web,...current.retainedWeb];next.web=recoveryPlan.web;}return entry('/binding',next);},
    // Deliberately no VM lifecycle, whole-volume restore, shell or scheduler method.
  };
}
