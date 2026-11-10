import { invariant, canonical, digest } from './trust.mjs';
export function inspectObservation(observation,policy,now=Date.now(),previous={}) {
  invariant(observation&&Number.isFinite(Date.parse(observation.observedAt)),'OBSERVATION_UNKNOWN');
  if(now-Date.parse(observation.observedAt)>policy.observationFreshnessMs||Date.parse(observation.observedAt)>now+1000)return {qualified:false,fault:'OBSERVATION_STALE'};
  if(observation.fenceValid!==true||observation.ownerGenerationsValid!==true||observation.routeGenerationValid!==true)return {qualified:false,fault:'CONTROL_OR_OWNERSHIP_UNKNOWN'};
  const hard=observation.invariants;
  if(!hard||['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].some(k=>typeof hard[k]!=='number'))return {qualified:false,fault:'INVARIANT_EVIDENCE_MISSING'};
  if(Object.values(hard).some(x=>x!==0))return {qualified:false,fault:'HARD_INVARIANT_VIOLATION'};
  if(observation.sharedStateHealthy!==true||observation.continuity?.qualified!==true)return {qualified:false,fault:'SHARED_STATE_OR_CONTINUITY_UNKNOWN',shared:true};
  // Confirmed component faults remain actionable while another lane is still
  // gathering a fresh window. Missing traffic proof cannot hide a dead Web/API.
  if(observation.web?.qualified===false)return {qualified:false,fault:'WEB_UNHEALTHY',componentScope:['web']};
  const p=observation.probes,cp=observation.candidateProbes;
  const emptyProbe=lane=>lane?.known===false&&lane.samples===0&&lane.failures===0&&lane.maxLatencyMs===null&&lane.windowMs===0;
  const hardProbe=(lane,attach=false)=>!lane||typeof lane.failures!=='number'||lane.failures!==0||(!Number.isFinite(lane.maxLatencyMs)&&!emptyProbe(lane))||(Number.isFinite(lane.maxLatencyMs)&&lane.maxLatencyMs>policy.requestDeadlineMs)||(attach&&(!Number.isFinite(lane.attachMaxMs)&&!(emptyProbe(lane)&&lane.attachMaxMs===null)||Number.isFinite(lane.attachMaxMs)&&lane.attachMaxMs>policy.attachDeadlineMs));
  if(hardProbe(p,true)||(cp!==undefined&&hardProbe(cp)))return {qualified:false,fault:'SLO_PROBE_FAILED'};
  for(const lane of [p,...(cp===undefined?[]:[cp])]) {
    const span=lane.windowMs??observation.windowMs;
    if(lane.known!==false&&Number.isFinite(span)&&span>=policy.stageDurationMs&&(!Number.isFinite(lane.hz)||lane.hz<policy.probeHz))return {qualified:false,fault:'SLO_PROBE_FAILED'};
  }
  const stats=observation.candidate,baseline=observation.baseline;
  if(!stats||!baseline||!Number.isFinite(stats.requests)||stats.requests<0||!Number.isFinite(observation.windowMs))return {qualified:false,fault:'TRAFFIC_EVIDENCE_MISSING'};
  const enough=p.known!==false&&stats.known!==false&&baseline.known!==false&&baseline.qualified!==false&&
    stats.requests>=policy.minRequests&&observation.windowMs>=policy.stageDurationMs&&
    p.samples>=policy.probeHz*policy.stageDurationMs/1000&&
    (baseline.known===undefined||(Number.isFinite(baseline.requests)&&baseline.requests>=policy.minRequests&&baseline.windowMs>=policy.stageDurationMs))&&
    (stats.known===undefined||stats.windowMs>=policy.stageDurationMs)&&(p.known===undefined||p.windowMs>=policy.stageDurationMs)&&
    (cp===undefined||(cp.known===true&&cp.samples>=policy.probeHz*policy.stageDurationMs/1000&&cp.windowMs>=policy.stageDurationMs));
  // An incomplete new epoch/route cannot advance or accrue soft-failure votes.
  // Unknown percentiles stay null in the evidence; do not manufacture zeros.
  if(!enough)return {qualified:false,pending:true,consecutive:0,completedWork:Math.min(stats.requests,policy.minRequests),receiptDigest:digest(observation)};
  if(![stats.errorRate,stats.p95Ms,baseline.errorRate,baseline.p95Ms].every(Number.isFinite))return {qualified:false,fault:'TRAFFIC_EVIDENCE_MISSING'};
  const worse=stats.errorRate-baseline.errorRate>policy.softErrorDelta||(stats.p95Ms>baseline.p95Ms*policy.p95Ratio&&stats.p95Ms>policy.p95FloorMs);
  const consecutive=worse?(previous.consecutive||0)+1:0;
  if(consecutive>=policy.consecutiveEvaluations)return {qualified:false,fault:'SOFT_TRAFFIC_DEGRADATION',consecutive};
  return {qualified:!worse,pending:worse,consecutive,completedWork:Math.min(stats.requests,policy.minRequests),receiptDigest:digest(observation)};
}
export function qualifiedFallback(value,{attempt,fence,now=Date.now()}) {
  if(!value||value.qualified!==true||value.fence!==fence||value.instanceId!==attempt.instanceId||value.migrationCommitKnown!==true||value.sharedStateHealthy!==true||value.observedAt===undefined||!Number.isFinite(Date.parse(value.observedAt))||Date.parse(value.observedAt)>now+1000||now-Date.parse(value.observedAt)>attempt.plan.policy.observationFreshnessMs)return false;
  const checks=['artifactImmutable','healthy','capacitySufficient','latestDatabaseCompatible','newWritesCompatible','loadedWebCompatible','allOwnersCompatible','coordinatorCompatible','authContinuous','originalResourcesAddressable','dedupCancellationCursorPreserved'];
  if(!checks.every(k=>value[k]===true))return false;
  const rehearsed=Boolean(value.rehearsalDigest)&&value.currentDataEpoch!==undefined;
  if(canonical(value.componentScope||[])==='["web"]'){
    const anchor=value.fallbackPolicyAnchor;
    return Boolean(rehearsed&&anchor&&attempt.plan.policy.fallbacks.some(f=>f.releaseId===anchor.releaseId&&f.apiDigest===anchor.apiDigest&&f.webDigest===anchor.webDigest)&&value.apiDigest===attempt.manifest?.components.api.artifactDigest&&value.webDigest===anchor.webDigest&&value.api===null&&value.coordinator===null&&value.owner===null&&value.web?.digest===anchor.webDigest);
  }
  return attempt.plan.policy.fallbacks.some(f=>f.releaseId===value.releaseId&&f.apiDigest===value.apiDigest&&f.webDigest===value.webDigest)&&rehearsed;
}
