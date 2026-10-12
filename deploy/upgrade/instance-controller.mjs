import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { invariant, digest, canonical, verifyManifest, loadTrustRoot } from './trust.mjs';
import { atomicJson, readJson, secureDirectory, fileDigest } from './io.mjs';
import { downloadVerified } from './artifacts.mjs';
import { inspectObservation, qualifiedFallback } from './circuit-breaker.mjs';
const TERMINAL=new Set(['deferred','candidate-rejected','failed','reverted','activation-confirmed']);
const sleep=(ms,signal)=>new Promise((ok,fail)=>{if(signal?.aborted){fail(signal.reason||Error('Stopped'));return;}const done=()=>{signal?.removeEventListener('abort',aborted);ok();};const timer=setTimeout(done,ms);const aborted=()=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);fail(signal.reason||Error('Stopped'));};signal?.addEventListener('abort',aborted,{once:true});});
export function createInstanceController({root,instanceId,controllerId,startIdentity=controllerId,trustRootPath,coordinator,executor,fetcher=fetch,leaseMs=15000,signal,onEvent}) {
  invariant(controllerId&&instanceId&&coordinator&&executor&&leaseMs>=5000,'CONTROLLER_CONFIG_REQUIRED');
  controllerId = controllerId.slice(0,140) + '-' + randomUUID(); // Restart is a new control incarnation; never reuse a still-live fence.
  let busy=false;
  async function runOnce() {
    if(busy)return {state:'busy'};busy=true;let timer,session;
    try {
      await secureDirectory(root);const authority=await readJson(join(root,'controller-authority.json'),null);if(authority?.instanceId===instanceId&&authority.attemptId&&authority.startIdentity!==startIdentity)return {state:'controller-handoff',attemptId:authority.attemptId};const pending=await coordinator.pending();const record=pending?.attempt?pending:pending?.attempts?.[0]||pending?.pending;
      if(!record)return monitorOnce();const accepted=record.attempt;
      invariant(accepted.instanceId===instanceId&&accepted.requestId&&accepted.acceptedAt&&(record.actorId||accepted.actorId),'USER_INTENT_REQUIRED');
      if(TERMINAL.has(accepted.state)&&record.recovery?.state!=='recovering')return {state:accepted.state,attemptId:accepted.attemptId};
      const envelope=record.signedManifest||record.envelope;const plan=record.plan,source=record.sourceActivation;
      invariant(envelope&&plan&&source,'DURABLE_PLAN_REQUIRED');const roots=await loadTrustRoot(trustRootPath);
      const actualSource=record.sourceActual;
      if(actualSource){const proof={...actualSource};delete proof.proofDigest;invariant(actualSource.schemaVersion===1&&actualSource.qualified===true&&actualSource.partial===true&&actualSource.instanceId===instanceId&&actualSource.baseConfirmedReleaseId===source.releaseId&&actualSource.activationGeneration===source.activationGeneration&&digest(proof)===actualSource.proofDigest,'SOURCE_ACTUAL_UNQUALIFIED');}
      const components=actualSource?.components||source.components;
      const current={...source,schema:actualSource?.schema??source.schema,instanceId,platform:process.platform,arch:process.arch,generation:source.activationGeneration,apiDigest:components.api.artifactDigest,apiInputFingerprint:components.api.inputFingerprint,webDigest:components.web.artifactDigest,webInputFingerprint:components.web.inputFingerprint,installerDigest:components.installer.artifactDigest,installerInputFingerprint:components.installer.inputFingerprint,coordinatorDigest:components.coordinator?.artifactDigest||components.api.artifactDigest,coordinatorInputFingerprint:components.coordinator?.inputFingerprint||components.api.inputFingerprint,ownerDigest:components.owner?.artifactDigest||null,ownerInputFingerprint:components.owner?.inputFingerprint||null,protocols:Object.fromEntries(['api','web','installer','coordinator','owner'].map(k=>[k,components[k]?.protocol||components.api.protocol])),bridges:source.bridges||[]};
      const verified=verifyManifest(envelope,roots,current);const unsigned={...plan};delete unsigned.planDigest;
      invariant(verified.manifestDigest===accepted.targetDigest&&plan.manifestDigest===accepted.targetDigest&&digest(unsigned)===plan.planDigest&&accepted.planDigest===plan.planDigest,'FIXED_PLAN_MISMATCH');
      const claim=await coordinator.claim(accepted.attemptId,{controllerId,leaseMs});session={...(claim.snapshot||record),attempt:claim.attempt||claim.snapshot?.attempt||accepted,fence:claim.fence,generation:claim.generation??claim.snapshot?.attempt?.generation??claim.attempt?.generation??accepted.generation,recovering:record.recovery?.state==='recovering'};
      invariant(Number.isSafeInteger(session.fence)&&session.fence>0,'FENCE_REQUIRED');
      const attempt={...session.attempt,manifest:envelope.manifest,plan,targetDigest:accepted.targetDigest,instanceId};let sequence=session.attempt.sequence,leaseLost=null;
      const journalPath=join(root,'journals',accepted.attemptId+'.json');let journal=await readJson(journalPath,{attemptId:accepted.attemptId,planDigest:plan.planDigest,steps:{}});
      invariant(journal.planDigest===plan.planDigest,'JOURNAL_PLAN_CHANGED');
      const assertFence=async()=>{if(leaseLost)throw leaseLost;invariant(!signal?.aborted,'CONTROLLER_STOPPED');await coordinator.assertFence(attempt.attemptId,session.fence);};
      timer=setInterval(()=>{coordinator.renew(attempt.attemptId,{controllerId,fence:session.fence,leaseMs}).catch(e=>{leaseLost=e;});},Math.min(1000,Math.floor(leaseMs/3)));timer.unref();
      async function commit(kind,payload,eventId=randomUUID()) {
        await assertFence();const next=await coordinator.commit(attempt.attemptId,{fence:session.fence,generation:session.generation,expectedSequence:sequence,eventId,kind,payload});
        sequence=next.attempt?.sequence??next.snapshot?.attempt?.sequence??next.sequence;invariant(Number.isSafeInteger(sequence),'COMMIT_SNAPSHOT_REQUIRED');onEvent?.({kind,attemptId:attempt.attemptId,sequence});return next;
      }
      async function applied(step,evidence,completedWork) {
        const receiptDigest=digest(evidence);const next=await commit('step-applied',{stepId:step.stepId,receiptDigest,completedWork,evidence});journal.steps[step.stepId]={state:'applied',receiptDigest,evidence,completedWork};await atomicJson(journalPath,journal);return next;
      }
      let artifact,candidate,download;
      if(record.recovery?.state==='recovering'){
        const recoveryPlan=record.recoveryPlan;invariant(recoveryPlan?.triggeringAttemptId===attempt.attemptId&&recoveryPlan.planDigest===record.recovery.planDigest,'FIXED_RECOVERY_PLAN_REQUIRED');const unsignedRecovery={...recoveryPlan};delete unsignedRecovery.planDigest;invariant(digest(unsignedRecovery)===recoveryPlan.planDigest,'RECOVERY_PLAN_CHANGED');
        journal.recovery={recoveryAttemptId:record.recovery.recoveryAttemptId,planDigest:recoveryPlan.planDigest,state:'reconciling'};await atomicJson(journalPath,journal);
        // The Coordinator's durable handoff journal makes this exact plan
        // idempotent. No new recovery intent, fallback selection or rollback of
        // data is invented after a Controller process loss.
        const actual=await executor.recover({attempt,fence:session.fence,recoveryPlan}),continuity=await executor.observe({attempt,fence:session.fence,weight:actual.weight});invariant(continuity.continuity?.qualified===true,'RECOVERY_UNCONFIRMED');
        const result=await commit('recovery-confirmed',{recoveryAttemptId:record.recovery.recoveryAttemptId,actual,continuity});journal.recovery.state='confirmed';journal.monitorStopped='recovered';await atomicJson(journalPath,journal);return {state:'recovery-confirmed',attemptId:attempt.attemptId,recovery:result.recovery};
      }
      for(const step of plan.steps) {
        await assertFence();const prior=await coordinator.step(attempt.attemptId,step.stepId);
        if(prior?.state==='applied'||prior?.applied===true){if(step.kind==='installer-handoff'&&!await executor.installerIsCurrent({attempt,fence:session.fence})){const candidateInstaller=prior.evidence;await executor.installerHandoff({attempt,fence:session.fence,operationId:candidateInstaller.operationId,candidate:candidateInstaller});return {state:'controller-handoff',attemptId:attempt.attemptId};}journal.steps[step.stepId]={state:'applied',...prior};if(step.kind==='download')download=prior.evidence;if(step.kind==='verify')artifact=prior.evidence;if(step.kind==='candidate')candidate=prior.evidence;continue;}
        const local=journal.steps[step.stepId];
        if(local?.state==='applying') {
          const reconciled=await executor.reconcile?.({step,attempt,fence:session.fence,local});
          if(reconciled?.applied){await applied(step,reconciled.evidence,reconciled.completedWork);if(step.kind==='download')download=reconciled.evidence;if(step.kind==='verify')artifact=reconciled.evidence;if(step.kind==='candidate')candidate=reconciled.evidence;continue;}
          invariant(reconciled?.definitelyNotApplied===true||['download','verify','observe','activation','migration'].includes(step.kind),'APPLICATION_RESULT_UNKNOWN');
        }
        const operationId=local?.operationId||randomUUID();journal.steps[step.stepId]={state:'applying',operationId,fence:session.fence};await atomicJson(journalPath,journal);
        if(step.kind==='installer-handoff'){artifact ||= journal.steps['package-verify']?.evidence;const candidateInstaller=await executor.installerCandidate({artifact,attempt,fence:session.fence,operationId});invariant(candidateInstaller.artifactDigest===attempt.manifest.components.installer.artifactDigest&&candidateInstaller.inputFingerprint===attempt.manifest.components.installer.inputFingerprint,'INSTALLER_CANDIDATE_IDENTITY_MISMATCH');await applied(step,candidateInstaller,1);await executor.installerHandoff({attempt,fence:session.fence,operationId,candidate:candidateInstaller});journal.controllerTransferred=true;await atomicJson(journalPath,journal);return {state:'controller-handoff',attemptId:attempt.attemptId};}
        if(step.kind==='download') {
          download=await downloadVerified(plan.package,root,{fetcher,signal,assertFence,allowedRedirectOrigins:roots.distributionOrigins,onProgress:(completed,total,evidence)=>commit('progress',{stepId:step.stepId,completedWork:completed,totalWork:total,evidence,stage:'downloading'})});await applied(step,download,plan.package.bytes);
        }else if(step.kind==='verify') {
          download ||= journal.steps['package-download']?.evidence;invariant(download,'DOWNLOAD_RECEIPT_MISSING');artifact=await executor.prepare({download,attempt,fence:session.fence});await applied(step,artifact,1);
        }else if(step.kind==='migration') {
          let checkpoint=local?.checkpoint??null;let completed=0;
          if(local?.state==='applying'){
            const status=await executor.migration({attempt,fence:session.fence,operationId:operationId+':status',action:'status',checkpoint});
            if(status.commitKnown===true){invariant(status.integrityValid===true&&status.budgetExceeded!==true,'MIGRATION_UNSAFE_OR_OVER_BUDGET');checkpoint=status.checkpoint;completed=status.completedWork;journal.steps[step.stepId].checkpoint=checkpoint;await atomicJson(journalPath,journal);if(status.complete===true){await applied(step,status,completed);continue;}}
            else invariant(status.definitelyNotApplied===true,'MIGRATION_RESULT_UNKNOWN');
          }
          while(true){await assertFence();const result=await executor.migration({attempt,fence:session.fence,operationId:operationId+':'+digest(checkpoint??'initial').slice(7,23),action:checkpoint?'batch':'prepare',checkpoint});
            invariant(result.commitKnown===true,'MIGRATION_COMMIT_UNKNOWN');invariant(result.integrityValid===true&&result.budgetExceeded!==true,'MIGRATION_UNSAFE_OR_OVER_BUDGET');
            checkpoint=result.checkpoint;completed=result.completedWork;invariant(Number.isFinite(completed)&&completed>=0,'MIGRATION_WORK_INVALID');journal.steps[step.stepId].checkpoint=checkpoint;await atomicJson(journalPath,journal);
            await commit('progress',{stepId:step.stepId,completedWork:completed,totalWork:step.totalWork,evidence:result,stage:'migrating'});
            if(result.complete===true){await applied(step,result,completed);break;}await sleep(10,signal);
          }
        }else if(step.kind==='candidate') {
          artifact ||= journal.steps['package-verify']?.evidence;candidate=await executor.candidate({artifact,attempt,fence:session.fence,operationId});await applied(step,candidate,1);
        }else if(step.kind==='owner-candidate'||step.kind==='coordinator-handoff') {
          artifact ||= journal.steps['package-verify']?.evidence;const evidence=step.kind==='owner-candidate'?await executor.ownerCandidate({artifact,attempt,fence:session.fence,operationId}):await executor.coordinatorHandoff({artifact,attempt,fence:session.fence,operationId});
          invariant(evidence.qualified===true&&evidence.originalResourcesPreserved===true,'ROLE_TRANSITION_UNCONFIRMED');if(step.kind==='coordinator-handoff')invariant(evidence.singleWriter===true&&evidence.maxControlPauseMs<=plan.policy.requestDeadlineMs,'COORDINATOR_HANDOFF_UNSAFE');
          await applied(step,evidence,1);
        }else if(step.kind==='route') {
          candidate ||= journal.steps.candidate?.evidence;invariant(candidate,'CANDIDATE_RECEIPT_MISSING');const evidence=await executor.applyRoute({attempt,fence:session.fence,weight:step.weight,candidate,operationId});
          invariant(evidence.weight===step.weight&&evidence.candidateApi?.digest===attempt.manifest.components.api.artifactDigest,'ROUTE_APPLY_UNCONFIRMED');await applied(step,evidence,1);
        }else if(step.kind==='observe') {
          let previous={};while(true){await assertFence();const evidence=await executor.observe({attempt,fence:session.fence,weight:step.weight}),inspection=inspectObservation(evidence,plan.policy,Date.now(),previous);previous=inspection;
            if(inspection.fault)throw Object.assign(Error(inspection.fault),{code:inspection.fault,faultEvidence:evidence,shared:inspection.shared});
            await commit('progress',{stepId:step.stepId,completedWork:inspection.completedWork,totalWork:step.totalWork,evidence,stage:'observing'});
            if(inspection.qualified){await applied(step,evidence,step.totalWork);break;}await sleep(plan.policy.evaluationIntervalMs,signal);
          }
        }else if(step.kind==='web') {
          artifact ||= journal.steps['package-verify']?.evidence;const evidence=await executor.bindWeb({attempt,fence:session.fence,artifact,operationId});invariant(evidence.web?.digest===attempt.manifest.components.web.artifactDigest&&evidence.instanceId===instanceId,'WEB_BINDING_UNCONFIRMED');await applied(step,evidence,1);
        }else if(step.kind==='activation') {
          const evidence=await executor.activationEvidence({attempt,fence:session.fence});invariant(evidence.instanceId===instanceId&&evidence.manifestDigest===attempt.targetDigest&&evidence.actual?.web?.digest===attempt.manifest.components.web.artifactDigest&&evidence.compatibility?.qualified===true&&evidence.continuity?.qualified===true,'OVERALL_ACTIVATION_UNCONFIRMED');
          const activeApi=evidence.actual.weight===100?evidence.actual.candidateApi:evidence.actual.oldApi;invariant(activeApi?.digest===attempt.manifest.components.api.artifactDigest,'ACTUAL_API_MISMATCH');await applied(step,evidence,1);const confirmed=await commit('activation-confirmed',evidence);journal.confirmedAt=confirmed.attempt?.observedAt||confirmed.snapshot?.attempt?.observedAt||new Date().toISOString();journal.retentionUntil=new Date(Date.parse(journal.confirmedAt)+plan.policy.retentionMs).toISOString();await atomicJson(journalPath,journal);
        }else throw Object.assign(Error('Unknown frozen step'),{code:'UNKNOWN_STEP'});
      }
      return {state:'activation-confirmed',attemptId:attempt.attemptId};
    }catch(error){
      if(session&&error.code!=='STALE_FENCE'&&error.code!=='LEASE_EXPIRED'&&error.code!=='UPGRADE_FENCE_EXPIRED'&&error.code!=='CONTROLLER_STOPPED'){
        if(session.recovering){try{const fresh=await coordinator.snapshot(session.attempt.attemptId);if(fresh.recovery?.state==='recovering'){await coordinator.commit(session.attempt.attemptId,{fence:session.fence,generation:session.generation,expectedSequence:fresh.attempt.sequence,eventId:randomUUID(),kind:'recovery-failed',payload:{reason:error.code||'RECOVERY_UNKNOWN',actual:await executor.actual()}});const path=join(root,'journals',session.attempt.attemptId+'.json'),journal=await readJson(path,{});journal.monitorStopped='recovery-unknown';await atomicJson(path,journal);}}catch{}}
        else await handleFault(session,error).catch(()=>{});
      }
      throw error;
    }finally{if(timer)clearInterval(timer);busy=false;}
  }

  async function monitorOnce() {
    // The accepted upgrade remains the sole authorization during its fixed retention window.
    // This runs in the actual controller loop, also after a process restart. It never re-runs steps.
    const names=await readdir(join(root,'journals')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).sort()) {
      const path=join(root,'journals',name),journal=await readJson(path);if(journal.monitorStopped||(journal.circuitBroken&&journal.faultRecordingComplete))continue;
      const snapshot=await coordinator.snapshot(journal.attemptId),accepted=snapshot.attempt;if(accepted.state!=='activation-confirmed')continue;
      const plan=snapshot.plan;invariant(plan?.planDigest===journal.planDigest,'MONITOR_PLAN_CHANGED');
      journal.confirmedAt ||= accepted.observedAt;journal.retentionUntil ||= new Date(Date.parse(journal.confirmedAt)+plan.policy.retentionMs).toISOString();
      if(Date.now()>=Date.parse(journal.retentionUntil)){journal.monitorStopped='retention-expired';await atomicJson(path,journal);continue;}
      if(journal.nextObservationAt&&Date.now()<Date.parse(journal.nextObservationAt))continue;
      let claim;
      try {claim=await coordinator.claim(accepted.attemptId,{controllerId,leaseMs});}
      catch(e){if(['UPGRADE_AUTHORITY_SUPERSEDED','UPGRADE_TERMINAL_ATTEMPT'].includes(e.code)){journal.monitorStopped=e.code;await atomicJson(path,journal);continue;}throw e;}
      const session={...(claim.snapshot||snapshot),attempt:claim.snapshot?.attempt||claim.attempt||accepted,fence:claim.fence,generation:claim.generation??accepted.generation};
      const attempt={...accepted,instanceId,plan,manifest:snapshot.signedManifest?.manifest||snapshot.manifest,targetDigest:accepted.targetDigest};
      if(journal.circuitBroken){const result=await handleFault(session,Object.assign(Error(journal.faultCode),{code:journal.faultCode,faultEvidence:journal.detectedFault?.evidence,shared:journal.detectedFault?.shared===true,suppressRecovery:true}));const latest=await readJson(path);latest.faultRecordingComplete=true;latest.recoveryResult=result?.state||'fault-recorded-after-unknown';await atomicJson(path,latest);return {state:'ready-revoked',attemptId:accepted.attemptId,code:journal.faultCode};}
      let evidence,inspection;try{evidence=await executor.observe({attempt,fence:session.fence,weight:100});inspection=inspectObservation(evidence,plan.policy,Date.now(),journal.previousObservation||{});}catch(e){evidence={observedAt:new Date().toISOString(),observationUnavailable:true};inspection={fault:e.code||'OBSERVATION_UNREACHABLE',shared:true};}
      journal.previousObservation={consecutive:inspection.consecutive||0};journal.lastObservationAt=evidence.observedAt;journal.nextObservationAt=new Date(Date.now()+plan.policy.evaluationIntervalMs).toISOString();
      if(inspection.fault){
        // Persist the tripped circuit before invoking recovery. Unknown recovery is never retried.
        journal.circuitBroken=true;journal.faultCode=inspection.fault;journal.detectedFault={evidence,shared:inspection.shared===true};await atomicJson(path,journal);
        const result=await handleFault(session,Object.assign(Error(inspection.fault),{code:inspection.fault,faultEvidence:evidence,shared:inspection.shared}));
        const latest=await readJson(path);latest.faultRecordingComplete=true;latest.recoveryResult=result?.state||'recorded';await atomicJson(path,latest);return {state:'ready-revoked',attemptId:accepted.attemptId,code:inspection.fault};
      }
      await atomicJson(path,journal);onEvent?.({kind:'retention-observed',attemptId:accepted.attemptId,qualified:inspection.qualified});return {state:'retention-observed',attemptId:accepted.attemptId};
    }
    return {state:'idle'};
  }
  async function handleFault(session,error) {
    const id=session.attempt.attemptId;await coordinator.assertFence(id,session.fence);const fresh=await coordinator.snapshot(id);const attempt=fresh.attempt||fresh;const plan=fresh.plan;
    if(!plan)return;const actual=await executor.actual();const confirmed=attempt.state==='activation-confirmed';
    const base={fence:session.fence,generation:session.generation,expectedSequence:attempt.sequence,eventId:randomUUID()};
    const fault={code:error.code||'UPGRADE_FAILED',observedAt:new Date().toISOString(),actual,evidence:error.faultEvidence||null};
    const journalPath=join(root,'journals',id+'.json'),faultJournal=await readJson(journalPath,{});
    faultJournal.faultCommit ||= {...base,kind:confirmed?'ready-revoked':'failed',payload:{reason:fault.code,evidence:fault}};await atomicJson(journalPath,faultJournal);let stopped;
    try{stopped=await coordinator.commit(id,faultJournal.faultCommit);}catch(e){if(['UPGRADE_FENCE_EXPIRED','STALE_FENCE','LEASE_EXPIRED'].includes(e.code)){faultJournal.faultCommit={...faultJournal.faultCommit,...base,eventId:randomUUID()};await atomicJson(journalPath,faultJournal);}throw e;}
    faultJournal.faultCommitApplied=true;await atomicJson(journalPath,faultJournal);
    const envelopeAttempt={...attempt,plan,manifest:fresh.signedManifest?.manifest||fresh.manifest};
    if(error.suppressRecovery)return {state:'frozen-after-unknown-outcome'};
    if(error.shared)return {state:'frozen-shared-fault'};
    const monitorJournal=await readJson(join(root,'journals',id+'.json'),{});
    if(confirmed&&Date.now()-Date.parse(monitorJournal.confirmedAt||attempt.observedAt)>plan.policy.retentionMs)return {state:'recovery-needs-new-user-authorization'};
    const eligibility=await executor.fallbackEligibility({attempt:envelopeAttempt,fence:session.fence,fault});
    if(!qualifiedFallback(eligibility,{attempt:envelopeAttempt,fence:session.fence}))return {state:'frozen-no-qualified-fallback'};
    const recoveryPlan={schemaVersion:1,triggeringAttemptId:id,eligibilityDigest:digest(eligibility),api:eligibility.api||null,web:eligibility.web||null,coordinator:eligibility.coordinator||null,owner:eligibility.owner||null,componentScope:eligibility.componentScope,faultDigest:digest(fault)};
    recoveryPlan.planDigest=digest(recoveryPlan);
    const sequence=stopped.attempt?.sequence??stopped.sequence;const recovery=await coordinator.commit(id,{...base,expectedSequence:sequence,eventId:randomUUID(),kind:'recovery-started',payload:{recoveryAttemptId:randomUUID(),recoveryPlan,eligibility,reason:fault.code}});
    const recoveryFence=recovery.fence??recovery.snapshot?.fence??session.fence, generation=recovery.attempt?.generation??recovery.generation??session.generation;
    try {const applied=await executor.recover({attempt:envelopeAttempt,fence:recoveryFence,recoveryPlan});const continuity=await executor.observe({attempt:envelopeAttempt,fence:recoveryFence,weight:applied.weight});invariant(continuity.continuity?.qualified,'RECOVERY_UNCONFIRMED');return coordinator.commit(id,{fence:recoveryFence,generation,expectedSequence:recovery.attempt?.sequence??recovery.sequence,eventId:randomUUID(),kind:'recovery-confirmed',payload:{recoveryAttemptId:recovery.recovery?.recoveryAttemptId,actual:applied,continuity,eligibility}});}catch(recoveryError){await coordinator.commit(id,{fence:recoveryFence,generation,expectedSequence:recovery.attempt?.sequence??recovery.sequence,eventId:randomUUID(),kind:'recovery-failed',payload:{reason:recoveryError.code||'RECOVERY_UNKNOWN',actual:await executor.actual()}});return {state:'recovery-unknown'};}
  }
  return {runOnce,monitorOnce,async run(){while(!signal?.aborted){try{const result=await runOnce();if(result.state==='controller-handoff')return result;}catch(e){onEvent?.({kind:'controller-error',code:e.code||'UNKNOWN'});}await sleep(1000,signal).catch(()=>{});}},handleFault};
}
