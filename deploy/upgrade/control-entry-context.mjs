import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { invariant, canonical, digest, DIGEST } from './trust.mjs';

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const signature = (key, encoded) => createHmac('sha256', key).update('platform-entry-context-v1\n').update(encoded).digest('hex');
function config(instanceId, key) { invariant(typeof instanceId === 'string' && ID.test(instanceId) && typeof key === 'string' && key.length >= 32, 'ENTRY_CONTEXT_CONFIG_INVALID'); }
function validPublicContext(value) {
  return keys(value, ['schemaVersion', 'instanceId', 'remoteAddress', 'clientIp', 'method', 'path', 'issuedAt', 'nonce']) && value.schemaVersion === 1 && ID.test(value.instanceId) && (value.remoteAddress === null || typeof value.remoteAddress === 'string' && isIP(value.remoteAddress) !== 0) && (value.clientIp === 'unknown' || typeof value.clientIp === 'string' && isIP(value.clientIp) !== 0) && METHODS.has(value.method) && typeof value.path === 'string' && value.path.length <= 2048 && value.path.startsWith('/') && !/[\r\n\0]/.test(value.path) && Number.isSafeInteger(value.issuedAt) && UUID.test(value.nonce);
}
export function signEntryContext({ instanceId, key, remoteAddress, clientIp = remoteAddress ?? 'unknown', method, path, clock = Date.now, nonce = randomUUID() }) {
  config(instanceId, key);
  const value = { schemaVersion: 1, instanceId, remoteAddress, clientIp, method, path, issuedAt: clock(), nonce };
  invariant(validPublicContext(value), 'ENTRY_CONTEXT_INVALID');
  const encoded = Buffer.from(canonical(value)).toString('base64url');
  return { 'x-platform-entry-context': encoded, 'x-platform-entry-signature': signature(key, encoded) };
}
/** The Agent must keep one verifier for its lifetime, not construct one per request. */
export function createEntryContextVerifier({ instanceId, key, clock = Date.now, monotonicClock = () => performance.now(), maxAgeMs = 10000, maxNonces = 4096, futureSkewMs = 1000 }) {
  config(instanceId, key);
  invariant(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 10000 && Number.isSafeInteger(maxNonces) && maxNonces > 0 && maxNonces <= 65536 && Number.isSafeInteger(futureSkewMs) && futureSkewMs >= 0 && futureSkewMs <= 1000, 'ENTRY_CONTEXT_CONFIG_INVALID');
  const seen = new Map();
  function verify(req) {
    invariant(loopback(req.socket?.remoteAddress), 'ENTRY_CONTEXT_PEER_INVALID');
    const encoded = req.headers?.['x-platform-entry-context'], supplied = req.headers?.['x-platform-entry-signature'];
    invariant(typeof encoded === 'string' && encoded.length <= 8192 && typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) && equal(signature(key, encoded), supplied), 'ENTRY_CONTEXT_SIGNATURE_INVALID');
    let value; try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { invariant(false, 'ENTRY_CONTEXT_INVALID'); }
    invariant(validPublicContext(value) && value.instanceId === instanceId && value.method === req.method && value.path === req.url, 'ENTRY_CONTEXT_REQUEST_MISMATCH');
    const age = clock() - value.issuedAt, monotonic = monotonicClock();
    invariant(Number.isFinite(age) && age >= -futureSkewMs && age <= maxAgeMs && Number.isFinite(monotonic), 'ENTRY_CONTEXT_EXPIRED');
    for (const [nonce, expiresAt] of seen) if (expiresAt <= monotonic) seen.delete(nonce);
    invariant(!seen.has(value.nonce), 'ENTRY_CONTEXT_REPLAY');
    // Overload fails closed; unexpired replay guards are never evicted to admit traffic.
    invariant(seen.size < maxNonces, 'ENTRY_CONTEXT_REPLAY_CAPACITY');
    seen.set(value.nonce, monotonic + maxAgeMs + futureSkewMs);
    return value;
  }
  return { verify, size: () => seen.size };
}
export function stripEntryForwardingHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const key = name.toLowerCase();
    return key !== 'forwarded' && key !== 'x-real-ip' && !key.startsWith('x-forwarded-') && !key.startsWith('x-platform-') && !['connection', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(key);
  }));
}
function validControl(value) {
  return keys(value, ['schemaVersion', 'epoch', 'operationId', 'executorId', 'kind'], ['recoveryId', 'expectedBindingDigest']) && value.schemaVersion === 1 && Number.isSafeInteger(value.epoch) && value.epoch > 0 && typeof value.operationId === 'string' && ID.test(value.operationId) && typeof value.executorId === 'string' && ID.test(value.executorId) && ['upgrade', 'recovery', 'maintenance', 'contract'].includes(value.kind) && (value.kind === 'recovery' ? typeof value.recoveryId === 'string' && ID.test(value.recoveryId) : value.recoveryId === undefined) && (value.expectedBindingDigest === undefined || typeof value.expectedBindingDigest === 'string' && DIGEST.test(value.expectedBindingDigest));
}
export function encodeEntryControlContext(value) {
  invariant(validControl(value), 'ENTRY_CONTROL_CONTEXT_INVALID');
  return Buffer.from(canonical(value)).toString('base64url');
}
export function decodeEntryControlContext(encoded) {
  invariant(typeof encoded === 'string' && encoded.length <= 4096, 'ENTRY_CONTROL_CONTEXT_INVALID');
  let value; try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { invariant(false, 'ENTRY_CONTROL_CONTEXT_INVALID'); }
  invariant(validControl(value), 'ENTRY_CONTROL_CONTEXT_INVALID');
  return value;
}
export function entryControlHeaders({ key, context }) {
  invariant(typeof key === 'string' && key.length >= 32, 'ENTRY_CONTEXT_CONFIG_INVALID');
  return { 'x-platform-entry-controller-key': key, 'x-platform-entry-control-context': encodeEntryControlContext(context) };
}
export function persistedEntryBinding(value) {
  invariant(object(value), 'INVALID_BINDING');
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['inFlight', 'activeWS', 'httpByDigest', 'wsByDigest', 'controlAdmission'].includes(key)));
}
export const entryBindingDigest = value => digest(persistedEntryBinding(value));
