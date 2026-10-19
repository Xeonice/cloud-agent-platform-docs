import { readInitialRoleInventory } from "./initial-role-inventory.mjs";
import * as fs from "node:fs/promises";
import { isAbsolute, dirname, join } from "node:path";
import { invariant, canonical, digest } from "./trust.mjs";
import { atomicJson, secureDirectory } from "./io.mjs";
import { readSupervisorFact } from "./supervisor-control.mjs";

const ID = /^[a-zA-Z0-9._:-]{1,200}$/,
  HASH = /^sha256:[a-f0-9]{64}$/,
  CID = /^[a-f0-9]{64}$/;
// Exact UpgradeAttemptStateSchema/UpgradeRecoverySchema domains. Exported for
// all retirement readers; contract-parity tests guard future enum drift.
export const REFERENCE_ATTEMPT_TERMINAL_STATES = Object.freeze([
  "activation-confirmed",
  "deferred",
  "candidate-rejected",
  "failed",
  "reverted",
]);
export const REFERENCE_ATTEMPT_ACTIVE_STATES = Object.freeze([
  "accepted",
  "downloading",
  "package-verified",
  "migrating",
  "prepared",
  "candidate-ready",
  "routing-switched",
  "observing",
  "api-activated",
]);
export const REFERENCE_RECOVERY_STATES = Object.freeze([
  "recovering",
  "recovery-confirmed",
  "unknown",
  "failed",
]);
export const REFERENCE_RECOVERY_PHASES = Object.freeze([
  "created",
  "reconciling",
  "restoring",
  "verifying",
  "recovered",
  "blocked",
]);
const terminal = new Set(REFERENCE_ATTEMPT_TERMINAL_STATES);
const attemptDomain = new Set([
  ...REFERENCE_ATTEMPT_ACTIVE_STATES,
  ...REFERENCE_ATTEMPT_TERMINAL_STATES,
]);
const sqlTerminal =
  "(" +
  REFERENCE_ATTEMPT_TERMINAL_STATES.map((state) => "'" + state + "'").join(
    ",",
  ) +
  ")";
const ROLES = ["api", "coordinator", "web", "installer"];
const REFS = [
  "entry",
  "http",
  "ws",
  "writer",
  "handoff",
  "activeCommands",
  "fallback",
  "owners",
  "guests",
  "recovery",
  "workers",
  "userOperations",
];
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const fresh = (at, now, age) =>
  Number.isFinite(Date.parse(at)) &&
  now >= Date.parse(at) &&
  now - Date.parse(at) <= age;
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const reason = (error) =>
  /^REFERENCE_[A-Z0-9_]{1,90}$/.test(error?.code || error?.message || "")
    ? error.code || error.message
    : "REFERENCE_FACT_UNKNOWN";
const identity = (r) => ({
  instanceId: r.instanceId,
  role: r.kind ?? r.role,
  containerId: r.containerId,
  startIdentity: r.startIdentity,
  hostPid: r.hostPid,
  startedAt: r.startedAt,
  artifactDigest: r.artifactDigest,
  attemptId: r.attemptId,
});
const valid = (t) =>
  t &&
  ID.test(t.instanceId) &&
  ROLES.includes(t.role) &&
  CID.test(t.containerId) &&
  ID.test(t.startIdentity) &&
  t.startIdentity.length >= 16 &&
  integer(t.hostPid) &&
  t.hostPid > 1 &&
  Number.isFinite(Date.parse(t.startedAt)) &&
  HASH.test(t.artifactDigest) &&
  ID.test(t.attemptId);
