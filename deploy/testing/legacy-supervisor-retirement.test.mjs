import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCandidateSupervisor } from './legacy-supervisor-208342/candidate-supervisor.mjs';
import { createCoordinatorClient } from './legacy-supervisor-208342/coordinator-client.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const Database = require('better-sqlite3');
const { createConnection, runMigrations } = require('./apps/api/dist/platform/persistence/drizzle.connection.js');
const { UpgradeStore } = require('./apps/api/dist/platform/upgrade/upgrade-store.js');
const { UpgradeSecurity } = require('./apps/api/dist/platform/access-passcode/upgrade-security.service.js');
const { UpgradeService } = require('./apps/api/dist/platform/upgrade/upgrade-service.js');
const { UpgradeInternalController, UpgradeContractInternalController } = require('./apps/api/dist/platform/upgrade/upgrade.controller.js');
const { CoordinatorHandoff } = require('./apps/api/dist/platform/upgrade/coordinator-handoff.js');
const { UpgradeRoleHandoffs } = require('./apps/api/dist/platform/upgrade/upgrade-role-handoffs.js');
const { UpgradeObserver } = require('./apps/api/dist/platform/upgrade/upgrade-observer.js');
const { UpgradeOnlineMigration } = require('./apps/api/dist/platform/upgrade/upgrade-online-migration.js');
const { CoordinatorRecovery } = require('./apps/api/dist/platform/upgrade/coordinator-recovery.js');
const { UpgradeContractService } = require('./apps/api/dist/platform/upgrade/upgrade-contract-service.js');
const key = 'local-only-legacy-supervisor-controller-key-32';
const instanceId = 'legacy-supervisor-retirement';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'old-supervisor-boundary-')));
  const cleanup = [() => fs.rm(root, { recursive: true, force: true })];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const changes = { PLATFORM_CONTROLLER_RPC_KEY: key, MIGRATIONS_DIR: fileURLToPath(new URL('../../api/drizzle/', import.meta.url)) };
  const prior = Object.fromEntries(Object.keys(changes).map(name => [name, process.env[name]]));
  Object.assign(process.env, changes);
  cleanup.push(() => { for (const [name, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[name];else process.env[name] = value;
  } });
  const connection = createConnection(join(root, 'platform.sqlite'));runMigrations(connection.db, connection.sqlite);
  cleanup.push(() => connection.sqlite.close());
  const ledger = new Database(join(root, 'platform.sqlite'), { readonly: true, fileMustExist: true });
  ledger.pragma('query_only=ON');cleanup.push(() => ledger.close());
  const store = new UpgradeStore(connection.sqlite, { now: () => new Date() }, { next: randomUUID },
    { instanceId, ledgerSqlite: ledger, readonly: true });
  const upgrades = { store, security: { internal: (req, id) => UpgradeSecurity.prototype.internal(req, id) } };
  const module = await Test.createTestingModule({ controllers: [UpgradeInternalController, UpgradeContractInternalController],
    providers: [{ provide: UpgradeService, useValue: upgrades }, ...[CoordinatorHandoff, UpgradeRoleHandoffs, UpgradeObserver,
      UpgradeOnlineMigration, CoordinatorRecovery, UpgradeContractService].map(provide => ({ provide, useValue: {} }))] }).compile();
  const app = module.createNestApplication({ logger: false });
  const requests = [];
  app.use((req, _res, next) => { requests.push({ method: req.method, path: req.url });next(); });
  await app.listen(0, '127.0.0.1');cleanup.push(() => app.close());
  const origin = await app.getUrl();
  const coordinator = createCoordinatorClient({ origin, instanceId, key });
  const installerRoot = join(root, 'installer'), publicationRoot = join(root, 'publication');
  await fs.mkdir(join(publicationRoot, 'installed-roles'), { recursive: true });
  const readerId = 'reader-' + 'a'.repeat(32), attemptId = randomUUID(), fence = 41;
  // Original-format records only exercise the historical handler before it can
  // use these identities. They are not physical process or migration evidence.
  await fs.writeFile(join(publicationRoot, 'installed-roles', 'installed-roles.json'), JSON.stringify([
    { instanceId, kind: 'coordinator', readerId, startIdentity: 'old-reader-record', artifactDigest: 'sha256:' + 'a'.repeat(64), pid: 12345 },
  ]));
  let lifecycleCalls = 0;
  const forbidden = async () => { lifecycleCalls++;throw Error('historical lifecycle must not run'); };
  const supervisor = await createCandidateSupervisor({ root: installerRoot, instanceId, key, coordinator,
    controlEnv: { PLATFORM_CONTROL_RPC_KEY: key }, publicationRoot,
    launchAdapter: { launch: forbidden, signal: forbidden, restartInstaller: forbidden, inspect: forbidden } });
  cleanup.push(() => supervisor.close());
  const record = { instanceId, attemptId, kind: 'installer', operationId: attemptId + ':installer',
    startIdentity: 'historical-installer-record', artifactDigest: 'sha256:' + 'b'.repeat(64) };
  await fs.writeFile(join(installerRoot, 'processes', attemptId + '-installer.json'), JSON.stringify(record));
  const authorityPath = join(installerRoot, 'controller-authority.json');
  const originalAuthority = JSON.stringify({ instanceId, startIdentity: 'original-authority' });
  await fs.writeFile(authorityPath, originalAuthority);
  async function post(path, body) {
    const response = await fetch(supervisor.origin + path, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-platform-internal-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json() };
  }
  return { root, store, requests, attemptId, fence, readerId, post, authorityPath, originalAuthority,
    lifecycleCalls: () => lifecycleCalls };
}

