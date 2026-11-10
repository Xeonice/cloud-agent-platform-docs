import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createStableEntry } from '../upgrade/stable-entry.mjs';
import { digest, canonical } from '../upgrade/trust.mjs';
import { persistedBinding } from './recover-failed-source-route.mjs';
import { createLegacySourceRouteFreshBindings } from './legacy-source-route-fresh-bindings.mjs';

const Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3');
const sha = c => 'sha256:' + c.repeat(64), clone = structuredClone;
const write = (p, value) => fs.writeFile(p, canonical(value) + '\n', { mode: 0o600 });
const bytesHash = async p => createHash('sha256').update(await fs.readFile(p)).digest('hex');
async function server(t, handler) {
  const sockets = new Set(), s = createServer(handler);
  s.on('connection', c => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
  await new Promise(ok => s.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => { for (const c of sockets) c.destroy(); s.closeAllConnections(); s.close(ok); }));
  return 'http://127.0.0.1:' + s.address().port;
}
// Real SQLite + private files + real Stable Entry + authenticated identity HTTP.
// These are isolated transport fixtures, not actual maintenance/adoption results.
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'source-route-read-port-')));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['business', 'bindings']) await fs.mkdir(join(root, name), { mode: 0o700 });
  const instanceId = 'read-port-instance', attemptId = randomUUID(), operationId = randomUUID();
  const path = join(root, 'business/platform.db'), servicePath = join(root, 'service.db'), db = new Database(path);
  t.after(() => db.close()); await fs.chmod(path, 0o600); await fs.link(path, servicePath);
  // The three real store PK projections used by the adapter; no accepted SQL or fake execution receipt.
  db.exec(`CREATE TABLE upgrade_attempts(attempt_id TEXT PRIMARY KEY,instance_id TEXT,controller_id TEXT,fence INTEGER,lease_expires_at INTEGER,state TEXT,sequence INTEGER,generation INTEGER);
    CREATE TABLE upgrade_instances(instance_id TEXT PRIMARY KEY,activation_generation INTEGER,confirmed_release TEXT,service_state TEXT,ready INTEGER);
    CREATE TABLE platform_role_leases(role TEXT PRIMARY KEY,instance_id TEXT,holder_id TEXT,generation INTEGER,fence INTEGER,expires_at INTEGER);`);
  const source = { instanceId, artifactDigest: sha('a'), inputFingerprint: sha('b'), startIdentity: randomUUID(), controlOnly: true,
    noRuntimeSideEffects: true, writerFenceValid: true, actualCoordinatorArtifactDigest: sha('c'), actualCoordinatorInputFingerprint: sha('d'), coordinatorGeneration: 9 };
  const coor = { instanceId, artifactDigest: sha('c'), inputFingerprint: sha('d'), startIdentity: randomUUID(), coordinatorGeneration: 9, writerFenceValid: true };
  const calls = [], keys = { entry: 'entry-private-'.repeat(4), control: 'control-private-'.repeat(4) }, hooks = {};
  async function handle(kind, req, res) {
    calls.push({ kind, method: req.method, path: req.url });
    assert.equal(req.method, 'GET'); assert.equal(req.headers['x-platform-internal-key'], keys.control);
    assert.equal(req.headers['x-platform-instance-id'], instanceId);
    assert.equal(req.url, kind === 'source' ? '/internal/control/identity' : '/internal/application/identity');
    if (hooks[kind]) await hooks[kind](req, res);
    if (!res.writableEnded) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: kind === 'source' ? source : coor })); }
  }
  const sourceOrigin = await server(t, (req, res) => { handle('source', req, res).catch(e => { res.writeHead(500); res.end(JSON.stringify({ code: 'FIXTURE_FAILURE' })); }); });
  const coorOrigin = await server(t, (req, res) => { handle('coordinator', req, res).catch(e => { res.writeHead(500); res.end(JSON.stringify({ code: 'FIXTURE_FAILURE' })); }); });
  const binding = { instanceId, attemptId, fence: 37, routeGeneration: 41, weight: 0,
    oldApi: { origin: sourceOrigin, digest: sha('a') }, candidateApi: { origin: coorOrigin, digest: sha('c') },
    web: { root, digest: sha('e'), treeDigest: sha('f') }, retainedWeb: [] };
  const entry = await createStableEntry({ root: join(root, 'entry'), instanceId, controlKey: keys.entry, stickyKey: 'sticky-'.repeat(8),
    initialBinding: binding, verifyFence: async () => { throw Error('READ_PORT_MUST_NEVER_POST'); } }); t.after(() => entry.close());
  const owners = { instanceId, activeOwnerId: 'original-owner', owners: [{ ownerId: 'original-owner', endpoint: 'http://127.0.0.1:1', artifactDigest: sha('a'), inputFingerprint: sha('b') }] };
  await write(join(root, 'bindings/owners.json'), owners);
  await write(join(root, 'bindings/coordinator.json'), { instanceId, state: 'ready', origin: coorOrigin, generation: 9, artifactDigest: sha('c') });
  const confirmed = { releaseId: 'old-source', schema: 29, activationGeneration: 8 };
  db.prepare('INSERT INTO upgrade_attempts VALUES(?,?,?,?,?,?,?,?)').run(attemptId, instanceId, null, 37, 0, 'failed', 298, 13);
  db.prepare('INSERT INTO upgrade_instances VALUES(?,?,?,?,?)').run(instanceId, 8, JSON.stringify(confirmed), 'transitioning', 0);
  db.prepare('INSERT INTO platform_role_leases VALUES(?,?,?,?,?,?)').run('state-coordinator', instanceId, 'fixed-writer', 9, 9, Date.now() + 60000);
  const stat = await fs.stat(path), options = { config: { root, instanceId, artifactRoot: resolve('.'), ports: { entryControl: Number(new URL(entry.controlOrigin).port) } },
    scope: { instanceId, instanceRoot: root, operationId, attemptId }, databaseIdentity: { path, servicePath, dev: stat.dev, ino: stat.ino },
    currentOriginAuthority: { sourceApi: { origin: sourceOrigin, artifactDigest: source.artifactDigest, inputFingerprint: source.inputFingerprint, startIdentity: source.startIdentity },
      coordinator: { origin: coorOrigin, artifactDigest: coor.artifactDigest, inputFingerprint: coor.inputFingerprint, startIdentity: coor.startIdentity,
        generation: 9, writerFence: 9, writerHolderId: 'fixed-writer' } }, keys, Database };
  const budget = () => ({ signal: new AbortController().signal, timeoutMs: 5000, maxBytes: 32 * 1024 * 1024 });
  const read = (extra = {}) => createLegacySourceRouteFreshBindings({ ...options, ...extra })(options.scope, budget());
  return { root, path, servicePath, db, source, coor, calls, keys, hooks, binding, owners, confirmed, options, budget, read };
}

