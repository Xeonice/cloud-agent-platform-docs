import { join } from 'node:path';
import { invariant } from './trust.mjs';
export function createNativeExecutor({root,instanceId,coordinator,entryOrigin,entryKey,supervisorOrigin,supervisorKey,fetcher=fetch}) {
  invariant(supervisorOrigin&&supervisorKey?.length>=32,'SEPARATE_SUPERVISOR_REQUIRED');
  async function entry(path,body) { const r=await fetcher(entryOrigin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-platform-internal-key':entryKey},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});invariant(r.ok,'ENTRY_RPC_FAILED');return r.json(); }
  async function supervise(path,attempt,fence,kind) {const r=await fetcher(supervisorOrigin+path,{method:'POST',headers:{'content-type':'application/json','x-platform-internal-key':supervisorKey},body:JSON.stringify({attemptId:attempt.attemptId,fence,kind}),signal:AbortSignal.timeout(120000)});const result=await r.json();invariant(r.ok,result.code||'SUPERVISOR_RPC_FAILED');return result;}
  const start=(kind,artifact,attempt,fence)=>supervise('/start',attempt,fence,kind);
  async function webHealth(actual){const web=actual.web;try{invariant(web?.origin,'WEB_ORIGIN_UNKNOWN');const u=new URL(web.origin);invariant(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'WEB_ORIGIN_UNKNOWN');const [processResponse,buildResponse]=await Promise.all([fetcher(u.origin+'/web-process',{signal:AbortSignal.timeout(2000)}),fetcher(u.origin+'/web-build',{signal:AbortSignal.timeout(2000)})]);invariant(processResponse.ok&&buildResponse.ok,'WEB_PROCESS_UNHEALTHY');const identity=await processResponse.json(),build=await buildResponse.json();invariant(identity.instanceId===instanceId&&identity.artifactDigest===web.digest&&Number.isSafeInteger(identity.pid)&&identity.pid>0&&typeof identity.startIdentity==='string'&&/^[a-f0-9]{40}$/.test(build.webRevision)&&identity.webRevision===build.webRevision,'WEB_PROCESS_IDENTITY_MISMATCH');return {qualified:true,artifactDigest:identity.artifactDigest,webRevision:build.webRevision,startIdentity:identity.startIdentity,pid:identity.pid,observedAt:new Date().toISOString()};}catch(error){return {qualified:false,artifactDigest:web?.digest||null,reason:error.code||'WEB_PROCESS_UNREACHABLE',observedAt:new Date().toISOString()};}}

  async function waitProcess(kind,attempt,fence){const deadline=Date.now()+120000;while(true){await coordinator.assertFence(attempt.attemptId,fence);const observed=await supervise('/observe',attempt,fence,kind);if(observed.qualified===true)return observed;invariant(Date.now()<deadline,'CANDIDATE_PROCESS_STARTUP_EXCEEDED');await new Promise(ok=>setTimeout(ok,100));}}
  async function roleTransition(kind,{artifact,attempt,fence,operationId},statusOnly=false) {
    await coordinator.assertFence(attempt.attemptId,fence);const rpc=kind==='owner'?coordinator.ownerCandidate:coordinator.coordinatorHandoff;invariant(typeof rpc==='function','ROLE_TRANSITION_RPC_REQUIRED');
    if(statusOnly){const observed=await supervise('/observe',attempt,fence,kind);if(observed.definitelyAbsent)return {definitelyNotApplied:true};const result=await rpc(attempt.attemptId,{fence,operationId,planDigest:attempt.plan.planDigest,candidate:observed.record,action:'status'});if(result.applied===true&&result.evidence?.qualified===true)return {applied:true,evidence:result.evidence,completedWork:1};invariant(result.definitelyNotApplied===true,'ROLE_TRANSITION_RESULT_UNKNOWN');return result;}
    const candidate=await start(kind,artifact,attempt,fence);await waitProcess(kind,attempt,fence);
    if(kind==='coordinator'){
      const deadline=Date.now()+(attempt.plan.policy.candidateStartupMs||120000);
      while(true){await coordinator.assertFence(attempt.attemptId,fence);const measured=await coordinator.observation(attempt.attemptId,{fence,weight:0}),p=measured.probes,baseline=measured.baseline,hard=measured.invariants;
        const enough=Number(baseline?.requests)>=attempt.plan.policy.minRequests;
        const safe=measured.sharedStateHealthy===true&&measured.continuity?.qualified===true&&hard&&['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].every(k=>hard[k]===0)&&p?.hz>=attempt.plan.policy.probeHz&&p.failures===0&&p.maxLatencyMs<=attempt.plan.policy.requestDeadlineMs&&p.attachMaxMs<=attempt.plan.policy.attachDeadlineMs&&baseline?.errorRate===0;
        if(enough&&safe)break;invariant(Date.now()<deadline,'COORDINATOR_BASELINE_NOT_QUALIFIED');await new Promise(ok=>setTimeout(ok,100));
      }
    }
    let evidence;for(const action of kind==='owner'?['prepare','adopt']:['prepare','quiesce','release','adopt']){await coordinator.assertFence(attempt.attemptId,fence);evidence=await rpc(attempt.attemptId,{fence,operationId,planDigest:attempt.plan.planDigest,candidate,action});invariant(evidence.commitKnown===true,'ROLE_TRANSITION_COMMIT_UNKNOWN');}
    const applied=evidence.evidence??evidence;invariant(applied.qualified===true&&applied.originalResourcesPreserved===true,'ROLE_TRANSITION_UNCONFIRMED');return applied;
  }
  return {
    async prepare({download,attempt,fence}) { invariant(attempt.plan.package.format==='native-tar','UNSUPPORTED_EXECUTOR_FORMAT'); await coordinator.assertFence(attempt.attemptId,fence); return supervise('/publish',attempt,fence,'installer'); },
    async installerIsCurrent({attempt,fence}){const identity=await supervise('/current-installer',attempt,fence,'installer');return identity.artifactDigest===attempt.manifest.components.installer.artifactDigest&&identity.inputFingerprint===attempt.manifest.components.installer.inputFingerprint;},
    async installerCandidate({artifact,attempt,fence}){const record=await start('installer',artifact,attempt,fence);const deadline=Date.now()+120000;while(true){const result=await supervise('/observe',attempt,fence,'installer');if(result.qualified===true)return {...record,...result.identity};invariant(Date.now()<deadline,'INSTALLER_CANDIDATE_STARTUP_EXCEEDED');await new Promise(ok=>setTimeout(ok,100));}},
    async installerHandoff({attempt,fence,operationId,candidate}){const evidence=await coordinator.controllerHandoff(attempt.attemptId,{fence,operationId,planDigest:attempt.plan.planDigest,candidate,action:'adopt'});invariant(evidence.commitKnown===true&&evidence.authorityTransferred===true,'CONTROLLER_HANDOFF_UNKNOWN');return supervise('/activate-installer',attempt,fence,'installer');},
    ownerCandidate:input=>roleTransition('owner',input),
    coordinatorHandoff:input=>roleTransition('coordinator',input),
    async candidate({artifact,attempt,fence}) {
      await coordinator.assertFence(attempt.attemptId,fence);const process=await start('api',artifact,attempt,fence);const deadline=Date.now()+(attempt.plan.policy.candidateStartupMs||120000);
      while(true) {
        await coordinator.assertFence(attempt.attemptId,fence);
        let evidence;try{evidence=await coordinator.validateSwitch(attempt.attemptId,{fence,candidate:process,manifestDigest:attempt.targetDigest});}catch(e){if(!['CANDIDATE_NOT_READY','CANDIDATE_UNREACHABLE','COORDINATOR_RPC_FAILED'].includes(e.code))throw e;}
        if(evidence?.qualified===true) {invariant(evidence.controlOnly===true&&evidence.noRuntimeSideEffects===true&&evidence.authContinuity===true&&evidence.originalResourceAddressable===true,'CANDIDATE_NOT_READY');return {...process,evidence};}
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
        const first=await supervise('/observe',attempt,fence,'api');const observed=first.definitelyAbsent?first:await waitProcess('api',attempt,fence);
        if(observed.definitelyAbsent)return {definitelyNotApplied:true};const record=observed.record;
        invariant(record&&observed.qualified&&observed.artifactDigest===attempt.manifest.components.api.artifactDigest&&observed.startIdentity===record.startIdentity,'CANDIDATE_PROCESS_IDENTITY_UNKNOWN');
        const ready=await coordinator.validateSwitch(attempt.attemptId,{fence,candidate:record,manifestDigest:attempt.targetDigest});invariant(ready.qualified===true,'CANDIDATE_NOT_READY');return {applied:true,evidence:{...record,evidence:ready},completedWork:1};
      }
      return {definitelyNotApplied:true};
    },
    async observe({attempt,fence,weight}) { await coordinator.assertFence(attempt.attemptId,fence);const observation=await coordinator.observation(attempt.attemptId,{fence,weight});const continuity=await coordinator.continuity(attempt.attemptId,{fence});const web=await webHealth(await entry('/binding'));return {...observation,continuity,web}; },
    async applyRoute({attempt,fence,weight,candidate}) {await coordinator.assertFence(attempt.attemptId,fence);const current=await entry('/binding');const next={...current};delete next.inFlight;delete next.activeWS;delete next.wsByDigest;delete next.httpByDigest;Object.assign(next,{instanceId,attemptId:attempt.attemptId,fence,routeGeneration:current.routeGeneration+1,weight,candidateApi:{origin:candidate.origin,digest:candidate.artifactDigest}});return entry('/binding',next);},
    async bindWeb({attempt,fence,artifact}) {await coordinator.assertFence(attempt.attemptId,fence);const process=await start('web',artifact,attempt,fence),current=await entry('/binding');const next={...current};delete next.inFlight;delete next.activeWS;delete next.wsByDigest;delete next.httpByDigest;const web={origin:process.origin,root:join(artifact.root,'web'),digest:attempt.manifest.components.web.artifactDigest,treeDigest:artifact.treeDigest};Object.assign(next,{fence,attemptId:attempt.attemptId,routeGeneration:current.routeGeneration+1,web,retainedWeb:current.web.digest===web.digest?current.retainedWeb:[current.web,...current.retainedWeb].filter((w,i,a)=>a.findIndex(x=>x.digest===w.digest)===i)});return entry('/binding',next);},
    async actual() {return entry('/binding');},
    async migration({attempt,fence,operationId,action,checkpoint}) {return coordinator.migration(attempt.attemptId,{fence,operationId,action,planDigest:attempt.plan.migrationPath.migrationPlanDigest,checkpoint,policy:attempt.plan.policy});},
    async activationEvidence({attempt,fence}) {const actual=await entry('/binding'),compatibility=await coordinator.validateSwitch(attempt.attemptId,{fence,actual,manifestDigest:attempt.targetDigest}),continuity=await coordinator.continuity(attempt.attemptId,{fence});const actualInstaller=await supervise('/current-installer',attempt,fence,'installer');return {actual,actualInstaller,compatibility,continuity,observedAt:new Date().toISOString(),manifestDigest:attempt.targetDigest,instanceId};},
    async fallbackEligibility({attempt,fence,fault}) {return coordinator.fallbackEligibility(attempt.attemptId,{fence,fault,actual:await entry('/binding')});},
    async recover({attempt,fence,recoveryPlan}) {await coordinator.assertFence(attempt.attemptId,fence);if(recoveryPlan.coordinator||recoveryPlan.owner){const transitioned=await coordinator.coordinatorRecovery(attempt.attemptId,{fence,recoveryPlanDigest:recoveryPlan.planDigest});invariant(transitioned.commitKnown===true&&transitioned.qualified===true&&transitioned.originalResourcesPreserved===true,'COORDINATOR_RECOVERY_UNCONFIRMED');}const current=await entry('/binding'),next={...current};delete next.inFlight;delete next.activeWS;delete next.wsByDigest;delete next.httpByDigest;Object.assign(next,{fence,attemptId:attempt.attemptId,routeGeneration:current.routeGeneration+1});if(recoveryPlan.api) {next.oldApi=recoveryPlan.api;next.weight=0;}if(recoveryPlan.web){next.retainedWeb=[current.web,...current.retainedWeb];next.web=recoveryPlan.web;}return entry('/binding',next);},
    // Deliberately no VM lifecycle, whole-volume restore, shell or scheduler method.
  };
}