test('historical Supervisor import closure is the exact original source and stays outside the shipped installer', async () => {
  const base = new URL('./legacy-supervisor-208342/', import.meta.url);
  const provenance = JSON.parse(await fs.readFile(new URL('provenance.json', base), 'utf8'));
  assert.equal(provenance.sourceCommit, '208342ea994555c12c3ba42ce3b6aabd0afe9df1');
  assert.equal(provenance.runtimeClosure.length, 6);
  for (const file of provenance.files) {
    const bytes = await fs.readFile(new URL(file.path, base));
    assert.equal(bytes.length, file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    for (const match of bytes.toString().matchAll(/\bfrom\s+['"]\.\/([^'"]+)['"]/g)) assert.ok(provenance.runtimeClosure.includes(match[1]));
  }
});

test('real old Supervisor cannot start, publish, activate or retire through the independent Coordinator reader', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const path of ['/start', '/publish', '/activate-installer']) {
    const response = await f.post(path, { attemptId: f.attemptId, fence: f.fence, kind: 'installer' });
    assert.equal(response.status, 409, path);assert.equal(response.body.code, 'LEGACY_CONTROL_PROTOCOL_RETIRED', path);
  }
  const contractAttemptId = randomUUID();
  const response = await f.post('/retire-reader', { contractAttemptId, fence: f.fence,
    readerId: f.readerId, operationId: contractAttemptId + ':retire:' + f.readerId });
  assert.equal(response.status, 409);assert.equal(response.body.code, 'LEGACY_CONTROL_PROTOCOL_RETIRED');
  assert.deepEqual(f.requests, [
    { method: 'POST', path: '/internal/upgrades/' + f.attemptId + '/renew' },
    { method: 'POST', path: '/internal/upgrades/' + f.attemptId + '/renew' },
    // /activate-installer skips assertFence in the original handler. The
    // snapshot route must be closed too, even for a historical adopted record.
    { method: 'GET', path: '/internal/upgrades/' + f.attemptId },
    { method: 'POST', path: '/internal/contracts/' + contractAttemptId + '/check' },
  ]);
  assert.equal(await fs.readFile(f.authorityPath, 'utf8'), f.originalAuthority);
  assert.equal(f.lifecycleCalls(), 0);
  assert.deepEqual(f.store.ledgerSqlite.prepare('SELECT * FROM upgrade_attempts').all(), []);
  const publication = await fs.readdir(join(f.root, 'publication'));
  assert.deepEqual(publication, ['installed-roles']);
});