const physical = (p) => ({
  containerId: p.containerId,
  startIdentity: p.startIdentity,
  hostPid: p.hostPid,
  startedAt: p.startedAt,
  artifactDigest: p.artifactDigest,
  role: p.role,
  birthTicks: p.birthTicks,
  processBirth: p.processBirth ?? null,
  cgroupDigest: p.cgroupDigest ?? null,
  restartCount: p.restartCount,
  running: p.running,
  paused: p.paused,
  restartPolicy: p.restartPolicy,
});
async function allActual(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => r.value);
}
const refsUnknown = () => Object.fromEntries(REFS.map((k) => [k, null]));
function origin(value) {
  const u = new URL(value);
  invariant(
    u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password,
    "REFERENCE_ORIGIN_UNKNOWN",
  );
  return u.origin;
}
function contains(value, target) {
  let visited = 0;
  function walk(v, depth) {
    invariant(++visited <= 20000 && depth <= 24, "REFERENCE_SCOPE_LIMIT");
    if (typeof v === "string")
      return (
        v === target.containerId ||
        v === target.startIdentity ||
        v === target.artifactDigest
      );
    if (Array.isArray(v)) return v.some((item) => walk(item, depth + 1));
    if (v && typeof v === "object")
      return Object.values(v).some((item) => walk(item, depth + 1));
    return false;
  }
  return walk(value, 0);
}
function boundedRows(sqlite, sql, ...params) {
  const rows = sqlite.prepare(sql).all(...params);
  invariant(rows.length <= 128, "REFERENCE_LEDGER_LIMIT");
  return rows;
}
function parsed(value, max = 262144) {
  invariant(
    typeof value === "string" && Buffer.byteLength(value) <= max,
    "REFERENCE_JSON_UNKNOWN",
  );
  return JSON.parse(value);
}

/** Fixed SELECTs on independent control.db and the Supervisor's own journal.
 * No business DB, integrity scan, event bodies, secrets, or lifecycle calls.
 * Active/unknown global work conservatively protects every candidate. */
