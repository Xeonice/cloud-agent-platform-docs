import { createCoordinatorClient } from './coordinator-client.mjs';
import { invariant } from './trust.mjs';

const CONTROL_METHODS = ['pending', 'claim', 'renew', 'commit', 'step', 'snapshot', 'assertFence', 'progressCheckpoint', 'contractSnapshot', 'assertContractFence'];
const BUSINESS_MUTATIONS = ['coordinatorHandoff', 'ownerCandidate', 'coordinatorRecovery', 'coordinatorResume', 'migration'];

/** Control-plane calls never select the business Coordinator binding. */
export function createControlPlaneClient({ controlOrigin, controlKey, coordinatorOrigin, coordinatorKey, coordinatorBindingPath, instanceId, fetcher = fetch, requestContext, executeCommand }) {
  invariant(controlOrigin && coordinatorOrigin && controlKey?.length >= 32 && coordinatorKey?.length >= 32, 'INDEPENDENT_CONTROL_CHANNELS_REQUIRED');
  const control = createCoordinatorClient({ origin: controlOrigin, key: controlKey, instanceId, fetcher, requestContext });
  const business = createCoordinatorClient({ origin: coordinatorOrigin, key: coordinatorKey, instanceId, fetcher, bindingPath: coordinatorBindingPath, requestContext, independentControl:true });
  const client = { ...business, instanceId };
  Object.defineProperty(client, 'origin', { get: () => business.origin, enumerable: true });
  for (const name of CONTROL_METHODS) if (typeof control[name] === 'function') client[name] = (...args) => control[name](...args);
  if (executeCommand) for (const name of BUSINESS_MUTATIONS) if (typeof business[name] === 'function') {
    client[name] = (...args) => {
      const input = args[1];
      if (['status'].includes(input?.action)) return business[name](...args);
      return executeCommand({ method: name, args, invoke: () => business[name](...args), inspect: () => ['coordinatorRecovery', 'coordinatorResume'].includes(name)
        ? business.recoveryActions(args[0]) : business[name](args[0], { ...input, action: 'status' }) });
    };
  }
  client.controllerHandoff = () => { throw Object.assign(Error('Control maintenance requires its own explicit plan'), { code: 'BUSINESS_RELEASE_CANNOT_REPLACE_CONTROL' }); };
  return client;
}
