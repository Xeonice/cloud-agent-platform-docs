import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { invariant } from './trust.mjs';
import { createControlAccessHttpHandler } from './control-access-authority.mjs';

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
function shape(value, required, optional = []) {
  invariant(object(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'CONTROL_COMMAND_INVALID');
  return value;
}
async function readBody(req, maxBytes = 128 * 1024, timeoutMs = 2000) {
  invariant(!req.headers['content-length'] || Number(req.headers['content-length']) <= maxBytes, 'CONTROL_BODY_TOO_LARGE');
  const chunks = []; let size = 0, timer;
  try {
    await Promise.race([
      (async () => { for await (const chunk of req) { size += chunk.length; invariant(size <= maxBytes, 'CONTROL_BODY_TOO_LARGE'); chunks.push(chunk); } })(),
      new Promise((_, fail) => { timer = setTimeout(() => { fail(Object.assign(Error('Body deadline'), { code: 'CONTROL_BODY_TIMEOUT', status: 408 })); req.destroy(); }, timeoutMs); timer.unref(); }),
    ]);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(Error('Invalid JSON'), { code: 'CONTROL_COMMAND_INVALID', status: 400 }); }
  } finally { clearTimeout(timer); }
}
function decorateResponse(res) {
  res.append = (name, value) => { const old = res.getHeader(name); res.setHeader(name, old === undefined ? value : [...(Array.isArray(old) ? old : [old]), value]); };
  return res;
}