export function readControlReferenceFacts({
  sqlite,
  supervisorSqlite,
  instanceId,
  targets,
  command = null,
  clock = Date.now,
}) {
  invariant(
    sqlite?.readonly === true &&
      supervisorSqlite &&
      ID.test(instanceId) &&
      Array.isArray(targets) &&
      targets.length <= 128,
    "REFERENCE_LEDGER_SCOPE_UNKNOWN",
  );
  const observedAt = new Date(clock()).toISOString();
  const read = () => {
    const authority = sqlite
      .prepare(
        "SELECT operation_id,holder_id,lease_expires_at,mode FROM control_authority WHERE instance_id=?",
      )
      .get(instanceId);
    invariant(
      authority && ["active", "passive"].includes(authority.mode),
      "REFERENCE_AUTHORITY_UNKNOWN",
    );
    const attempts = [
      ...new Map(targets.map((t) => [t.attemptId, t])).values(),
    ].map((t) => {
      const r = sqlite
        .prepare(
          "SELECT attempt_id,state,controller_id,lease_expires_at FROM upgrade_attempts WHERE instance_id=? AND attempt_id=?",
        )
        .get(instanceId, t.attemptId);
      // A cold/migrated source has no fabricated upgrade attempt. It remains
      // unretirable, without erasing a different candidate's actual terminal row.
      if (!r)
        return {
          attemptId: t.attemptId,
          known: false,
          state: null,
          controllerId: null,
          leaseExpiresAt: null,
        };
      invariant(
        attemptDomain.has(r.state) && integer(r.lease_expires_at),
        "REFERENCE_ATTEMPT_UNKNOWN",
      );
      return {
        attemptId: r.attempt_id,
        state: r.state,
        controllerId: r.controller_id,
        leaseExpiresAt: r.lease_expires_at,
      };
    });
    const active = boundedRows(
      sqlite,
      `SELECT attempt_id,state,CASE WHEN length(plan)<=262144 THEN plan END AS plan,CASE WHEN length(source_activation)<=65536 THEN source_activation END AS source_activation,CASE WHEN length(source_actual)<=65536 THEN source_actual END AS source_actual FROM upgrade_attempts WHERE instance_id=? AND state NOT IN ${sqlTerminal} LIMIT 129`,
      instanceId,
    );
    const current = sqlite
      .prepare(
        "SELECT CASE WHEN length(confirmed_release)<=65536 THEN confirmed_release END AS confirmed_release FROM upgrade_instances WHERE instance_id=?",
      )
      .get(instanceId);
    invariant(current, "REFERENCE_CURRENT_UNKNOWN");
    const fallbacks = [];
    if (current.confirmed_release !== null)
      fallbacks.push(parsed(current.confirmed_release, 65536));
    for (const r of active) {
      invariant(attemptDomain.has(r.state), "REFERENCE_ATTEMPT_STATE_UNKNOWN");
      fallbacks.push(parsed(r.plan));
      fallbacks.push(parsed(r.source_activation, 65536));
      if (r.source_actual !== null)
        fallbacks.push(parsed(r.source_actual, 65536));
    }
    const retained = boundedRows(
      sqlite,
      `WITH successful AS (
        SELECT attempt_id,observed_at,
          CASE WHEN length(manifest)<=65536 AND json_valid(manifest) THEN json_extract(manifest,'$.manifest.policy.retentionMs') END AS retention_ms,
          CASE WHEN length(source_activation)<=65536 THEN source_activation END AS source_activation,
          CASE WHEN length(source_actual)<=65536 THEN source_actual END AS source_actual,
          CASE WHEN length(manifest)<=65536 AND json_valid(manifest) THEN json_extract(manifest,'$.manifest.policy.fallbacks') END AS fallbacks
        FROM upgrade_attempts WHERE instance_id=? AND state='activation-confirmed'
      ) SELECT * FROM successful WHERE retention_ms IS NULL OR typeof(retention_ms)<>'integer' OR retention_ms<=0 OR observed_at+retention_ms>? LIMIT 129`,
      instanceId,
      clock(),
    );
    for (const row of retained) {
      invariant(
        integer(row.retention_ms) &&
          row.retention_ms > 0 &&
          integer(row.observed_at) &&
          row.observed_at <= clock(),
        "REFERENCE_RETENTION_UNKNOWN",
      );
      fallbacks.push(parsed(row.source_activation, 65536));
      if (row.source_actual !== null)
        fallbacks.push(parsed(row.source_actual, 65536));
      fallbacks.push(parsed(row.fallbacks, 65536));
    }
    // Explicit current policy fallback digests remain protected after its source
    // retention window; expired unrelated successful history is not an active plan.
    if (current.confirmed_release !== null) {
      const currentRelease = parsed(current.confirmed_release, 65536);
      invariant(
        typeof currentRelease.releaseId === "string",
        "REFERENCE_CURRENT_UNKNOWN",
      );
      const policy = sqlite
        .prepare(
          "SELECT CASE WHEN length(manifest)<=65536 AND json_valid(manifest) THEN json_extract(manifest,'$.manifest.policy.fallbacks') END AS fallbacks FROM upgrade_attempts WHERE instance_id=? AND target_release_id=? AND state='activation-confirmed' ORDER BY generation DESC LIMIT 1",
        )
        .get(instanceId, currentRelease.releaseId);
      if (policy) fallbacks.push(parsed(policy.fallbacks, 65536));
    }
    const recoveryRows = boundedRows(
      sqlite,
      "SELECT recovery_id,phase,CASE WHEN length(authorization_plan)<=262144 THEN authorization_plan END AS authorization_plan,CASE WHEN length(plan)<=262144 THEN plan END AS plan FROM control_recovery_intents WHERE instance_id=? AND phase<>'recovered' LIMIT 129",
      instanceId,
    );
    for (const r of recoveryRows) {
      invariant(
        REFERENCE_RECOVERY_PHASES.includes(r.phase),
        "REFERENCE_RECOVERY_PHASE_UNKNOWN",
      );
      fallbacks.push(parsed(r.authorization_plan));
      if (r.plan !== null) fallbacks.push(parsed(r.plan));
    }
    const legacyRecovery = boundedRows(
      sqlite,
      "SELECT recovery_attempt_id,state FROM upgrade_recoveries WHERE instance_id=? AND state NOT IN ('recovery-confirmed','failed') LIMIT 129",
      instanceId,
    );
    invariant(
      legacyRecovery.every((r) => REFERENCE_RECOVERY_STATES.includes(r.state)),
      "REFERENCE_RECOVERY_STATE_UNKNOWN",
    );
    const operations = boundedRows(
      sqlite,
      "SELECT operation_id,role,state FROM platform_operations WHERE instance_id=? AND state NOT IN ('completed','complete','failed','cancelled','deferred','cleared','confirmed','observed') LIMIT 129",
      instanceId,
    );
    return {
      authority,
      attempts,
      fallbacks,
      recovery: recoveryRows.length + legacyRecovery.length,
      userOperations: operations.length,
    };
  };
  const facts = sqlite.transaction(read)();
  const pending = [];
  for (const db of [...new Set([sqlite, supervisorSqlite])]) {
    const rows = boundedRows(
      db,
      "SELECT operation_id,command_id,spec_digest,state,CASE WHEN length(spec)<=16384 THEN json_extract(spec,'$.kind') END AS kind FROM control_commands WHERE instance_id=? AND state IN ('planned','executing','unknown','blocked') LIMIT 129",
      instanceId,
    );
    for (const r of rows) {
      // Only the caller's already-persisted, exact retirement command is not a
      // dependency on itself. A public request cannot nominate arbitrary IDs.
      if (
        command &&
        r.operation_id === command.operationId &&
        r.command_id === command.commandId &&
        r.spec_digest === command.specDigest &&
        r.kind === "retire-candidate"
      )
        continue;
      pending.push({
        operationId: r.operation_id,
        commandId: r.command_id,
        specDigest: r.spec_digest,
        state: r.state,
      });
    }
  }
  return { known: true, instanceId, observedAt, ...facts, pending };
}

