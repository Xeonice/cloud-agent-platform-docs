import { canonical, digest, invariant, DIGEST } from './trust.mjs';
import { planCandidateRetirement } from './candidate-retirement.mjs';
import { REFERENCE_ATTEMPT_TERMINAL_STATES } from './candidate-reference-collector.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TARGET = ['instanceId', 'role', 'containerId', 'startIdentity', 'hostPid', 'startedAt', 'artifactDigest', 'attemptId'];
const same = (a, b) => canonical(a) === canonical(b);
const code = e => /^[A-Z][A-Z0-9_]{1,99}$/.test(e?.code || e?.message || '') ? e.code || e.message : 'NORMAL_RETIREMENT_UNKNOWN';
const object = x => x && Object.getPrototypeOf(x) === Object.prototype;
/** Persisted before either POST. A process restart or an expired lease cannot
 * reopen admission while an original drain/stop remains unfinished. A merely
 * prepared intent has sent no effect and may yield to existing business work. */
export function normalRetirementAdmissionBarrier(sqlite,instanceId) {
  if(!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_normal_retirements'").get())return null;
  const rows=sqlite.prepare("SELECT operation_id,state FROM control_normal_retirements WHERE instance_id=? AND state NOT IN ('applied','blocked','prepared') LIMIT 2").all(instanceId);
  invariant(rows.length<=1,'NORMAL_RETIREMENT_JOURNAL_CONFLICT');
  return rows.length?{operationId:rows[0].operation_id,state:rows[0].state}:null;
}
function operationId(value) {
  const hex = digest(value).slice(7, 39).split(''); hex[12] = '5'; hex[16] = 'a';
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].map(x=>x.join('')).join('-');
}

/** Private operator maintenance, serialized by the same global authority as
 * upgrades/recovery/contracts. It can retire only a physical participant of an
 * actual accepted terminal upgrade. Bootstrap/legacy sources are not invented
 * attempts. All physical termination stays behind the Supervisor boundary. */
