import { isAbsolute, join } from 'node:path';
import { lstat, realpath, chmod } from 'node:fs/promises';
import { secureDirectory } from './io.mjs';
import { invariant, digest, canonical } from './trust.mjs';
import { readSupervisorFact } from './supervisor-control.mjs';
import { createControlCapacityCollector, createCapacityStartBookkeeper, createCapacityMaintenanceBookkeeper, createCapacityRetirementBookkeeper } from './control-capacity-collector.mjs';
import { evaluateCapacityAdmission } from './capacity-admission.mjs';
import { createControlMaintenance } from './control-maintenance.mjs';
import { createAttemptCapacityReservations, terminalCapacityReservationProof } from './capacity-reservation.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,180}$/;
const keys = (value, required) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
const reason = error => /^[A-Z0-9_]{1,100}$/.test(error?.code || error?.message || '') ? error.code || error.message : 'SUPERVISOR_RUNTIME_UNKNOWN';

/** This is the single capacity publisher in the Supervisor process. Reading
 * plan/config on every turn is intentional: physical starts consume their
 * existing reservation and publish a new resident set without rewriting the
 * original command. A queued operation never dispatches a physical process. */
export async function createSupervisorControlRuntime({ instanceId, config, supervisor, Database, lifecycle = null, clock = Date.now, sample, monotonic, intervalMs = 750 }) {
  invariant(ID.test(instanceId) && supervisor?.assembly?.sqlite && supervisor.journal && [config.capacityPlanPath, config.capacityCollectorConfigPath, config.capacityTransitionRoot, config.resourceObservationPath].every(path => typeof path === 'string' && isAbsolute(path)) &&
    Number.isSafeInteger(intervalMs) && intervalMs >= 500 && intervalMs <= 2000, 'SUPERVISOR_CAPACITY_RUNTIME_CONFIG_INVALID');
  invariant(Database,'SUPERVISOR_PUBLICATION_DATABASE_REQUIRED');
  const publicationRoot=await secureDirectory(config.capacityTransitionRoot),publicationPath=join(publicationRoot,'capacity-publication.db');
  const publicationStat=await lstat(publicationPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  invariant(!publicationStat||publicationStat.isFile()&&!publicationStat.isSymbolicLink()&&(publicationStat.mode&0o077)===0,'SUPERVISOR_PUBLICATION_DATABASE_INSECURE');
  // This mutex database has no authority/journal tables. Sampling cannot take
  // the ordinary Supervisor admission/command writer lock for 250ms or longer.
  const publicationDb=new Database(publicationPath);await chmod(publicationPath,0o600);publicationDb.pragma('busy_timeout=50');
  invariant(publicationDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().every(row=>row.name==='publication_mutex'),'SUPERVISOR_PUBLICATION_DATABASE_SCOPE_INVALID');
  publicationDb.exec('CREATE TABLE IF NOT EXISTS publication_mutex(singleton INTEGER PRIMARY KEY CHECK(singleton=1))');
  const publicationLock={acquire:()=>publicationDb.exec('BEGIN IMMEDIATE'),release:()=>publicationDb.exec('COMMIT')};
  let queue = Promise.resolve(), closed = false, collectorPending = false, lastCollection = null;
  const jobs = new Map(), failures = new Map();
  function serial(work) {
    invariant(!closed, 'SUPERVISOR_RUNTIME_CLOSED');
    const task = queue.then(work); queue = task.catch(() => {}); return task;
  }
  async function readCapacity() {
    const [plan, collector] = await Promise.all([readSupervisorFact(config.capacityPlanPath, 1048576), readSupervisorFact(config.capacityCollectorConfigPath, 1048576)]);
    invariant(plan.value.instanceId === instanceId && collector.value.instanceId === instanceId && collector.value.observationPath === config.resourceObservationPath && collector.value.sourceDigest === plan.value.sourceDigest, 'SUPERVISOR_CAPACITY_RUNTIME_SCOPE_CHANGED');
    return { plan, collector };
  }
  async function collectNow() {
    const { plan, collector } = await readCapacity(), previous = await readSupervisorFact(config.resourceObservationPath, 1048576).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const value = await createControlCapacityCollector({ config: collector.value, clock, publicationLock, ...(sample ? { sample } : {}), ...(monotonic ? { monotonic } : {}) }).collect({ plan: plan.value, expectedRevision: previous?.value.revision ?? 0 });
    // A replan outside our serial queue can only turn this result into unknown;
    // it cannot make an observation of the former resident set authorize work.
    const current = await readCapacity();
    invariant(current.plan.digest === plan.digest && current.collector.digest === collector.digest, 'SUPERVISOR_CAPACITY_RUNTIME_CHANGED');
    lastCollection = value; return value;
  }
  const options = { instanceId, planPath: config.capacityPlanPath, configPath: config.capacityCollectorConfigPath, transitionRoot: config.capacityTransitionRoot, clock, publicationLock, ...(sample ? { sample } : {}) };
  const starts = createCapacityStartBookkeeper({ ...options, journal: supervisor.journal }), retirements=createCapacityRetirementBookkeeper({...options,journal:supervisor.journal});
  let reservationLedger=null;
  if(config.capacityTemplates){const stat=await lstat(config.controlDbPath);invariant(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&await realpath(config.controlDbPath)===config.controlDbPath,'SUPERVISOR_CAPACITY_LEDGER_INSECURE');reservationLedger=new Database(config.controlDbPath,{readonly:true,fileMustExist:true});reservationLedger.pragma('query_only=ON');reservationLedger.pragma('busy_timeout=0');}
  const reservations=config.capacityTemplates?createAttemptCapacityReservations({sqlite:supervisor.assembly.sqlite,instanceId,templates:config.capacityTemplates,planPath:config.capacityPlanPath,configPath:config.capacityCollectorConfigPath,clock,publicationLock,terminalProof:input=>terminalCapacityReservationProof({controlSqlite:reservationLedger,supervisorSqlite:supervisor.assembly.sqlite,instanceId,...input,now:clock()})}):null;
  async function appliedStart(row) {
    if (row?.state !== 'applied' || !['supervisor-start','retire-candidate'].includes(row.spec?.kind)) return row;
    return serial(async () => {
      await (row.spec.kind==='retire-candidate'?retirements:starts).register({ operationId: row.operationId, commandId: row.commandId });
      supervisor.completeCapacityStart({ operationId: row.operationId, commandId: row.commandId, specDigest: row.specDigest });
      await collectNow(); return row;
    });
  }
  let maintenance = null, controlSqlite = null, maintenanceBookkeeper = null;
  if (config.maintenance) {
    invariant(Database && lifecycle && config.maintenanceKey?.length >= 32 && config.maintenanceKey !== config.key && config.maintenanceKey !== config.accessKey && keys(config.maintenance, ['executorId', 'packages', 'capacityAllocation']) && ID.test(config.maintenance.executorId), 'SUPERVISOR_MAINTENANCE_RUNTIME_CONFIG_INVALID');
    // Database files are checked by Maintenance's inode/birth guard, not parsed
    // as JSON. Open existing only; this path can never create a replacement DB.
    const ledger = await lstat(config.controlDbPath);
    invariant(ledger.isFile() && !ledger.isSymbolicLink() && (ledger.mode & 0o077) === 0 && await realpath(config.controlDbPath) === config.controlDbPath, 'CONTROL_MAINTENANCE_LEDGER_INSECURE');
    controlSqlite = new Database(config.controlDbPath, { fileMustExist: true });
    try {
      const capacity = input => serial(async () => {
        const { plan, collector } = await readCapacity();
        const allocation = plan.value.allocations.control.filter(row => row.id === input.allocationId);
        invariant(allocation.length === 1 && canonical(allocation[0].resources) === canonical(input.resources), 'SUPERVISOR_MAINTENANCE_ALLOCATION_CHANGED');
        const scope = { instanceId, maintenanceId: input.maintenanceId, commandId: input.commandId, specDigest: input.specDigest, action: input.action, requestDigest: digest(input) };
        if (['release-stopped', 'bind-started'].includes(input.action)) {
          const receipt = await maintenanceBookkeeper.register({ operationId: input.maintenanceId, commandId: input.commandId });
          await collectNow(); return { ...scope, planDigest: receipt.planDigest, configDigest: receipt.configDigest };
        }
        invariant(input.action === 'admit-start' && allocation[0].resident === false, 'SUPERVISOR_MAINTENANCE_CAPACITY_SCOPE_INVALID');
        const observation = await collectNow(), current = await readCapacity();
        invariant(current.plan.digest === plan.digest && current.collector.digest === collector.digest, 'SUPERVISOR_MAINTENANCE_CAPACITY_CHANGED');
        const admission = evaluateCapacityAdmission({ plan: current.plan.value, observation, now: clock() });
        invariant(admission.qualified, admission.reason || 'SUPERVISOR_MAINTENANCE_CAPACITY_UNKNOWN');
        return { ...scope, ...admission, configDigest: digest(current.collector.value), resourcesDigest: digest(input.resources) };
      });
      maintenance = createControlMaintenance({ sqlite: supervisor.assembly.sqlite, controlSqlite, controlDbPath: config.controlDbPath, instanceId,
        ...config.maintenance, lifecycle: { ...lifecycle, capacity }, clock });
      maintenanceBookkeeper = createCapacityMaintenanceBookkeeper({ ...options, journal: { lookup: ({ operationId, commandId }) => maintenance.readAction(operationId, commandId) } });
    } catch (error) { controlSqlite.close(); throw error; }
  }
  const state = id => {
    const row = maintenance?.read(id) ?? null, pending = jobs.has(id), fault = failures.get(id);
    return { instanceId, maintenanceId: id, durable: !!row, pending, state: row?.phase ?? (pending ? 'validating' : 'not-found'), ...(row ? { record: row } : {}), ...(fault ? { reason: fault } : {}) };
  };
  function maintenanceRequest(action, input) {
    invariant(maintenance && ['submit', 'advance', 'status'].includes(action), 'SUPERVISOR_MAINTENANCE_UNAVAILABLE');
    invariant(ID.test(input?.maintenanceId), 'CONTROL_MAINTENANCE_ID_INVALID');
    if (action !== 'submit') invariant(keys(input, ['maintenanceId']), 'SUPERVISOR_MAINTENANCE_REQUEST_INVALID');
    else invariant(Object.keys(input).every(key => ['maintenanceId', 'expectedControlEpoch', 'sourceAgent', 'deadline', 'rollbackDeadline', 'initialPassive'].includes(key)), 'SUPERVISOR_MAINTENANCE_REQUEST_INVALID');
    const id = input.maintenanceId;
    if (action === 'status') return state(id);
    const requestDigest = digest({ action, input }), running = jobs.get(id);
    if (running) { invariant(running.action !== 'submit' || action !== 'submit' || running.requestDigest === requestDigest, 'CONTROL_MAINTENANCE_SPEC_CONFLICT'); return state(id); }
    invariant(jobs.size < 16, 'SUPERVISOR_MAINTENANCE_QUEUE_FULL');
    failures.delete(id); const token = { action, requestDigest }; jobs.set(id, token);
    token.task = (async () => {
      if (action === 'submit') await maintenance.submit(input);
      let row = maintenance.read(id); invariant(row, 'CONTROL_MAINTENANCE_NOT_FOUND');
      do { row = await maintenance.advance(id); } while (!closed && !['completed', 'rolled-back', 'blocked'].includes(row.phase));
    })().catch(error => { failures.set(id, reason(error)); if (failures.size > 128) failures.delete(failures.keys().next().value); }).finally(() => { if (jobs.get(id) === token) jobs.delete(id); });
    // This is deliberately a 202-style progress receipt. `durable:false` means
    // validation has not persisted a maintenance yet; it never claims acceptance.
    return state(id);
  }
  function tick() {
    if (closed || collectorPending) return;
    collectorPending = true; serial(collectNow).catch(error => { lastCollection = { known: false, reason: reason(error) }; }).finally(() => { collectorPending = false; });
  }
  const timer = setInterval(tick, intervalMs); timer.unref(); tick();
  if (maintenance) {
    const pending = supervisor.assembly.sqlite.prepare("SELECT maintenance_id FROM supervisor_control_maintenance WHERE instance_id=? AND phase NOT IN ('completed','rolled-back') LIMIT 2").all(instanceId);
    invariant(pending.length <= 1, 'SUPERVISOR_MAINTENANCE_JOURNAL_CONFLICT');
    for (const row of pending) maintenanceRequest('advance', { maintenanceId: row.maintenance_id });
  }
  let closing;
  return { collect: () => serial(collectNow), appliedStart,
    reserve: (command,snapshot) => serial(async()=>{invariant(reservations,'SUPERVISOR_CAPACITY_TEMPLATES_REQUIRED');const prior=reservations.lookup(command);if(prior?.row.state==='applied')return prior.receipt;const observation=prior?null:await collectNow();const prepared=await reservations.prepare(command,snapshot,observation);if(prepared.qualified===false)return prepared;return reservations.confirm(command,await collectNow());}),
    reservationStatus: command => {const prior=reservations?.lookup(command);return prior?{state:prior.row.state==='applied'?'applied':'unknown',result:prior.receipt}:{state:'definitely-not-applied',result:{dispatched:false}};},
    maintenanceRequest, capacityState: () => lastCollection,
    agentStartIdentity() {
      if (!maintenance) return config.agentStartIdentity;
      const completed = supervisor.assembly.sqlite.prepare("SELECT result FROM supervisor_control_maintenance WHERE instance_id=? AND phase IN ('completed','rolled-back') ORDER BY epoch DESC,rowid DESC LIMIT 1").get(instanceId);
      return completed ? JSON.parse(completed.result).proof.metadata.startIdentity : config.agentStartIdentity;
    },
    close() { return closing ??= (async () => { closed = true; clearInterval(timer); await Promise.allSettled([...jobs.values()].map(value => value.task)); await queue; controlSqlite?.close(); reservationLedger?.close(); publicationDb.close(); })(); } };
}