/** HTTP is limited to three fixed read-only metadata routes and one Entry
 * binding route. Response bodies are bounded while streaming, not afterwards. */
export async function readCandidateReferenceHttp({
  instanceId,
  origin: base,
  path,
  key,
  signal,
  fetcher = fetch,
}) {
  invariant(
    [
      "/binding",
      "/internal/control/retirement",
      "/internal/coordinator/retirement",
      "/internal/application/retirement",
    ].includes(path) &&
      typeof key === "string" &&
      key.length >= 32,
    "REFERENCE_HTTP_SCOPE_UNKNOWN",
  );
  signal?.throwIfAborted();
  const observedAt = new Date().toISOString();
  const response = await fetcher(origin(base) + path, {
    method: "GET",
    headers: {
      "x-platform-internal-key": key,
      "x-platform-instance-id": instanceId,
    },
    redirect: "error",
    signal,
  });
  invariant(response.ok, "REFERENCE_HTTP_UNAVAILABLE");
  const reader = response.body?.getReader();
  invariant(reader, "REFERENCE_HTTP_UNKNOWN");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      invariant(bytes <= 65536, "REFERENCE_HTTP_LIMIT");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return path === "/binding"
    ? { known: true, instanceId, observedAt, value }
    : value;
}

/** Converts actual raw proofs. Unsupported/old roles remain unknown rather
 * than claiming no workers or Owner dependency from desired configuration. */