test('production-shaped port reads real SQLite/Entry/identity, preserves bytes and returns only the observer contract', async t => {
  const f = await fixture(t), paths = [f.path, 'entry/entry-binding.json', 'entry/entry-fence.json', 'bindings/owners.json', 'bindings/coordinator.json'].map(p => p.startsWith('/') ? p : join(f.root, p));
  const before = await Promise.all(paths.map(bytesHash)), began = Date.now(), value = await f.read();
  assert.ok(value.observedAt >= began && value.observedAt <= Date.now()); assert.ok(Object.isFrozen(value.instance));
  assert.deepEqual(value.entryBinding, persistedBinding(f.binding)); assert.equal(value.instance.ready, false);
  assert.equal(value.instance.confirmedReleaseDigest, digest(f.confirmed)); assert.equal(value.attempt.state, 'failed');
  assert.equal(value.ownerBindingDigest, digest(f.owners)); assert.equal(value.writer.generation, 9);
  assert.equal(value.coordinatorIdentity.startIdentity, f.coor.startIdentity); assert.equal(value.sourceIdentity.controlOnly, true);
  assert.deepEqual(Object.keys(value).sort(), ['observedAt', 'entryBinding', 'entryAdmission', 'attempt', 'instance', 'writer', 'coordinatorBinding', 'ownerBindingDigest', 'sourceIdentity', 'coordinatorIdentity'].sort());
  assert.deepEqual(await Promise.all(paths.map(bytesHash)), before);
  assert.deepEqual(f.calls.map(c => c.kind).sort(), ['coordinator', 'source']);
  for (const secret of Object.values(f.keys)) assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal('adoptionAuthorized' in value, false); assert.equal('settled' in value, false);
  assert.equal(f.db.prepare('SELECT state FROM upgrade_attempts').get().state, 'failed');
});

