import { timingSafeEqual } from 'node:crypto';
import { invariant } from './trust.mjs';
function parseOrigin(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null; } catch { return null; }
}
export function createControlSecurity({ instanceId, access, allowedOrigins = [] }) {
  invariant(access && typeof instanceId === 'string' && Array.isArray(allowedOrigins) && allowedOrigins.every(v => parseOrigin(v) === v), 'CONTROL_SECURITY_CONFIG_INVALID');
  const requests = new WeakMap();
  function principal(req, _res, expectedInstanceId) {
    invariant(instanceId === expectedInstanceId, 'UPGRADE_INSTANCE_MISMATCH');
    const decision = requests.get(req);
    invariant(decision?.authorized && decision.principal && decision.policyRevision === access.status().revision, 'ACCESS_AUTHORITY_REQUEST_REQUIRED');
    return decision.principal;
  }
  function sameOrigin(req) {
    const origin = typeof req.headers.origin === 'string' ? parseOrigin(req.headers.origin) : null;
    const same = parseOrigin(`${req.protocol}://${req.headers.host || ''}`);
    invariant(origin && (allowedOrigins.includes(origin) || allowedOrigins.length === 0 && origin === same), 'UPGRADE_ORIGIN_INVALID');
  }
  function mutation(req, value, requiresCapability = true) {
    sameOrigin(req);
    const bound = principal(req, null, instanceId);
    invariant(bound === value, 'ACCESS_AUTHORITY_REQUEST_REQUIRED');
    const csrf = Buffer.from(typeof req.headers['x-upgrade-csrf'] === 'string' ? req.headers['x-upgrade-csrf'] : ''), expected = Buffer.from(value.csrfToken);
    invariant(csrf.length === expected.length && timingSafeEqual(csrf, expected), 'UPGRADE_CSRF_INVALID');
    invariant(!requiresCapability || value.canUpgrade, 'UPGRADE_PERMISSION_REQUIRED');
  }
  return Object.freeze({ bind(req, decision) { requests.set(req, decision); }, principal, mutation, sameOrigin, canAuthenticate: false,
    grant(req, res, id) { const value = principal(req, res, id); mutation(req, value); return value; } });
}