export function deriveCandidateReferenceState({
  instanceId,
  target,
  record,
  before,
  after,
  entry,
  binding,
  control,
  census,
  now = Date.now(),
  maxAgeMs = 5000,
}) {
  const state = {
    known: false,
    instanceId,
    target,
    revision: 0,
    observedAt: new Date(now).toISOString(),
    running: before?.running ?? null,
    paused: before?.paused ?? null,
    restartPolicy: before?.restartPolicy ?? null,
    attemptTerminal: false,
    authorityReleased: false,
    controllerLeaseExpiresAt: null,
    legacyInstaller: target?.role === "installer",
    references: refsUnknown(),
  };
  try {
    invariant(
      valid(target) && target.instanceId === instanceId,
      "REFERENCE_TARGET_UNKNOWN",
    );
    invariant(
      canonical(physical(before)) === canonical(physical(after)) &&
        before.containerId === target.containerId &&
        before.startIdentity === target.startIdentity &&
        before.hostPid === target.hostPid &&
        before.startedAt === target.startedAt &&
        before.artifactDigest === target.artifactDigest &&
        before.role === target.role &&
        integer(before.restartCount) &&
        typeof before.birthTicks === "string" &&
        /^\d+$/.test(before.birthTicks) &&
        HASH.test(before.cgroupDigest),
      "REFERENCE_PHYSICAL_CHANGED",
    );
    state.physicalIdentityDigest = digest(physical(before));
    for (const f of [entry, binding, control, census])
      invariant(
        f && f.instanceId === instanceId && fresh(f.observedAt, now, maxAgeMs),
        "REFERENCE_OBSERVATION_STALE",
      );
    state.observedAt = new Date(
      Math.min(
        ...[entry, binding, control, census].map((f) =>
          Date.parse(f.observedAt),
        ),
      ),
    ).toISOString();
    invariant(
      entry.known === true && control.known === true && binding.known === true,
      "REFERENCE_SOURCE_UNKNOWN",
    );
    const attempt = control.attempts.filter(
      (a) => a.attemptId === target.attemptId,
    );
    invariant(
      attempt.length === 1 && integer(attempt[0].leaseExpiresAt),
      "REFERENCE_ATTEMPT_UNKNOWN",
    );
    state.attemptTerminal = terminal.has(attempt[0].state);
    state.controllerLeaseExpiresAt = attempt[0].leaseExpiresAt;
    state.authorityReleased =
      attempt[0].leaseExpiresAt <= now &&
      (control.authority.operation_id !== target.attemptId ||
        control.authority.lease_expires_at <= now ||
        control.authority.holder_id === null);
    const e = entry.value;
    invariant(
      e &&
        e.httpByDigest &&
        e.wsByDigest &&
        Object.getPrototypeOf(e.httpByDigest) === Object.prototype &&
        Object.getPrototypeOf(e.wsByDigest) === Object.prototype,
      "REFERENCE_ENTRY_COUNTERS_UNKNOWN",
    );
    const count = (map) => {
      const rows = Object.entries(map);
      invariant(
        rows.length <= 128 &&
          rows.every(([key, value]) => HASH.test(key) && integer(value)),
        "REFERENCE_ENTRY_COUNTERS_UNKNOWN",
      );
      return map[target.artifactDigest] ?? 0;
    };
    const refs = state.references;
    // A configured fallback is protected even at route weight zero. Digest
    // counters conservatively protect every same-digest physical candidate.
    refs.entry = contains(
      [e.oldApi, e.candidateApi, e.web, e.retainedWeb, binding.value],
      target,
    )
      ? 1
      : 0;
    refs.fallback = control.fallbacks.filter((v) => contains(v, target)).length;
    refs.http = count(e.httpByDigest);
    refs.ws = count(e.wsByDigest);
    refs.activeCommands = control.pending.length;
    refs.recovery = control.recovery;
    refs.userOperations = control.userOperations;
    invariant(
      census.schemaVersion === 1 &&
        census.complete === true &&
        census.role === target.role &&
        census.startIdentity === target.startIdentity &&
        census.artifactDigest === target.artifactDigest &&
        census.pid === before.pid &&
        typeof census.writer === "boolean",
      "REFERENCE_CENSUS_UNKNOWN",
    );
    const c = census.counts;
    invariant(
      c &&
        [
          "http",
          "ws",
          "streams",
          "workers",
          "owners",
          "guests",
          "handoff",
          "recovery",
          "userOperations",
        ].every((k) => integer(c[k])),
      "REFERENCE_CENSUS_COUNTS_UNKNOWN",
    );
    refs.http += c.http + c.streams;
    refs.ws += c.ws;
    refs.writer = census.writer ? 1 : 0;
    refs.handoff = c.handoff;
    refs.owners = c.owners;
    refs.guests = c.guests;
    refs.recovery += c.recovery;
    refs.workers = c.workers;
    refs.userOperations += c.userOperations;
    state.known = true;
  } catch (error) {
    state.reason = reason(error);
  }
  return state;
}

/** One serial producer. A timeout publishes unknown immediately but retains
 * the live barrier until the actual reader settles; abort is not completion. */