export function createNormalRetirement({ sqlite, instanceId, executorId, store, authority, journal, participants, recoveryStore,
  references, participant, census, drain, supervisor, canRun = () => true, clock = Date.now }) {
  invariant(sqlite && store && authority && journal && participants && recoveryStore &&
    [references, participant, census, drain, supervisor, canRun].every(f=>typeof f==='function'), 'NORMAL_RETIREMENT_CONFIG_REQUIRED');
  sqlite.exec('CREATE TABLE IF NOT EXISTS control_normal_retirements(operation_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,intent TEXT NOT NULL,intent_digest TEXT NOT NULL,state TEXT NOT NULL,retirement_plan TEXT,result TEXT)');
  let live = null, closed = false;
  function read(id) {
    const row = sqlite.prepare('SELECT * FROM control_normal_retirements WHERE operation_id=? AND instance_id=?').get(id, instanceId);
    if (!row) return null;
    const intent = JSON.parse(row.intent);
    invariant(digest(intent) === row.intent_digest && intent.operationId === id && intent.instanceId === instanceId, 'NORMAL_RETIREMENT_INTENT_CORRUPT');
    const plan=row.retirement_plan ? JSON.parse(row.retirement_plan) : null;
    invariant(!plan || plan.qualified===true && plan.specDigest===digest(plan.spec) && plan.spec.kind==='retire-candidate' &&
      plan.spec.instanceId===instanceId && same(plan.spec.target,intent.target) && plan.spec.deadline===intent.deadline && same(plan.spec.budget,intent.budget),
    'NORMAL_RETIREMENT_PLAN_CORRUPT');
    return { operationId:id, instanceId, intent, intentDigest:row.intent_digest, state:row.state,
      retirementPlan:plan, result:row.result ? JSON.parse(row.result) : null };
  }
  function save(row, state, result = row.result, plan = row.retirementPlan) {
    sqlite.prepare('UPDATE control_normal_retirements SET state=?,retirement_plan=?,result=? WHERE operation_id=? AND instance_id=? AND intent_digest=?')
      .run(state, plan ? canonical(plan) : null, result ? canonical(result) : null, row.operationId, instanceId, row.intentDigest);
    return read(row.operationId);
  }
  function submit(body) {
    invariant(!closed && object(body) && ['acceptedUpgradeId','target'].every(k=>Object.hasOwn(body,k)) &&
      Object.keys(body).every(k=>['acceptedUpgradeId','target','requestId'].includes(k)) && (body.requestId===undefined||UUID.test(body.requestId)) && UUID.test(body.acceptedUpgradeId) &&
      object(body.target) && Object.keys(body.target).sort().join() === [...TARGET].sort().join() && body.target.instanceId === instanceId &&
      ['api','coordinator','web','installer'].includes(body.target.role) && /^[a-f0-9]{64}$/.test(body.target.containerId) &&
      typeof body.target.startIdentity === 'string' && body.target.startIdentity.length >= 16 && Number.isSafeInteger(body.target.hostPid) && body.target.hostPid > 1 &&
      Number.isFinite(Date.parse(body.target.startedAt)) && DIGEST.test(body.target.artifactDigest) && body.target.attemptId === body.acceptedUpgradeId,
    'NORMAL_RETIREMENT_TARGET_INVALID');
    return sqlite.transaction(()=>{
      const snapshot = store.snapshot(body.acceptedUpgradeId);
      invariant(snapshot.attempt.instanceId === instanceId && snapshot.attempt.attemptId === body.acceptedUpgradeId &&
        REFERENCE_ATTEMPT_TERMINAL_STATES.includes(snapshot.attempt.state) && DIGEST.test(snapshot.plan.planDigest) &&
        snapshot.manifest.components[body.target.role]?.artifactDigest === body.target.artifactDigest,
      'NORMAL_RETIREMENT_ACCEPTED_PLAN_REQUIRED');
      const requestId=body.requestId??body.acceptedUpgradeId;
      const id = operationId({ instanceId, requestId, acceptedUpgradeId:body.acceptedUpgradeId, acceptedPlanDigest:snapshot.plan.planDigest, target:body.target });
      const prior = read(id); if (prior) return prior;
      invariant(!active()&&!blocking(), 'NORMAL_RETIREMENT_ALREADY_PENDING');
      const intent = { schemaVersion:1, kind:'normal-retirement', instanceId, operationId:id, requestId, acceptedUpgradeId:body.acceptedUpgradeId,
        acceptedPlanDigest:snapshot.plan.planDigest, target:structuredClone(body.target), deadline:clock()+120000, budget:{maxDurationMs:120000} };
      sqlite.prepare("INSERT INTO control_normal_retirements VALUES(?,?,?,?,'prepared',NULL,NULL)").run(id, instanceId, canonical(intent), digest(intent));
      return read(id);
    }).immediate();
  }
  function active() {
    const rows = sqlite.prepare("SELECT operation_id FROM control_normal_retirements WHERE instance_id=? AND state NOT IN ('applied','blocked','expired-unknown') ORDER BY rowid LIMIT 2").all(instanceId);
    invariant(rows.length <= 1, 'NORMAL_RETIREMENT_JOURNAL_CONFLICT');
    return rows.length ? read(rows[0].operation_id) : null;
  }
  function blocking() {
    const rows=sqlite.prepare("SELECT operation_id FROM control_normal_retirements WHERE instance_id=? AND state='expired-unknown' LIMIT 2").all(instanceId);
    invariant(rows.length<=1,'NORMAL_RETIREMENT_JOURNAL_CONFLICT');return rows.length?read(rows[0].operation_id):null;
  }
  const auth = scope => ({ operationId:scope.operationId, epoch:scope.epoch, executorId:scope.holderId, expiresAt:scope.leaseExpiresAt, kind:'maintenance' });
  function claim(row,readOnly=false) {
    return sqlite.transaction(()=>{
      invariant(canRun() && !recoveryStore.active(), 'NORMAL_RETIREMENT_BUSY');
      const pending = journal.pending();
      invariant(pending.every(v=>v.operationId===row.operationId), 'NORMAL_RETIREMENT_COMMAND_PENDING');
      let current = authority.observe();
      if (current.kind === 'upgrade' && current.holderId && current.leaseExpiresAt > clock() && pending.length === 0 &&
        REFERENCE_ATTEMPT_TERMINAL_STATES.includes(store.snapshot(current.operationId).attempt.state)) {
        authority.release({operationId:current.operationId,epoch:current.epoch,executorId:current.holderId}); current=authority.observe();
      }
      if (current.kind === 'maintenance' && current.operationId === row.operationId && current.holderId === executorId && current.leaseExpiresAt > clock())
        return authority.renew({operationId:row.operationId,epoch:current.epoch,executorId,leaseMs:readOnly?5000:30000});
      invariant(!current.holderId || current.leaseExpiresAt <= clock(), 'NORMAL_RETIREMENT_BUSY');
      const pendingUpgrades=store.pending();
      invariant(pendingUpgrades?.instanceId===instanceId && Array.isArray(pendingUpgrades.attempts) && (readOnly||pendingUpgrades.attempts.length===0),
        'NORMAL_RETIREMENT_UPGRADE_PENDING');
      return authority.grant({operationId:row.operationId,epoch:current.epoch+1,executorId,leaseMs:readOnly?5000:30000,kind:'maintenance'});
    }).immediate();
  }
  function check(row, scope) { return authority.assert({operationId:row.operationId,epoch:scope.epoch,executorId,kind:'maintenance'}); }
  function release(row, scope) {
    if (!['applied','blocked'].includes(row.state) || journal.pending().some(v=>v.operationId===row.operationId)) return;
    authority.release({operationId:row.operationId,epoch:scope.epoch,executorId});
  }
  function eligible(row, state, allowWorkers=false) {
    const copy=structuredClone(state); if (allowWorkers && copy.references) copy.references.workers=0;
    return planCandidateRetirement({instanceId,target:row.intent.target,state:copy,deadline:row.intent.deadline,budget:row.intent.budget,maxObservationAgeMs:5000,now:clock()});
  }
  function command(row, scope) {
    invariant(row.retirementPlan?.qualified === true, 'NORMAL_RETIREMENT_PLAN_REQUIRED');
    return {operationId:row.operationId,commandId:row.operationId+':retire',stepId:'retire-candidate',spec:row.retirementPlan.spec,authorization:auth(scope)};
  }
  function acceptRetirement(row, response) {
    const commandId=row.operationId+':retire';
    invariant(response && response.operationId===row.operationId && response.commandId===commandId && response.specDigest===row.retirementPlan.specDigest,
      'NORMAL_RETIREMENT_RECEIPT_SCOPE_UNKNOWN');
    if(response.state==='blocked' && response.result?.dispatched===false)return save(row,'blocked',response.result);
    if(response.state==='definitely-not-applied' && response.result?.definitelyNotApplied===true)return save(row,'blocked',{code:'NORMAL_RETIREMENT_PROVEN_NOT_APPLIED'});
    if(response.state!=='applied')return row;
    const r=response.result;
    invariant(r?.instanceId===instanceId && r.operationId===row.operationId && r.commandId===commandId && r.specDigest===row.retirementPlan.specDigest && same(r.target,row.intent.target) &&
      r.normalExit===true && r.signal==='SIGTERM' && r.forced===false && r.removed===false && r.volumesRemoved===false && r.exit?.running===false && r.exit.hostPid===0 && r.exit.oomKilled===false && [0,143].includes(r.exit.exitCode),
    'NORMAL_RETIREMENT_NORMAL_EXIT_UNKNOWN');
    return save(row,'applied',r);
  }
  function expire(row) {
    const pendingDrain=journal.lookup({operationId:row.operationId,commandId:row.operationId+':drain'});
    const known=row.state==='prepared'||row.state==='retire-prepared'||row.state==='draining'||row.state==='drain-dispatched'&&pendingDrain?.state==='applied';
    const expired=save(row,known?'blocked':'expired-unknown',row.result??{code:'NORMAL_RETIREMENT_DEADLINE_EXPIRED'});
    const scope=authority.observe();
    // Ending a lease does not resolve the old command. Its original receipt
    // and the Supervisor's physical barrier stay intact for explicit lookup.
    if(scope.operationId===row.operationId&&scope.kind==='maintenance'&&scope.holderId===executorId&&scope.leaseExpiresAt>clock())
      authority.release({operationId:row.operationId,epoch:scope.epoch,executorId});
    return expired;
  }
  async function perform(id,readOnly=false) {
    let row=read(id); invariant(row,'NORMAL_RETIREMENT_NOT_FOUND');
    if(['applied','blocked'].includes(row.state))return row;
    if(!readOnly&&row.intent.deadline<=clock())return expire(row);
    invariant(!readOnly||row.state==='expired-unknown','NORMAL_RETIREMENT_RECONCILIATION_REQUIRED');
    let scope;
    try { scope=claim(row,readOnly); } catch(error) { return {...row,reason:code(error)}; }
    try {
      await participants.admit(scope);
      check(row,scope);
      if(readOnly) {
        if(row.retirementPlan)return acceptRetirement(row,await supervisor('/command-result',{operationId:row.operationId,commandId:row.operationId+':retire'}));
        const observed=await census(row.result.participant);check(row,scope);
        invariant(observed?.instanceId===instanceId&&observed.startIdentity===row.intent.target.startIdentity&&observed.artifactDigest===row.intent.target.artifactDigest&&
          clock()>=Date.parse(observed.observedAt)&&clock()-Date.parse(observed.observedAt)<=5000&&observed.drain?.operationId===row.operationId&&
          observed.drain.intentDigest===row.intentDigest&&observed.drain.admissionClosed===true,'NORMAL_RETIREMENT_DRAIN_UNKNOWN');
        journal.record({operationId:row.operationId,commandId:row.operationId+':drain',authorization:auth(scope),state:'applied',result:{operationId:row.operationId,intentDigest:row.intentDigest,admissionClosed:true}});
        return save(row,'blocked',{...row.result,code:'NORMAL_RETIREMENT_DRAIN_PROVEN_NO_STOP_DISPATCHED'});
      }
      if(row.state==='prepared') {
        if(row.intent.deadline<=clock())return save(row,'blocked',{code:'NORMAL_RETIREMENT_DEADLINE_EXPIRED'});
        const state=await references(row.intent.target), plan=eligible(row,state,row.intent.target.role==='coordinator');
        if(!plan.qualified) {
          if(plan.reason==='RETIREMENT_AUTHORITY_NOT_RELEASED')return {...row,reason:plan.reason};
          return save(row,'blocked',{code:plan.reason});
        }
        if(row.intent.target.role!=='coordinator')return save(row,'retire-prepared',null,eligible(row,state));
        const actual=await participant(row.intent.target); check(row,scope);
        invariant(actual && actual.startIdentity===row.intent.target.startIdentity && actual.artifactDigest===row.intent.target.artifactDigest &&
          actual.physical?.containerId===row.intent.target.containerId && actual.physical.hostPid===row.intent.target.hostPid && actual.physical.startedAt===row.intent.target.startedAt,
        'NORMAL_RETIREMENT_PARTICIPANT_CHANGED');
        const currentCensus=await census(actual);check(row,scope);
        invariant(currentCensus?.instanceId===instanceId&&currentCensus.startIdentity===row.intent.target.startIdentity&&currentCensus.artifactDigest===row.intent.target.artifactDigest&&
          clock()>=Date.parse(currentCensus.observedAt)&&clock()-Date.parse(currentCensus.observedAt)<=5000,'NORMAL_RETIREMENT_CENSUS_UNKNOWN');
        if(currentCensus?.drain?.admissionClosed===true&&currentCensus.drain.settled===true) {
          const previous=read(currentCensus.drain.operationId), previousCommand=previous&&journal.lookup({operationId:previous.operationId,commandId:previous.operationId+':drain'});
          invariant(previous&&previous.intentDigest===currentCensus.drain.intentDigest&&same(previous.intent.target,row.intent.target)&&previousCommand?.state==='applied',
            'NORMAL_RETIREMENT_PREVIOUS_DRAIN_UNKNOWN');
          const plan=eligible(row,await references(row.intent.target));invariant(plan.qualified,plan.reason||'NORMAL_RETIREMENT_REFERENCED');
          return save(row,'retire-prepared',null,plan);
        }
        const spec={schemaVersion:1,kind:'normal-retirement-drain',instanceId,intentDigest:row.intentDigest,target:row.intent.target,deadline:row.intent.deadline,budget:row.intent.budget};
        const key={operationId:row.operationId,commandId:row.operationId+':drain'}, input={...key,stepId:'normal-retirement-drain',spec,authorization:auth(scope)};
        journal.prepare(input); journal.begin(input);
        row=save(row,'drain-dispatched',{participant:actual});
        // State is durable before POST. A timeout is never permission to POST again.
        await drain(actual,{schemaVersion:1,instanceId,operationId:row.operationId,epoch:scope.epoch,executorId,target:{startIdentity:row.intent.target.startIdentity,artifactDigest:row.intent.target.artifactDigest},intentDigest:row.intentDigest});
        return row;
      }
      if(['drain-dispatched','draining'].includes(row.state)) {
        const observed=await census(row.result.participant); check(row,scope);
        invariant(observed?.instanceId===instanceId && observed.startIdentity===row.intent.target.startIdentity && observed.artifactDigest===row.intent.target.artifactDigest &&
          clock()>=Date.parse(observed.observedAt)&&clock()-Date.parse(observed.observedAt)<=5000 && observed.drain?.operationId===row.operationId && observed.drain.intentDigest===row.intentDigest && observed.drain.admissionClosed===true,
        'NORMAL_RETIREMENT_DRAIN_UNKNOWN');
        const key={operationId:row.operationId,commandId:row.operationId+':drain'};
        const receipt={operationId:row.operationId,intentDigest:row.intentDigest,admissionClosed:true};
        journal.record({...key,authorization:auth(scope),state:'applied',result:receipt});
        if(observed.drain.settled!==true)return save(row,'draining');
        const state=await references(row.intent.target), plan=eligible(row,state); check(row,scope);
        if(!plan.qualified) return {...save(row,'draining'),reason:plan.reason};
        return save(row,'retire-prepared',row.result,plan);
      }
      if(row.state==='retire-prepared') {
        invariant(row.intent.deadline>clock(),'NORMAL_RETIREMENT_DEADLINE_EXPIRED');
        check(row,scope); row=save(row,'retire-dispatched');
        // The Supervisor owns this physical command journal. No second parent
        // command is introduced which would become a reference to itself.
        const cmd=command(row,scope);
        return acceptRetirement(row,await supervisor('/retire-candidate',{command:cmd,plan:row.retirementPlan}));
      }
      invariant(row.state==='retire-dispatched','NORMAL_RETIREMENT_STATE_UNKNOWN');
      return acceptRetirement(row,await supervisor('/command-result',{operationId:row.operationId,commandId:row.operationId+':retire'}));
    } catch(error) {
      row=read(id);
      if(row.state==='prepared')row=save(row,'blocked',{code:code(error)});
      return {...row,reason:code(error)};
    } finally {
      row=read(id);
      if(readOnly) {
        const current=authority.observe();if(current.kind==='maintenance'&&current.operationId===row.operationId&&current.holderId===executorId&&current.leaseExpiresAt>clock())
          authority.release({operationId:row.operationId,epoch:current.epoch,executorId});
      } else release(row,scope);
    }
  }
  async function advance(id,readOnly=false) {
    invariant(!closed,'NORMAL_RETIREMENT_CLOSED');
    if(live)return {...read(id),reason:'NORMAL_RETIREMENT_BUSY'};
    live=Promise.resolve().then(()=>perform(id,readOnly));
    try{return await live;}finally{live=null;}
  }
  return {submit,read,active,blocking,advance,reconcile:id=>advance(id,true),pending:()=>!!live,async close(){closed=true;await live;}};
}
