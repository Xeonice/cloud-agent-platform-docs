import { invariant, canonical, digest } from './trust.mjs';
export function inspectObservation(observation,policy,now=Date.now(),previous={}) {
  invariant(observation&&Number.isFinite(Date.parse(observation.observedAt)),'OBSERVATION_UNKNOWN');
  if(now-Date.parse(observation.observedAt)>policy.observationFreshnessMs||Date.parse(observation.observedAt)>now+1000)return {qualified:false,fault:'OBSERVATION_STALE'};
  if(observation.fenceValid!==true||observation.ownerGenerationsValid!==true||observation.routeGenerationValid!==true)return {qualified:false,fault:'CONTROL_OR_OWNERSHIP_UNKNOWN'};
  const hard=observation.invariants;
  if(!hard||['unauthorizedStops','resourceRebuilds','duplicateCommands','duplicateOccurrences','writerConflicts','migrationDifferences','integrityFailures'].some(k=>typeof hard[k]!=='number'))return {qualified:false,fault:'INVARIANT_EVIDENCE_MISSING'};
  if(Object.values(hard).some(x=>x!==0))return {qualified:false,fault:'HARD_INVARIANT_VIOLATION'};
  if(observation.sharedStateHealthy!==true||observation.continuity?.qualified!==true)return {qualified:false,fault:'SHARED_STATE_OR_CONTINUITY_UNKNOWN',shared:true};
  const p=observation.probes;
  if(!p||p.hz<policy.probeHz||p.failures!==0||p.maxLatencyMs>policy.requestDeadlineMs||p.attachMaxMs>policy.attachDeadlineMs)return {qualified:false,fault:'SLO_PROBE_FAILED'};
  const stats=observation.candidate,baseline=observation.baseline;
  if(!stats||!baseline||![stats.requests,stats.errorRate,stats.p95Ms,baseline.errorRate,baseline.p95Ms,observation.windowMs].every(Number.isFinite))return {qualified:false,fault:'TRAFFIC_EVIDENCE_MISSING'};
  const worse=stats.errorRate-baseline.errorRate>policy.softErrorDelta||(stats.p95Ms>baseline.p95Ms*policy.p95Ratio&&stats.p95Ms>policy.p95FloorMs);
  const consecutive=worse?(previous.consecutive||0)+1:0;
  if(consecutive>=policy.consecutiveEvaluations)return {qualified:false,fault:'SOFT_TRAFFIC_DEGRADATION',consecutive};
  const enough=stats.requests>=policy.minRequests&&observation.windowMs>=policy.stageDurationMs&&p.samples>=policy.probeHz*policy.stageDurationMs/1000;
  return {qualified:enough&&!worse,pending:!enough||worse,consecutive,completedWork:Math.min(stats.requests,policy.minRequests),receiptDigest:digest(observation)};
}
export function qualifiedFallback(value,{attempt,fence,now=Date.now()}) {
  if(!value||value.qualified!==true||value.fence!==fence||value.instanceId!==attempt.instanceId||value.migrationCommitKnown!==true||value.sharedStateHealthy!==true||value.observedAt===undefined||!Number.isFinite(Date.parse(value.observedAt))||Date.parse(value.observedAt)>now+1000||now-Date.parse(value.observedAt)>attempt.plan.policy.observationFreshnessMs)return false;
  const checks=['artifactImmutable','healthy','capacitySufficient','latestDatabaseCompatible','newWritesCompatible','loadedWebCompatible','allOwnersCompatible','coordinatorCompatible','authContinuous','originalResourcesAddressable','dedupCancellationCursorPreserved'];
  if(!checks.every(k=>value[k]===true))return false;
  return attempt.plan.policy.fallbacks.some(f=>f.releaseId===value.releaseId&&f.apiDigest===value.apiDigest&&f.webDigest===value.webDigest)&&value.rehearsalDigest&&value.currentDataEpoch!==undefined;
}