export function createCandidateReferenceCollector({
  instanceId,
  observationPath,
  readers,
  clock = Date.now,
  maxAgeMs = 5000,
  timeoutMs = 2000,
  publicationLock = null,
}) {
  invariant(
    ID.test(instanceId) &&
      isAbsolute(observationPath) &&
      integer(maxAgeMs) &&
      maxAgeMs > 0 &&
      maxAgeMs <= 5000 &&
      integer(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 2000 &&
      ["inventory", "entry", "binding", "control", "inspect", "census"].every(
        (k) => typeof readers?.[k] === "function",
      ),
    "REFERENCE_COLLECTOR_CONFIG_INVALID",
  );
  let live = null;
  async function publish(candidates, complete, start, details = {}) {
    const prior = await readSupervisorFact(observationPath, 1048576).catch(
      (e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      },
    );
    const priorRows = prior?.value.candidates ?? [];
    for (const state of candidates) {
      const old = priorRows.find(
        (v) => canonical(v.target) === canonical(state.target),
      );
      const facts = (v) => {
        const { revision, observedAt, reason, ...rest } = v;
        return rest;
      };
      state.revision =
        old && canonical(facts(old)) === canonical(facts(state))
          ? old.revision
          : (old?.revision ?? 0) + 1;
    }
    const result = {
      schemaVersion: 1,
      instanceId,
      revision: (prior?.value.revision ?? 0) + 1,
      observedAt: new Date(start).toISOString(),
      candidates,
      complete,
      ...details,
    };
    await atomicJson(observationPath, result);
    return result;
  }
  async function collect({ command = null, signal: parentSignal } = {}) {
    invariant(!live, "REFERENCE_COLLECTION_IN_PROGRESS");
    await secureDirectory(dirname(observationPath));
    const release = publicationLock
      ? await publicationLock.acquire()
      : await (async () => {
          const lock = await fs
            .open(observationPath + ".collector-lock", "wx", 0o600)
            .catch((e) => {
              if (e.code === "EEXIST") fail("REFERENCE_COLLECTOR_BUSY");
              throw e;
            });
          return async () => {
            await lock.close();
            await fs.unlink(observationPath + ".collector-lock");
          };
        })();
    const start = clock(),
      abort = new AbortController(),
      signal = AbortSignal.any([
        abort.signal,
        ...(parentSignal ? [parentSignal] : []),
      ]);
    let inventory = null,
      timedOut = false,
      timer;
    const task = (async () => {
      inventory = await readers.inventory({ signal });
      invariant(
        inventory?.instanceId === instanceId &&
          inventory.complete === true &&
          Array.isArray(inventory.records) &&
          inventory.records.length <= 128,
        "REFERENCE_INVENTORY_UNKNOWN",
      );
      const records = inventory.records.filter((r) =>
        ROLES.includes(r.kind ?? r.role),
      );
      const targets = records.map(identity);
      invariant(
        targets.every(valid) &&
          new Set(targets.map((t) => t.containerId)).size === targets.length,
        "REFERENCE_INVENTORY_IDENTITY_UNKNOWN",
      );
      const [entry, binding, control] = await allActual([
        readers.entry({ signal }),
        readers.binding({ signal }),
        readers.control({ targets, command, signal }),
      ]);
      const candidates = [];
      // Bounded concurrency; do not sweep process trees, artifacts or SDKs.
      let cursor = 0;
      await allActual(
        Array.from({ length: Math.min(4, records.length) }, async () => {
          while (cursor < records.length) {
            const i = cursor++,
              record = records[i],
              target = targets[i];
            let before, after, census;
            try {
              signal.throwIfAborted();
              before = await readers.inspect(target.containerId, { signal });
              census = await readers.census(record, { signal });
              after = await readers.inspect(target.containerId, { signal });
            } catch {
              /* unknown facts remain unknown */
            }
            candidates[i] = deriveCandidateReferenceState({
              instanceId,
              target,
              record,
              before,
              after,
              entry,
              binding,
              control,
              census,
              now: clock(),
              maxAgeMs,
            });
          }
        }),
      );
      const [lastInventory, lastEntry, lastBinding, lastControl] =
        await allActual([
          readers.inventory({ signal }),
          readers.entry({ signal }),
          readers.binding({ signal }),
          readers.control({ targets, command, signal }),
        ]);
      const facts = (v) => {
        const { observedAt, ...rest } = v ?? {};
        return rest;
      };
      invariant(
        canonical(facts(inventory)) === canonical(facts(lastInventory)) &&
          canonical(facts(entry)) === canonical(facts(lastEntry)) &&
          canonical(facts(binding)) === canonical(facts(lastBinding)) &&
          canonical(facts(control)) === canonical(facts(lastControl)),
        "REFERENCE_SOURCE_CHANGED",
      );
      signal.throwIfAborted();
      return { candidates, complete: candidates.every((c) => c.known) };
    })();
    const token = { task, done: null, resolve: null };
    token.done = new Promise((ok) => {
      token.resolve = ok;
    });
    live = token;
    let workSettled = false,
      publicationDone = false,
      cleaning;
    const cleanup = () => {
      if (!workSettled || !publicationDone) return Promise.resolve();
      return (cleaning ??= (async () => {
        clearTimeout(timer);
        try {
          await release();
        } finally {
          if (live === token) live = null;
          token.resolve();
        }
      })());
    };
    task
      .then(
        () => {
          workSettled = true;
          return cleanup();
        },
        () => {
          workSettled = true;
          return cleanup();
        },
      )
      .catch(() => {});
    try {
      const result = await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            abort.abort();
            reject(
              Object.assign(Error("REFERENCE_COLLECTION_TIMEOUT"), {
                code: "REFERENCE_COLLECTION_TIMEOUT",
              }),
            );
          }, timeoutMs);
        }),
      ]);
      invariant(!timedOut, "REFERENCE_COLLECTION_TIMEOUT");
      clearTimeout(timer);
      return await publish(result.candidates, result.complete, start, {
        protectedSources: inventory?.protectedSources ?? [],
      });
    } catch (error) {
      const candidates = (inventory?.records ?? [])
        .filter((r) => ROLES.includes(r.kind ?? r.role))
        .slice(0, 128)
        .map((r) => ({
          known: false,
          instanceId,
          target: identity(r),
          revision: 0,
          observedAt: new Date(start).toISOString(),
          reason: reason(error),
          references: refsUnknown(),
        }));
      return await publish(candidates, false, start, { reason: reason(error) });
    } finally {
      publicationDone = true;
      await cleanup();
    }
  }

  return {
    collect,
    async getState({ target, command = null, abortSignal } = {}) {
      const result = await collect({ command, signal: abortSignal }),
        rows = result.candidates.filter(
          (row) => canonical(row.target) === canonical(target),
        );
      invariant(
        rows.length === 1,
        "REFERENCE_TARGET_NOT_IN_COMPLETE_INVENTORY",
      );
      return rows[0];
    },
    pending: () => live !== null,
    idle: () => (live ? live.done : Promise.resolve()),
  };
}