test('absent constructor loads the actual explicit artifact package, with no fixture or path fallback', async t => {
  const f = await fixture(t); assert.equal((await f.read({ Database: undefined })).instance.activationGeneration, 8);
  await assert.rejects(f.read({ Database: undefined, config: { ...f.options.config, artifactRoot: join(f.root, 'missing-artifact') } }), { code: 'ENOENT' });
});

test('normal deployed root 0755 is accepted, but a group-writable 0775 root is refused before reads', async t => {
  const f = await fixture(t); await fs.chmod(f.root, 0o755);
  assert.equal((await f.read()).instance.ready, false);
  f.calls.length = 0; await fs.chmod(f.root, 0o775);
  await assert.rejects(f.read(), { code: 'LEGACY_SOURCE_ROUTE_PRIVATE_ROOT_REQUIRED' }); assert.equal(f.calls.length, 0);
});

test('native connection starts with timeout zero before any connection PRAGMA', async t => {
  const f = await fixture(t); let initialBusyTimeout;
  const Constructor = function(path, options) {
    assert.deepEqual(options, { readonly: true, fileMustExist: true, timeout: 0 });
    const db = new Database(path, options); initialBusyTimeout = db.pragma('busy_timeout', { simple: true }); return db;
  };
  assert.equal((await f.read({ Database: Constructor })).writer.generation, 9); assert.equal(initialBusyTimeout, 0);
});

test('scope/origin inputs are fixed copies; changed scope and non-loopback authority are rejected before reads', async t => {
  const f = await fixture(t), opts = clone({ ...f.options, Database: undefined }); opts.Database = Database;
  const read = createLegacySourceRouteFreshBindings(opts);
  opts.currentOriginAuthority.sourceApi.origin = 'http://untrusted.example'; opts.config.root = '/wrong'; opts.keys.control = 'wrong';
  assert.equal((await read(f.options.scope, f.budget())).sourceIdentity.artifactDigest, sha('a'));
  await assert.rejects(read({ ...f.options.scope, attemptId: randomUUID() }, f.budget()), { code: 'LEGACY_SOURCE_ROUTE_READ_SCOPE_CHANGED' });
  assert.throws(() => createLegacySourceRouteFreshBindings({ ...f.options, currentOriginAuthority: opts.currentOriginAuthority }), /CONTROL_PRIVATE_ORIGIN_INVALID/);
});

test('database aliases must identify the original inode; a byte-identical replacement is unknown', async t => {
  const f = await fixture(t); await fs.unlink(f.servicePath); await fs.copyFile(f.path, f.servicePath); await fs.chmod(f.servicePath, 0o600);
  await assert.rejects(f.read(), { code: 'LEGACY_SOURCE_ROUTE_DATABASE_ALIAS_IDENTITY_CHANGED' }); assert.equal(f.calls.length, 0);
});

test('WAL without its existing SHM is refused before SQLite construction, without creating a sidecar', async t => {
  const f = await fixture(t); f.db.pragma('journal_mode = WAL'); f.db.exec('CREATE TABLE wal_witness(x INTEGER); INSERT INTO wal_witness VALUES(1)');
  await fs.unlink(f.path + '-shm'); let opened = 0;
  const Wrapper = function(...args) { opened++; return new Database(...args); };
  await assert.rejects(f.read({ Database: Wrapper, databaseIdentity: { ...f.options.databaseIdentity, servicePath: f.path } }), { code: 'LEGACY_SOURCE_ROUTE_EXISTING_DATABASE_SHM_REQUIRED' });
  assert.equal(opened, 0); await assert.rejects(fs.stat(f.path + '-shm'), { code: 'ENOENT' });
});

test('writable constructor and a missing unique writer key fail closed, without HTTP or business writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.read({ Database: function(p) { return new Database(p); } }), { code: 'LEGACY_SOURCE_ROUTE_READONLY_DATABASE_REQUIRED' });
  f.db.exec('ALTER TABLE platform_role_leases RENAME TO old_writer; CREATE TABLE platform_role_leases AS SELECT * FROM old_writer;');
  await assert.rejects(f.read(), { code: 'LEGACY_SOURCE_ROUTE_DATABASE_UNIQUE_READ_KEY_REQUIRED' }); assert.equal(f.calls.length, 0);
});