/** The stable listener owns only control/auth requests. All business RPCs stay elsewhere. */
export async function createControlHttpServer({
  instanceId, key, businessKey, accessKey = key, access, service, store, authority,
  schemas, verifyEntryRequest, claim, renew, criticalAuthority,
  controlStatus, recoveryStatus = () => null, recoveryAuthority, diagnosticsStatus = () => null,
  metadata, contractAuthority, retireContractReader,
  onSpan, host = '127.0.0.1', port = 0, maxRequests = 64,
}) {
  invariant(instanceId === store?.instanceId && typeof key === 'string' && key.length >= 32 && access && service && schemas && typeof verifyEntryRequest === 'function' && typeof claim === 'function' && typeof renew === 'function', 'CONTROL_HTTP_CONFIG_REQUIRED');
  invariant(businessKey === undefined || typeof businessKey === 'string' && businessKey.length >= 32 && businessKey !== key && businessKey !== accessKey, 'CONTROL_BUSINESS_ROLE_KEY_MUST_BE_SEPARATE');
  const privateAccess = createControlAccessHttpHandler({ authority: access, instanceId, key: accessKey });
  let requests = 0, closing = false;
  const sockets = new Set();
  const server = http.createServer(async (req, rawRes) => {
    const res = decorateResponse(rawRes), started = performance.now(), traceId = randomUUID();
    let requestKind = 'control-read', admitted = false;
    const reply = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      const bytes = JSON.stringify(value);
      invariant(Buffer.byteLength(bytes) <= 16 * 1024 * 1024, 'CONTROL_RESPONSE_TOO_LARGE');
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-platform-control-trace-id': traceId });
      res.end(bytes);
    };
    try {
      invariant(!closing && requests < maxRequests, 'CONTROL_HTTP_BUSY'); requests++; admitted = true;
      if (await privateAccess(req, res)) return;
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (req.method === 'GET' && path === '/metadata' && !url.search) {
        invariant(loopback(req.socket.remoteAddress) && equal(req.headers['x-platform-internal-key'], key) && typeof metadata === 'function', 'CONTROL_INTERNAL_AUTH');
        reply(200, metadata()); return;
      }
      if (path.startsWith('/internal/')) {
        const businessCallback = req.method === 'POST' && !url.search &&
          (path === '/internal/control/contracts/retire-reader' || /^\/internal\/upgrades\/[a-f0-9-]{36}\/critical-authority$/.test(path));
        invariant(loopback(req.socket.remoteAddress) && (equal(req.headers['x-platform-internal-key'], key) || businessCallback && businessKey && equal(req.headers['x-platform-internal-key'], businessKey)) && req.headers['x-platform-instance-id'] === instanceId, 'CONTROL_INTERNAL_AUTH');
        if (req.method === 'GET' && path === '/internal/control/authority' && !url.search) { reply(200, authority.observe()); return; }
        if (req.method === 'POST' && path === '/internal/control/authority/verify' && !url.search) {
          const body = shape(await readBody(req, 4096), ['epoch', 'operationId', 'executorId']);
          invariant(positive(body.epoch) && typeof body.operationId === 'string' && body.operationId.length <= 200 && typeof body.executorId === 'string' && body.executorId.length <= 200, 'CONTROL_COMMAND_INVALID');
          reply(200, authority.assert(body)); return;
        }
        if (req.method === 'GET' && path === '/internal/upgrades/controller-capabilities' && !url.search) { reply(200, { controlFastPath: 1, progressEvidenceReference: 1 }); return; }
        if (req.method === 'GET' && path === '/internal/upgrades/pending' && !url.search) { reply(200, store.pending()); return; }
        if (req.method === 'POST' && path === '/internal/control/contracts/retire-reader' && !url.search) {
          const body = shape(await readBody(req, 4096), ['contractAttemptId', 'fence', 'operationId', 'readerId']);
          invariant(UUID.test(body.contractAttemptId) && positive(body.fence) && typeof body.readerId === 'string' && /^reader-[a-f0-9]{32}$/.test(body.readerId) && body.operationId === body.contractAttemptId + ':retire:' + body.readerId && typeof retireContractReader === 'function', 'CONTROL_COMMAND_INVALID');
          reply(200, await retireContractReader(body)); return;
        }
        const contract = /^\/internal\/contracts\/([a-f0-9-]{36})(\/check)?$/.exec(path);
        if (contract && UUID.test(contract[1]) && !url.search) {
          invariant(service.contracts, 'CONTRACT_UNAVAILABLE');
          if (req.method === 'GET' && !contract[2]) { reply(200, service.contracts.store.snapshot(contract[1])); return; }
          invariant(req.method === 'POST' && contract[2] === '/check' && typeof contractAuthority === 'function', 'CONTROL_RPC_NOT_FOUND');
          const body = shape(await readBody(req, 4096), ['fence']); invariant(positive(body.fence), 'CONTROL_COMMAND_INVALID');
          contractAuthority(contract[1], body.fence); reply(200, service.contracts.check(contract[1], body.fence)); return;
        }
        const match = /^\/internal\/upgrades\/([a-f0-9-]{36})(?:\/(claim|authority-check|lease-renew|renew|progress-checkpoint|commit-receipt|commit|critical-authority|steps\/[^/]+))?$/.exec(path);
        invariant(match && UUID.test(match[1]), 'CONTROL_RPC_NOT_FOUND');
        const [, id, action] = match;
        if (req.method === 'GET' && !action && !url.search) { reply(200, store.snapshot(id)); return; }
        if (req.method === 'GET' && action?.startsWith('steps/') && !url.search) { reply(200, store.step(id, decodeURIComponent(action.slice(6)))); return; }
        if (req.method === 'GET' && action === 'progress-checkpoint') {
          requestKind = 'progress-checkpoint';
          invariant([...url.searchParams.keys()].sort().join(',') === 'fence,generation', 'CONTROL_COMMAND_INVALID');
          const fence = Number(url.searchParams.get('fence')), generation = Number(url.searchParams.get('generation'));
          invariant(positive(fence) && positive(generation), 'CONTROL_COMMAND_INVALID');
          assertUpgrade(id, fence); reply(200, store.progressCheckpoint(id, fence, generation)); return;
        }
        invariant(req.method === 'POST' && !url.search, 'CONTROL_RPC_NOT_FOUND');
        const body = await readBody(req);
        if (action === 'claim') {
          shape(body, ['controllerId', 'leaseMs']); invariant(typeof body.controllerId === 'string' && body.controllerId.length > 0 && body.controllerId.length <= 180 && Number.isSafeInteger(body.leaseMs) && body.leaseMs >= 500 && body.leaseMs <= 120000, 'CONTROL_COMMAND_INVALID');
          reply(200, await claim(id, body.controllerId, body.leaseMs)); return;
        }
        if (action === 'authority-check') {
          requestKind = 'fence-check'; shape(body, ['fence'], ['generation']); invariant(positive(body.fence) && (body.generation === undefined || positive(body.generation)), 'CONTROL_COMMAND_INVALID');
          if (req.headers['x-platform-recovery-id']) {
            invariant(typeof recoveryAuthority === 'function', 'CONTROL_RECOVERY_SCOPE_UNAVAILABLE');
            reply(200, recoveryAuthority({ attemptId: id, fence: body.fence, recoveryId: req.headers['x-platform-recovery-id'], epoch: Number(req.headers['x-platform-control-epoch']) })); return;
          }
          assertUpgrade(id, body.fence); reply(200, store.authorityCheck(id, body.fence, body.generation)); return;
        }
        if (action === 'lease-renew' || action === 'renew') {
          requestKind = body.checkOnly === true ? 'fence-check' : 'lease-renew';
          if (action === 'lease-renew') shape(body, ['fence', 'generation', 'controllerId']); else shape(body, ['fence', 'controllerId'], ['checkOnly']);
          invariant(positive(body.fence), 'CONTROL_COMMAND_INVALID');
          if (body.checkOnly === true) { invariant(body.controllerId === null, 'CONTROL_COMMAND_INVALID'); assertUpgrade(id, body.fence); reply(200, store.authorityCheck(id, body.fence)); return; }
          invariant(typeof body.controllerId === 'string' && body.controllerId.length > 0 && body.controllerId.length <= 180 && (action !== 'lease-renew' || positive(body.generation)), 'CONTROL_COMMAND_INVALID');
          reply(200, await renew(id, body)); return;
        }
        if (action === 'critical-authority') {
          shape(body, ['fence', 'generation', 'phase']); invariant(positive(body.fence) && positive(body.generation) && ['quiesce', 'release', 'adopt'].includes(body.phase) && typeof criticalAuthority === 'function', 'CONTROL_COMMAND_INVALID');
          assertUpgrade(id, body.fence); reply(200, await criticalAuthority(id, body)); return;
        }
        invariant(action === 'commit' || action === 'commit-receipt', 'CONTROL_RPC_NOT_FOUND'); requestKind = 'event-commit';
        shape(body, ['fence', 'generation', 'expectedSequence', 'eventId', 'kind', 'payload']);
        invariant(positive(body.fence) && positive(body.generation) && Number.isSafeInteger(body.expectedSequence) && body.expectedSequence >= 0 && UUID.test(body.eventId) && ['progress', 'step-applied', 'deferred', 'failed', 'activation-confirmed', 'ready-revoked'].includes(body.kind) && object(body.payload), 'CONTROL_COMMAND_INVALID');
        assertUpgrade(id, body.fence);
        reply(200, await (action === 'commit-receipt' ? service.commitReceipt(id, body) : service.commit(id, body))); return;
      }
      invariant(path === '/api/system/access-passcode' || path === '/api/system/upgrade' || path.startsWith('/api/system/upgrade/'), 'CONTROL_RPC_NOT_FOUND');
      const entry = verifyEntryRequest(req);
      // Preserve the actual external address. A loopback proxy must not turn a
      // remote browser into the optional local-operator access exception.
      req.accessClientIp = entry.clientIp;
      req.controlEntry = entry;
      req.protocol = 'http'; req.get = name => req.headers[name.toLowerCase()];
      const bearer = req.headers.authorization, direct = req.headers['x-access-passcode'];
      const authRequest = { remoteAddress: entry.remoteAddress, clientIp: entry.clientIp,
        ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
        ...(typeof bearer === 'string' && bearer.startsWith('Bearer ') ? { passcode: bearer.slice(7) } : typeof direct === 'string' ? { passcode: direct } : {}) };
      const decision = await access.evaluate(authRequest, 'http');
      if (!decision.authorized) {
        const failure = decision.failure || {};
        const code = failure.kind === 'locked' ? 'PASSCODE_LOCKED' : failure.kind === 'invalid' ? 'PASSCODE_INVALID' : 'PASSCODE_REQUIRED';
        reply(failure.kind === 'locked' ? 429 : 401, { code, message: '需要有效的实例访问口令', retryable: false, ...failure, traceId }); return;
      }
      service.security.bind(req, decision);
      if (decision.viewerCookie) res.append('Set-Cookie', decision.viewerCookie);
      if (decision.sessionToken) res.append('Set-Cookie', access.sessionCookie(decision.sessionToken));
      if (path === '/api/system/access-passcode') {
        invariant(req.method === 'PUT' && !url.search, 'CONTROL_RPC_NOT_FOUND');
        service.security.sameOrigin(req);
        const body = schemas.AccessPasscodeActionSchema.parse(await readBody(req, 16384));
        const changed = await access.change({ request: authRequest, ...body });
        if (changed.sessionToken) res.append('Set-Cookie', access.sessionCookie(changed.sessionToken));
        reply(200, changed.result); return;
      }
      if (req.method === 'GET' && path === '/api/system/upgrade/status' && !url.search) {
        const status = await service.status(req, res);
        const recovery = recoveryStatus(), diagnostics = diagnosticsStatus();
        reply(200, schemas.UpgradeStatusSchema.parse({ ...status, ...(recovery ? { recovery } : {}), ...(controlStatus ? { controlSystem: controlStatus() } : {}), ...(diagnostics ? { diagnostics } : {}) })); return;
      }
      if (req.method === 'POST' && path === '/api/system/upgrade/access' && !url.search) {
        schemas.UpgradeAccessSchema.parse(await readBody(req, 16384));
        service.security.mutation(req, decision.principal);
        reply(200, await service.status(req, res)); return;
      }
      if (req.method === 'POST' && path === '/api/system/upgrade/requests' && !url.search) { requestKind = 'user-upgrade-request'; reply(202, await service.request(req, res, schemas.UpgradeRequestSchema.parse(await readBody(req, 16384)))); return; }
      const lookup = /^\/api\/system\/upgrade\/requests\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === 'GET' && lookup && UUID.test(lookup[1]) && !url.search) { reply(200, service.lookup(req, res, lookup[1])); return; }
      const contractLookup = /^\/api\/system\/upgrade\/contracts\/requests\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === 'GET' && contractLookup && UUID.test(contractLookup[1]) && !url.search) { invariant(service.contracts, 'CONTRACT_UNAVAILABLE'); reply(200, service.contracts.lookup(req, res, contractLookup[1])); return; }
      if (req.method === 'POST' && path === '/api/system/upgrade/contracts/requests' && !url.search) { invariant(service.contracts, 'CONTRACT_UNAVAILABLE'); reply(202, await service.contracts.request(req, res, schemas.UpgradeContractRequestSchema.parse(await readBody(req, 16384)))); return; }
      throw Object.assign(Error('Unknown control route'), { code: 'CONTROL_RPC_NOT_FOUND', status: 404 });
    } catch (failure) {
      const code = /^[A-Z0-9_]{1,100}$/.test(failure.code || '') ? failure.code : failure.name === 'ZodError' ? 'CONTROL_COMMAND_INVALID' : 'CONTROL_UNAVAILABLE';
      const status = failure.status || failure.getStatus?.() || (code === 'CONTROL_INTERNAL_AUTH' || code.startsWith('ENTRY_CONTEXT_') || ['UPGRADE_ORIGIN_INVALID', 'UPGRADE_CSRF_INVALID', 'UPGRADE_PERMISSION_REQUIRED'].includes(code) ? 403 : code === 'CONTROL_RPC_NOT_FOUND' ? 404 : code === 'CONTROL_COMMAND_INVALID' ? 400 : ['CONTROL_HTTP_BUSY', 'ACCESS_AUTHORITY_REQUEST_REQUIRED', 'CONTROL_UNAVAILABLE'].includes(code) ? 503 : 409);
      reply(status, { code, message: '升级控制请求未完成', retryable: false, traceId });
    } finally {
      if (admitted) requests--;
      onSpan?.({ traceId, role: 'control', phase: requestKind === 'user-upgrade-request' ? 'accepted' : requestKind, requestKind: requestKind === 'user-upgrade-request' ? 'control-read' : requestKind, elapsedMs: performance.now() - started, outcome: res.statusCode < 400 ? 'ok' : 'rejected' });
    }
  });
  function assertUpgrade(id, fence) { authority.assert({ operationId: id, epoch: fence, kind: 'upgrade' }); }
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.headersTimeout = 5000; server.requestTimeout = 5000;
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  return { server, origin: `http://${host}:${server.address().port}`, async close() { closing = true; const stopped = new Promise(ok => server.close(ok)); server.closeIdleConnections(); for (const socket of sockets) socket.destroy(); await stopped; } };
}