/** Production reader assembly. Config supplies installation-owned exact paths
 * and private RAM keys; keys never enter published observations or errors. */
export async function createProductionCandidateReferenceCollector({
  root,
  publicationRoot,
  instanceId,
  controlDbPath,
  coordinatorBindingPath,
  entryOrigin,
  entryKey,
  apiKey,
  coordinatorKey,
  adapter,
  Database,
  supervisorSqlite,
  observationPath,
  clock = Date.now,
}) {
  invariant(
    [
      root,
      publicationRoot,
      controlDbPath,
      coordinatorBindingPath,
      observationPath,
    ].every(isAbsolute) &&
      typeof adapter?.inspect === "function" &&
      Database &&
      supervisorSqlite,
    "REFERENCE_PRODUCTION_CONFIG_INVALID",
  );
  const stat = await fs.lstat(controlDbPath);
  invariant(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      (await fs.realpath(controlDbPath)) === controlDbPath,
    "REFERENCE_LEDGER_INSECURE",
  );
  const db = new Database(controlDbPath, {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("query_only=ON");
  db.pragma("busy_timeout=0");
  await secureDirectory(dirname(observationPath));
  const lockPath = join(dirname(observationPath), "reference-publication.db");
  const handle = await fs.open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  await handle?.close();
  const lockStat = await fs.lstat(lockPath);
  invariant(
    lockStat.isFile() &&
      !lockStat.isSymbolicLink() &&
      (lockStat.mode & 0o077) === 0 &&
      (await fs.realpath(lockPath)) === lockPath,
    "REFERENCE_PUBLICATION_DB_INSECURE",
  );
  const mutex = new Database(lockPath, { fileMustExist: true });
  mutex.pragma("busy_timeout=0");
  mutex.exec(
    "CREATE TABLE IF NOT EXISTS reference_publication_guard(instance_id TEXT PRIMARY KEY,publication_digest TEXT NOT NULL)",
  );
  mutex
    .prepare("INSERT OR IGNORE INTO reference_publication_guard VALUES(?,?)")
    .run(instanceId, digest(observationPath));
  invariant(
    mutex.prepare("SELECT COUNT(*) AS n FROM reference_publication_guard").get()
      .n === 1 &&
      mutex
        .prepare(
          "SELECT publication_digest FROM reference_publication_guard WHERE instance_id=?",
        )
        .get(instanceId)?.publication_digest === digest(observationPath),
    "REFERENCE_PUBLICATION_DB_SCOPE_CHANGED",
  );
  const publicationLock = {
    acquire: () => {
      try {
        mutex.exec("BEGIN IMMEDIATE");
      } catch {
        fail("REFERENCE_COLLECTOR_BUSY");
      }
      return async () => mutex.exec("ROLLBACK");
    },
  };
  async function inventory({ signal }) {
    const records = new Map(),
      protectedSources = [];
    const initial = await readInitialRoleInventory({
      path: join(publicationRoot, "initial-role-inventory.json"),
      instanceId,
    }).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    for (const row of initial?.roles ?? [])
      protectedSources.push({
        ...row,
        registration: "historical-bootstrap-proof",
        retirementAllowed: false,
      });
    const add = (r) => {
      if (!ROLES.includes(r.kind ?? r.role)) return;
      const source = initial?.roles.find(
        (row) => row.containerId === r.containerId,
      );
      if (source) {
        invariant(
          source.startIdentity === r.startIdentity &&
            source.artifactDigest === r.artifactDigest &&
            source.kind === (r.kind ?? r.role),
          "REFERENCE_INITIAL_ROLE_CONFLICT",
        );
        return;
      }
      if (!r.attemptId) {
        invariant(
          r.instanceId === instanceId &&
            CID.test(r.containerId) &&
            typeof r.startIdentity === "string" &&
            HASH.test(r.artifactDigest),
          "REFERENCE_INITIAL_ROLE_UNKNOWN",
        );
        protectedSources.push({
          instanceId,
          role: r.kind ?? r.role,
          containerId: r.containerId,
          startIdentity: r.startIdentity,
          artifactDigest: r.artifactDigest,
          retirementAllowed: false,
          registration: "unknown-legacy-source",
          attemptId: null,
        });
        return;
      }
      const t = identity(r);
      invariant(
        valid(t) && t.instanceId === instanceId,
        "REFERENCE_PROCESS_RECORD_UNKNOWN",
      );
      const prior = records.get(t.containerId);
      invariant(
        !prior || canonical(identity(prior)) === canonical(t),
        "REFERENCE_PROCESS_RECORD_CONFLICT",
      );
      records.set(t.containerId, { ...prior, ...r });
    };
    const names = await fs.readdir(join(root, "processes"), {
      withFileTypes: true,
    });
    invariant(names.length <= 4096, "REFERENCE_PROCESS_RECORD_LIMIT");
    const files = names.filter((n) =>
      /-(api|coordinator|web|installer)\.json$/.test(n.name),
    );
    invariant(files.length <= 128, "REFERENCE_PROCESS_RECORD_LIMIT");
    for (const file of files) {
      signal.throwIfAborted();
      invariant(
        file.isFile() && !file.isSymbolicLink(),
        "REFERENCE_PROCESS_RECORD_INSECURE",
      );
      add(
        (await readSupervisorFact(join(root, "processes", file.name), 16384))
          .value,
      );
    }
    const rows = (
      await readSupervisorFact(
        join(publicationRoot, "installed-roles", "installed-roles.json"),
        1048576,
      )
    ).value;
    invariant(
      Array.isArray(rows) && rows.length <= 256,
      "REFERENCE_REGISTRY_LIMIT",
    );
    rows.forEach(add);
    invariant(records.size <= 128, "REFERENCE_INVENTORY_LIMIT");
    return {
      instanceId,
      complete: true,
      protectedSources,
      records: [...records.values()].sort((a, b) =>
        a.containerId.localeCompare(b.containerId),
      ),
    };
  }
  const collector = createCandidateReferenceCollector({
    instanceId,
    observationPath,
    clock,
    publicationLock,
    readers: {
      inventory,
      entry: ({ signal }) =>
        readCandidateReferenceHttp({
          instanceId,
          origin: entryOrigin,
          path: "/binding",
          key: entryKey,
          signal,
        }),
      binding: async () => ({
        known: true,
        instanceId,
        observedAt: new Date(clock()).toISOString(),
        value: (await readSupervisorFact(coordinatorBindingPath, 16384)).value,
      }),
      control: ({ targets, command }) =>
        readControlReferenceFacts({
          sqlite: db,
          supervisorSqlite,
          instanceId,
          targets,
          command,
          clock,
        }),
      inspect: (id) => adapter.inspect(id),
      census: (record, { signal }) => {
        if (record.kind === "api")
          return readCandidateReferenceHttp({
            instanceId,
            origin: record.origin,
            path: "/internal/control/retirement",
            key: apiKey,
            signal,
          });
        if (record.kind === "coordinator" && record.managementOrigin)
          return readCandidateReferenceHttp({
            instanceId,
            origin: record.managementOrigin,
            path: "/internal/coordinator/retirement",
            key: coordinatorKey,
            signal,
          });
        if (record.kind === "coordinator")
          return readCandidateReferenceHttp({
            instanceId,
            origin: record.applicationOrigin ?? record.origin,
            path: "/internal/application/retirement",
            key: coordinatorKey,
            signal,
          });
        return null;
      },
    },
  });
  return {
    ...collector,
    async close() {
      await collector.idle();
      db.close();
      mutex.close();
    },
    async closeWhenIdle() {
      await collector.idle();
      db.close();
      mutex.close();
    },
  };
}