test('binding permissions, symlinks, hard links and replacement with identical JSON cannot attest custody', async t => {
  for (const kind of ['mode', 'symlink', 'hardlink', 'replace']) await t.test(kind, async t => {
    const f = await fixture(t), p = join(f.root, 'entry/entry-fence.json');
    if (kind === 'mode') await fs.chmod(p, 0o644);
    if (kind === 'symlink') { await fs.rename(p, p + '.saved'); await fs.symlink(p + '.saved', p); }
    if (kind === 'hardlink') await fs.link(p, p + '.alias');
    if (kind === 'replace') f.hooks.source = async () => { const raw = await fs.readFile(p); await fs.rename(p, p + '.saved'); await fs.writeFile(p, raw, { mode: 0o600 }); };
    await assert.rejects(f.read(), e => /LEGACY_SOURCE_ROUTE_(PRIVATE_BINDING_FILE_REQUIRED|FRESH_PATH_SYMLINK|BINDING_FILE_REPLACED_OR_CHANGED)/.test(e.code));
  });
});

test('actual source delegation, complete Coor tuple and writer/Owner bindings cannot be relabelled', async t => {
  for (const kind of ['source-coor', 'coor-artifact', 'coor-generation', 'source-start', 'writer', 'owners', 'ready']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'source-coor') f.source.actualCoordinatorInputFingerprint = sha('0');
    if (kind === 'coor-artifact') f.coor.artifactDigest = sha('0');
    if (kind === 'coor-generation') f.coor.coordinatorGeneration++;
    if (kind === 'source-start') f.source.startIdentity = randomUUID();
    if (kind === 'writer') f.db.prepare('UPDATE platform_role_leases SET holder_id=?').run('replacement');
    if (kind === 'owners') f.hooks.source = async () => { await write(join(f.root, 'bindings/owners.json'), { ...f.owners, activeOwnerId: 'foreign' }); };
    if (kind === 'ready') f.hooks.source = async () => { f.db.prepare('UPDATE upgrade_instances SET ready=1').run(); };
    await assert.rejects(f.read(), e => /^LEGACY_SOURCE_ROUTE_/.test(e.code));
  });
});

test('expired writer and oversized stored JSON are rejected by bounded row reads before HTTP', async t => {
  const f = await fixture(t); f.db.prepare('UPDATE platform_role_leases SET expires_at=0').run();
  await assert.rejects(f.read(), { code: 'LEGACY_SOURCE_ROUTE_CURRENT_WRITER_CHANGED' });
  f.db.prepare('UPDATE platform_role_leases SET expires_at=?').run(Date.now() + 60000);
  f.db.prepare('UPDATE upgrade_instances SET confirmed_release=?').run('x'.repeat(256 * 1024 + 1));
  await assert.rejects(f.read(), { code: 'LEGACY_SOURCE_ROUTE_FRESH_READ_BYTE_LIMIT' }); assert.equal(f.calls.length, 0);
});

test('SQLite numeric columns storing oversized TEXT are bounded before the corresponding row is materialized', async t => {
  const targets = [['upgrade_attempts', ['fence', 'lease_expires_at', 'sequence', 'generation']],
    ['upgrade_instances', ['activation_generation', 'ready']], ['platform_role_leases', ['generation', 'fence', 'expires_at']]];
  for (const [table, columns] of targets) for (const column of columns) await t.test(table + '.' + column, async t => {
    const f = await fixture(t); f.db.prepare('UPDATE ' + table + ' SET ' + column + '=?').run('not-a-number-'.repeat(24000));
    assert.equal(f.db.prepare('SELECT typeof(' + column + ') AS type FROM ' + table).get().type, 'text');
    let materialized = 0;
    const Constructor = function(path, options) {
      const db = new Database(path, options), prepare = db.prepare.bind(db);
      db.prepare = sql => { if (sql.startsWith('SELECT ') && !sql.includes('octet_length') && sql.includes(' FROM ' + table + ' WHERE ')) materialized++;
        return prepare(sql); }; return db;
    };
    await assert.rejects(f.read({ Database: Constructor }), { code: 'LEGACY_SOURCE_ROUTE_FRESH_READ_BYTE_LIMIT' });
    assert.equal(materialized, 0); assert.equal(f.calls.length, 0);
  });
});

