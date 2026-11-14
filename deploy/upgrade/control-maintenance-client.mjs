import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSupervisorFact } from './supervisor-control.mjs';
import { privateLoopbackOrigin } from './control-rpc.mjs';
import { invariant } from './trust.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,180}$/;
/** Operator-only transport. It cannot choose a package/executable, grant a
 * business authority or send a normal Supervisor action. No POST is retried. */
export function createControlMaintenanceClient({ instanceId, origin, maintenanceKey, fetcher = fetch }) {
  origin = privateLoopbackOrigin(origin);
  invariant(ID.test(instanceId) && typeof maintenanceKey === 'string' && maintenanceKey.length >= 32, 'CONTROL_MAINTENANCE_CLIENT_CONFIG_INVALID');
  async function call(action, input) {
    invariant(['submit', 'advance', 'status'].includes(action) && ID.test(input?.maintenanceId), 'CONTROL_MAINTENANCE_CLIENT_REQUEST_INVALID');
    const serialized = JSON.stringify(input); invariant(Buffer.byteLength(serialized) <= 8192, 'CONTROL_MAINTENANCE_CLIENT_REQUEST_TOO_LARGE');
    const response = await fetcher(origin + '/private/control-maintenance/' + action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-internal-key': maintenanceKey, 'x-platform-instance-id': instanceId }, body: serialized, signal: AbortSignal.timeout(2000), redirect: 'error' });
    invariant(response.body, 'CONTROL_MAINTENANCE_CLIENT_RESPONSE_UNKNOWN'); let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; invariant(size <= 131072, 'CONTROL_MAINTENANCE_CLIENT_RESPONSE_TOO_LARGE'); chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    invariant(response.ok, value.code || 'CONTROL_MAINTENANCE_CLIENT_REJECTED');
    invariant(value.instanceId === instanceId && value.maintenanceId === input.maintenanceId && typeof value.durable === 'boolean' && typeof value.pending === 'boolean', 'CONTROL_MAINTENANCE_CLIENT_RESPONSE_UNKNOWN'); return value;
  }
  return { submit: input => call('submit', input), advance: input => call('advance', input), status: input => call('status', input) };
}

export async function runControlMaintenanceClient(configPath, action, requestPath) {
  invariant(isAbsolute(configPath ?? '') && isAbsolute(requestPath ?? ''), 'CONTROL_MAINTENANCE_CLIENT_PRIVATE_CONFIG_REQUIRED');
  const config = await readSupervisorFact(configPath, 16384), request = await readSupervisorFact(requestPath, 8192);
  invariant(config.value.schemaVersion === 1 && Object.keys(config.value).sort().join() === 'instanceId,maintenanceKey,origin,schemaVersion', 'CONTROL_MAINTENANCE_CLIENT_CONFIG_INVALID');
  // Both inputs contain internal authority/scope and are private operator files.
  const { lstat } = await import('node:fs/promises');
  invariant(((await lstat(configPath)).mode & 0o077) === 0 && ((await lstat(requestPath)).mode & 0o077) === 0, 'CONTROL_MAINTENANCE_CLIENT_PRIVATE_CONFIG_REQUIRED');
  invariant(['submit', 'advance', 'status'].includes(action), 'CONTROL_MAINTENANCE_CLIENT_REQUEST_INVALID');
  return createControlMaintenanceClient(config.value)[action](request.value);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runControlMaintenanceClient(process.argv[2], process.argv[3], process.argv[4]).then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
    process.stderr.write((/^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'CONTROL_MAINTENANCE_CLIENT_OUTCOME_UNKNOWN') + '\n'); process.exitCode = 1;
  });
}
