import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { canonical, digest, invariant, DIGEST } from '../upgrade/trust.mjs';
import { privateLoopbackOrigin } from '../upgrade/control-rpc.mjs';
import { persistedBinding } from './recover-failed-source-route.mjs';

const PREFIX = 'LEGACY_SOURCE_ROUTE_', MAX_BYTES = 1024 * 1024, MAX_REPLY = 256 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const same = (a, b, code) => invariant(canonical(a) === canonical(b), PREFIX + code);
const copy = value => JSON.parse(canonical(value));
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
const pathRequired = p => invariant(typeof p === 'string' && isAbsolute(p) && resolve(p) === p && !/[\0\r\n]/.test(p), PREFIX + 'FIXED_PATH_REQUIRED');
const positive = value => Number.isSafeInteger(value) && value > 0;
const owner = s => !process.getuid || s.uid === 0n || s.uid === BigInt(process.getuid());
const identity = s => Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(k => [k, String(s[k])]));

/** Foundation/operator read port only. Never pass this factory to startControl:
 * independent Control deliberately has no business DB, installation keys or
 * Foundation files. The caller supplies authenticated config, fixed operation
 * scope, DB dev/ino and the actual source/current-writer origin+identity tuples.
 * No request, receipt or HTTP response chooses a path, origin, key or SQL query.
 * Database is an optional trusted constructor injection; absence loads ONLY the
 * actual configured artifact's native module. There is no fixture fallback.
 * This observes bindings, not Owner resources or settlement. No SDK, Owner RPC,
 * command, POST, signing, file write or journal mutation exists in this port.
 */