test('Entry source origin and digest must match fixed source authority before any identity GET', async t => {
  const f = await fixture(t), foreign = { ...f.binding, oldApi: { origin: f.options.currentOriginAuthority.coordinator.origin, digest: sha('a') } };
  await write(join(f.root, 'entry/entry-binding.json'), foreign);
  await assert.rejects(f.read(), { code: 'LEGACY_SOURCE_ROUTE_ENTRY_SOURCE_IDENTITY_CHANGED' }); assert.equal(f.calls.length, 0);
});

test('per-reply and cumulative byte limits are independent of a caller offering 32MiB', async t => {
  const f = await fixture(t); f.source.extra = 'x'.repeat(256 * 1024);
  await assert.rejects(f.read(), { code: 'LEGACY_SOURCE_ROUTE_IDENTITY_REPLY_TOO_LARGE' });
  const read = createLegacySourceRouteFreshBindings(f.options);
  await assert.rejects(read(f.options.scope, { ...f.budget(), maxBytes: 1000 }), { code: 'LEGACY_SOURCE_ROUTE_FRESH_READ_BYTE_LIMIT' });
});

test('one deadline covers hanging response bodies and caller abort, with no retries or late SQL reads', async t => {
  for (const kind of ['deadline', 'abort']) await t.test(kind, async t => {
    const f = await fixture(t); let calls = 0, seenSignal;
    const fetcher = async () => { calls++; return new Response(new ReadableStream({ start() {} })); };
    const read = createLegacySourceRouteFreshBindings({ ...f.options, fetcher: (...args) => { seenSignal = args[1].signal; return fetcher(...args); } });
    const abort = new AbortController(), began = performance.now();
    const p = read(f.options.scope, { signal: abort.signal, timeoutMs: 160, maxBytes: 1024 * 1024 });
    const timer = kind === 'abort' ? setTimeout(() => abort.abort(), 80) : null;
    await assert.rejects(p, { code: 'LEGACY_SOURCE_ROUTE_FRESH_READ_EXPIRED' }); clearTimeout(timer);
    assert.ok(performance.now() - began < 1500); assert.ok(calls <= 3); if (seenSignal) assert.equal(seenSignal.aborted, true);
    assert.equal(f.db.prepare('SELECT controller_id FROM upgrade_attempts').get().controller_id, null);
  });
});

test('already-aborted reads never open a DB or send a request; HTTP errors never expose response secrets', async t => {
  const f = await fixture(t), abort = new AbortController(); abort.abort(); let opened = 0;
  const read = createLegacySourceRouteFreshBindings({ ...f.options, Database: function(...args) { opened++; return new Database(...args); } });
  await assert.rejects(read(f.options.scope, { ...f.budget(), signal: abort.signal }), { code: 'LEGACY_SOURCE_ROUTE_FRESH_READ_EXPIRED' });
  assert.equal(opened, 0); assert.equal(f.calls.length, 0);
  const secret = 'secret-auth-provider-handle';
  await assert.rejects(f.read({ fetcher: async () => new Response(secret, { status: 500 }) }), e => {
    assert.equal(String(e).includes(secret), false); return e.code === 'LEGACY_SOURCE_ROUTE_IDENTITY_GET_UNCONFIRMED';
  });
});

test('an uncooperative late fetch is cancelled after the original deadline and cannot resume collection', async t => {
  const f = await fixture(t); let respond, cancelled = 0, calls = 0;
  const pending = new Promise(resolve => { respond = resolve; });
  const read = createLegacySourceRouteFreshBindings({ ...f.options, fetcher: () => { calls++; return pending; } });
  await assert.rejects(read(f.options.scope, { ...f.budget(), timeoutMs: 120 }), { code: 'LEGACY_SOURCE_ROUTE_FRESH_READ_EXPIRED' });
  const atFailure = calls;
  respond(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, atFailure); assert.equal(cancelled, 1);
  assert.equal(f.db.prepare('SELECT state FROM upgrade_attempts').get().state, 'failed');
});
