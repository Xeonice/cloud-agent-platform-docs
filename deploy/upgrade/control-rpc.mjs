import { invariant } from './trust.mjs';
export function privateLoopbackOrigin(value) {
  const url = new URL(value);
  invariant(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash, 'CONTROL_PRIVATE_ORIGIN_INVALID');
  return url.origin;
}
export function createPrivateControlRpc({ origin, instanceId, key, fetcher = fetch, maxBytes = 262144, timeoutMs = 2000 }) {
  const fixedOrigin = privateLoopbackOrigin(origin);
  invariant(typeof key === 'string' && key.length >= 32 && typeof instanceId === 'string' && maxBytes > 0 && maxBytes <= 8 * 1024 * 1024 && timeoutMs > 0 && timeoutMs <= 120000, 'CONTROL_PRIVATE_RPC_CONFIG_INVALID');
  return async function rpc(path, body, headers = {}) {
    invariant(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\r\n\0]/.test(path), 'CONTROL_PRIVATE_RPC_PATH_INVALID');
    const start = performance.now(), serialized = body === undefined ? undefined : JSON.stringify(body);
    invariant(serialized === undefined || Buffer.byteLength(serialized) <= maxBytes, 'CONTROL_PRIVATE_BODY_TOO_LARGE');
    const remaining = Math.ceil(timeoutMs - (performance.now() - start)); invariant(remaining > 0, 'CONTROL_PRIVATE_RPC_TIMEOUT');
    const response = await fetcher(fixedOrigin + path, { method: body === undefined ? 'GET' : 'POST', body: serialized,
      headers: { ...headers, 'content-type': 'application/json', 'x-platform-internal-key': key, 'x-platform-instance-id': instanceId }, redirect: 'error', signal: AbortSignal.timeout(remaining) });
    invariant(response.body, 'CONTROL_PRIVATE_RESPONSE_UNKNOWN');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; invariant(length <= maxBytes, 'CONTROL_PRIVATE_RESPONSE_TOO_LARGE'); chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) throw Object.assign(Error('Private control request rejected'), { code: value.error?.code || value.code || 'CONTROL_PRIVATE_RPC_FAILED', status: response.status });
    return value?.data ?? value;
  };
}