export function createLegacySourceRouteFreshBindings({ config, scope, databaseIdentity, currentOriginAuthority,
  keys, Database, fetcher = fetch }) {
  invariant(config && scope && databaseIdentity && currentOriginAuthority, PREFIX + 'TRUSTED_CONFIG_REQUIRED');
  const cfg = freeze(copy({ instanceId: config?.instanceId, root: config?.root, artifactRoot: config?.artifactRoot,
    entryControlPort: config?.ports?.entryControl }));
  const fixed = freeze(copy(scope)), dbIdentity = freeze(copy(databaseIdentity)), authority = freeze(copy(currentOriginAuthority));
  invariant(typeof cfg.instanceId === 'string' && cfg.instanceId.length > 0 && Number.isInteger(cfg.entryControlPort) &&
    cfg.entryControlPort > 0 && cfg.entryControlPort <= 65535, PREFIX + 'TRUSTED_CONFIG_REQUIRED');
  for (const p of [cfg.root, cfg.artifactRoot, dbIdentity.path, dbIdentity.servicePath]) pathRequired(p);
  invariant(dbIdentity.path === join(cfg.root, 'business/platform.db') && /^\d+$/.test(String(dbIdentity.dev)) &&
    /^\d+$/.test(String(dbIdentity.ino)), PREFIX + 'DATABASE_IDENTITY_REQUIRED');
  invariant(fixed.instanceId === cfg.instanceId && fixed.instanceRoot === cfg.root && UUID.test(fixed.operationId ?? '') &&
    UUID.test(fixed.attemptId ?? '') && Object.keys(fixed).sort().join(',') === 'attemptId,instanceId,instanceRoot,operationId',
  PREFIX + 'FIXED_SCOPE_REQUIRED');
  for (const role of ['sourceApi', 'coordinator']) {
    const value = authority[role];
    invariant(value && DIGEST.test(value.artifactDigest) && DIGEST.test(value.inputFingerprint) &&
      typeof value.startIdentity === 'string' && value.startIdentity.length > 0, PREFIX + 'ORIGIN_AUTHORITY_REQUIRED');
    invariant(privateLoopbackOrigin(value.origin) === value.origin, PREFIX + 'ORIGIN_AUTHORITY_REQUIRED');
  }
  invariant(positive(authority.coordinator.generation) && positive(authority.coordinator.writerFence) &&
    typeof authority.coordinator.writerHolderId === 'string' && authority.coordinator.writerHolderId.length > 0 &&
    typeof keys?.entry === 'string' && keys.entry.length >= 32 && typeof keys?.control === 'string' && keys.control.length >= 32 &&
    (Database === undefined || typeof Database === 'function') && typeof fetcher === 'function', PREFIX + 'TRUSTED_TRANSPORT_REQUIRED');
  // Retain only these two in-memory credentials. They are never returned.
  const entryKey = keys.entry, controlKey = keys.control;

  return async function readFreshBindings(requestScope, { signal, timeoutMs, maxBytes } = {}) {
    same(requestScope, fixed, 'READ_SCOPE_CHANGED');
    invariant(signal instanceof AbortSignal && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000 &&
      Number.isSafeInteger(maxBytes) && maxBytes > 0, PREFIX + 'READ_BUDGET_REQUIRED');
    const controller = new AbortController(), began = performance.now(), limit = Math.min(maxBytes, MAX_BYTES);
    const expired = () => Object.assign(new Error(PREFIX + 'FRESH_READ_EXPIRED'), { code: PREFIX + 'FRESH_READ_EXPIRED' });
    const abort = () => controller.abort(expired()), timer = setTimeout(abort, timeoutMs);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    let bytes = 0, db;
    function active() { invariant(!controller.signal.aborted && performance.now() - began < timeoutMs, PREFIX + 'FRESH_READ_EXPIRED'); }
    function consume(n, maximum = limit) {
      active(); invariant(Number.isSafeInteger(n) && n >= 0 && n <= maximum && bytes + n <= limit, PREFIX + 'FRESH_READ_BYTE_LIMIT'); bytes += n;
    }
    async function within(work, closeLateValue) {
      active(); let cancel;
      try {
        return await Promise.race([Promise.resolve().then(() => { active(); return work(); }).then(value => {
          if (controller.signal.aborted || performance.now() - began >= timeoutMs) { closeLateValue?.(value); throw expired(); }
          return value;
        }), new Promise((_, reject) => {
          cancel = () => reject(expired()); controller.signal.addEventListener('abort', cancel, { once: true });
          if (controller.signal.aborted) cancel();
        })]);
      } finally { controller.signal.removeEventListener('abort', cancel); }
    }
    async function canonicalPath(path) {
      pathRequired(path); let part = '';
      for (const name of path.split('/').filter(Boolean)) { part += '/' + name; invariant(!(await within(() => fs.lstat(part))).isSymbolicLink(), PREFIX + 'FRESH_PATH_SYMLINK'); }
      invariant(await within(() => fs.realpath(path)) === path, PREFIX + 'FRESH_PATH_CHANGED');
    }
    async function privateRoot() {
      await canonicalPath(cfg.root); const s = await within(() => fs.lstat(cfg.root, { bigint: true }));
      invariant(s.isDirectory() && owner(s) && (s.mode & 18n) === 0n, PREFIX + 'PRIVATE_ROOT_REQUIRED');
      return { dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), uid: String(s.uid), gid: String(s.gid) };
    }
    async function file(path, { json = true, privateFile = true, maximum = MAX_REPLY } = {}) {
      await canonicalPath(path); const h = await within(() => fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW), h => { h.close().catch(() => {}); });
      try {
        const before = await within(() => h.stat({ bigint: true }));
        invariant(before.isFile() && before.nlink === 1n && owner(before) && (before.mode & (privateFile ? 63n : 18n)) === 0n,
          PREFIX + 'PRIVATE_BINDING_FILE_REQUIRED');
        consume(Number(before.size), Math.min(limit, maximum)); const raw = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < raw.length) { const read = await within(() => h.read(raw, offset, Math.min(65536, raw.length - offset), offset));
          invariant(read.bytesRead > 0, PREFIX + 'FRESH_FILE_CHANGED'); offset += read.bytesRead; }
        const extra = await within(() => h.read(Buffer.alloc(1), 0, 1, offset));
        invariant(extra.bytesRead === 0, PREFIX + 'FRESH_FILE_CHANGED');
        const after = await within(() => h.stat({ bigint: true })); await canonicalPath(path);
        same(identity(before), identity(after), 'FRESH_FILE_CHANGED');
        same(identity(before), identity(await within(() => fs.lstat(path, { bigint: true }))), 'FRESH_FILE_REPLACED');
        return { identity: identity(before), rawDigest: digest(raw), value: json ? JSON.parse(raw) : null };
      } finally { await h.close(); }
    }
    async function databasePaths() {
      for (const path of new Set([dbIdentity.path, dbIdentity.servicePath])) {
        await canonicalPath(path); const s = await within(() => fs.lstat(path, { bigint: true }));
        invariant(s.isFile() && owner(s) && (s.mode & 63n) === 0n && String(s.dev) === String(dbIdentity.dev) &&
          String(s.ino) === String(dbIdentity.ino), PREFIX + 'DATABASE_ALIAS_IDENTITY_CHANGED');
      }
      const h = await within(() => fs.open(dbIdentity.path, constants.O_RDONLY | constants.O_NOFOLLOW), h => { h.close().catch(() => {}); }); let header;
      try { header = Buffer.alloc(100); const n = await within(() => h.read(header, 0, 100, 0)); invariant(n.bytesRead === 100 &&
        header.subarray(0, 16).toString('binary') === 'SQLite format 3\0', PREFIX + 'DATABASE_HEADER_REQUIRED'); consume(100); }
      finally { await h.close(); }
      const walMode = header[18] === 2 || header[19] === 2;
      for (const alias of new Set([dbIdentity.path, dbIdentity.servicePath])) {
        const sidecars = [];
        for (const suffix of ['-wal', '-shm']) {
          const p = alias + suffix; let s;
          try { s = await within(() => fs.lstat(p, { bigint: true })); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (s) { await canonicalPath(p); invariant(s.isFile() && s.nlink === 1n && owner(s) && (s.mode & 63n) === 0n,
            PREFIX + 'EXISTING_DATABASE_SIDECAR_REQUIRED'); }
          sidecars.push(Boolean(s));
        }
        invariant((!walMode && !sidecars[0] && !sidecars[1]) || sidecars.every(Boolean), PREFIX + 'EXISTING_DATABASE_SHM_REQUIRED');
      }
    }
    async function bindings() {
      const files = {};
      for (const [name, relative] of [['entryBinding', 'entry/entry-binding.json'], ['entryAdmission', 'entry/entry-fence.json'],
        ['owners', 'bindings/owners.json'], ['coordinator', 'bindings/coordinator.json']]) files[name] = await file(join(cfg.root, relative));
      const b = files.entryBinding.value, admission = files.entryAdmission.value, owners = files.owners.value, c = files.coordinator.value;
      invariant(b.instanceId === cfg.instanceId && b.attemptId === fixed.attemptId && admission.instanceId === cfg.instanceId &&
        admission.attemptId === fixed.attemptId && Number.isSafeInteger(b.fence) && b.fence === admission.fence &&
        Number.isSafeInteger(b.routeGeneration), PREFIX + 'ENTRY_FILE_SCOPE_CHANGED');
      same(b.oldApi, { origin: authority.sourceApi.origin, digest: authority.sourceApi.artifactDigest }, 'ENTRY_SOURCE_IDENTITY_CHANGED');
      invariant(owners.instanceId === cfg.instanceId && Array.isArray(owners.owners) && owners.owners.length > 0 && owners.owners.length <= 64 &&
        new Set(owners.owners.map(row => row.ownerId)).size === owners.owners.length && owners.owners.some(row => row.ownerId === owners.activeOwnerId),
      PREFIX + 'OWNER_BINDING_SCOPE_CHANGED');
      invariant(c.state === 'ready' && c.origin === authority.coordinator.origin && c.generation === authority.coordinator.generation &&
        c.artifactDigest === authority.coordinator.artifactDigest && (c.instanceId === undefined || c.instanceId === cfg.instanceId),
      PREFIX + 'COORDINATOR_BINDING_CHANGED');
      return files;
    }
    function sqlRows() {
      active(); return db.transaction(() => {
        // An altered schema must not turn an intended single-key read into a
        // table scan (or hide duplicate writer rows behind get()).
        for (const [table, key] of [['upgrade_attempts', 'attempt_id'], ['upgrade_instances', 'instance_id'], ['platform_role_leases', 'role']]) {
          const primary = db.prepare("SELECT name FROM pragma_table_info('" + table + "') WHERE pk>0 ORDER BY pk LIMIT 2").all();
          same(primary, [{ name: key }], 'DATABASE_UNIQUE_READ_KEY_REQUIRED');
        }
        const bounded = (sql, params, read) => { active(); const planned = db.prepare(sql).get(...params);
          invariant(planned && Number.isSafeInteger(planned.bytes), PREFIX + 'DATABASE_ROW_REQUIRED'); consume(planned.bytes, MAX_REPLY);
          const row = read(); consume(Buffer.byteLength(JSON.stringify(row)), MAX_REPLY); return row; };
        const attempt = bounded('SELECT coalesce(octet_length(attempt_id),0)+coalesce(octet_length(instance_id),0)+coalesce(octet_length(controller_id),0)+coalesce(octet_length(fence),0)+coalesce(octet_length(lease_expires_at),0)+coalesce(octet_length(state),0)+coalesce(octet_length(sequence),0)+coalesce(octet_length(generation),0) AS bytes FROM upgrade_attempts WHERE attempt_id=?',
          [fixed.attemptId], () => db.prepare('SELECT attempt_id,instance_id,controller_id,fence,lease_expires_at,state,sequence,generation FROM upgrade_attempts WHERE attempt_id=?').get(fixed.attemptId));
        const instance = bounded('SELECT coalesce(octet_length(activation_generation),0)+coalesce(octet_length(confirmed_release),0)+coalesce(octet_length(service_state),0)+coalesce(octet_length(ready),0) AS bytes FROM upgrade_instances WHERE instance_id=?',
          [cfg.instanceId], () => db.prepare('SELECT activation_generation,confirmed_release,service_state,ready FROM upgrade_instances WHERE instance_id=?').get(cfg.instanceId));
        const writer = bounded("SELECT coalesce(octet_length(instance_id),0)+coalesce(octet_length(holder_id),0)+coalesce(octet_length(generation),0)+coalesce(octet_length(fence),0)+coalesce(octet_length(expires_at),0) AS bytes FROM platform_role_leases WHERE role='state-coordinator'",
          [], () => db.prepare("SELECT instance_id,holder_id,generation,fence,expires_at FROM platform_role_leases WHERE role='state-coordinator'").get());
        invariant(attempt.instance_id === cfg.instanceId && attempt.attempt_id === fixed.attemptId && [0, 1].includes(instance.ready), PREFIX + 'DATABASE_ROW_SCOPE_CHANGED');
        invariant(writer.instance_id === cfg.instanceId && writer.holder_id === authority.coordinator.writerHolderId &&
          writer.generation === authority.coordinator.generation && writer.fence === authority.coordinator.writerFence &&
          Number.isFinite(writer.expires_at) && writer.expires_at > Date.now(), PREFIX + 'CURRENT_WRITER_CHANGED');
        active(); return { attempt, instance: { activationGeneration: instance.activation_generation,
          confirmedReleaseDigest: digest(JSON.parse(instance.confirmed_release)), serviceState: instance.service_state, ready: instance.ready === 1 }, writer };
      }).deferred();
    }
    async function get(origin, path, key) {
      const response = await within(() => fetcher(origin + path, { method: 'GET', headers: { 'x-platform-internal-key': key,
        'x-platform-instance-id': cfg.instanceId }, redirect: 'error', signal: controller.signal }), response => { response.body?.cancel().catch(() => {}); });
      if (response.status !== 200 || !response.body) { response.body?.cancel().catch(() => {}); invariant(false, PREFIX + 'IDENTITY_GET_UNCONFIRMED'); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { for (;;) { const n = await within(() => reader.read()); if (n.done) break;
        size += n.value.length; invariant(size <= MAX_REPLY, PREFIX + 'IDENTITY_REPLY_TOO_LARGE'); consume(n.value.length); chunks.push(n.value); } }
      finally { reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(chunks, size)); return value.data ?? value;
    }
    try {
      const rootBefore = await privateRoot(); await databasePaths(); const before = await bindings();
      let Constructor = Database;
      if (!Constructor) { const packagePath = join(cfg.artifactRoot, 'api/package.json'); await file(packagePath, { privateFile: false, json: false });
        Constructor = createRequire(packagePath)('better-sqlite3'); }
      active(); db = new Constructor(dbIdentity.path, { readonly: true, fileMustExist: true, timeout: 0 });
      // These are connection-local safeguards, not a change to the business writer.
      db.pragma('busy_timeout = 0'); db.pragma('query_only = ON');
      invariant(db.readonly === true && db.pragma('query_only', { simple: true }) === 1, PREFIX + 'READONLY_DATABASE_REQUIRED');
      const first = sqlRows();
      const [entry, source, coor] = await Promise.all([
        get('http://127.0.0.1:' + cfg.entryControlPort, '/binding', entryKey),
        get(authority.sourceApi.origin, '/internal/control/identity', controlKey),
        get(authority.coordinator.origin, '/internal/application/identity', controlKey),
      ]);
      same(persistedBinding(entry), persistedBinding(before.entryBinding.value), 'ENTRY_HTTP_FILE_MISMATCH');
      for (const [value, expected] of [[source, authority.sourceApi], [coor, authority.coordinator]]) {
        invariant(value.instanceId === cfg.instanceId && ['artifactDigest', 'inputFingerprint', 'startIdentity'].every(k => value[k] === expected[k]) &&
          value.writerFenceValid === true, PREFIX + 'CURRENT_PROCESS_IDENTITY_CHANGED');
      }
      invariant(source.controlOnly === true && source.noRuntimeSideEffects === true && source.actualCoordinatorArtifactDigest === authority.coordinator.artifactDigest &&
        source.actualCoordinatorInputFingerprint === authority.coordinator.inputFingerprint && source.coordinatorGeneration === authority.coordinator.generation &&
        coor.coordinatorGeneration === authority.coordinator.generation, PREFIX + 'SOURCE_CURRENT_WRITER_CHANGED');
      const last = sqlRows(), after = await bindings(); await databasePaths(); same(await privateRoot(), rootBefore, 'ROOT_REPLACED');
      same(before, after, 'BINDING_FILE_REPLACED_OR_CHANGED');
      same({ ...first, writer: { ...first.writer, expires_at: null } }, { ...last, writer: { ...last.writer, expires_at: null } }, 'DATABASE_BINDINGS_CHANGED');
      const sourceIdentity = Object.fromEntries(['instanceId', 'artifactDigest', 'inputFingerprint', 'startIdentity', 'controlOnly', 'noRuntimeSideEffects',
        'writerFenceValid', 'actualCoordinatorArtifactDigest', 'actualCoordinatorInputFingerprint', 'coordinatorGeneration'].map(k => [k, source[k]]));
      const coordinatorIdentity = Object.fromEntries(['instanceId', 'artifactDigest', 'inputFingerprint', 'startIdentity', 'coordinatorGeneration', 'writerFenceValid'].map(k => [k, coor[k]]));
      const result = { observedAt: Date.now(), entryBinding: persistedBinding(entry), entryAdmission: before.entryAdmission.value,
        ...last, coordinatorBinding: Object.fromEntries(['state', 'origin', 'generation', 'artifactDigest'].map(k => [k, after.coordinator.value[k]])),
        ownerBindingDigest: digest(after.owners.value), sourceIdentity, coordinatorIdentity };
      consume(Buffer.byteLength(JSON.stringify(result))); active(); return freeze(result);
    } finally { try { db?.close(); } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(expired()); } }
  };
}
