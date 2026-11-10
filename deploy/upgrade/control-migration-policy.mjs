import { invariant } from './trust.mjs';

/** The legacy executor stops the public entry before its replacement is ready.
 * Its old recovery path remains necessary for already-dispatched operations,
 * but it is not an online-adoption implementation. Configuration, a successful
 * package check, or a completed capability probe cannot authorize that sequence.
 */
export function controlMigrationExecutionPolicy(command) {
  const supported = ['plan', 'prepare', 'status', 'apply', 'resume', 'rollback'];
  invariant(supported.includes(command), 'CONTROL_MIGRATION_COMMAND_INVALID');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'control-migration-execution-policy',
    command,
    state: ['apply', 'resume'].includes(command) ? 'blocked' : 'available',
    onlineAdoptionImplemented: false,
    authorizesSourceStop: false,
    originalRecoveryAvailable: true,
    blockers: Object.freeze(['apply', 'resume'].includes(command)
      ? ['CONTROL_MIGRATION_STOP_FIRST_DISABLED'] : []),
  });
}

export function assertControlMigrationCommand(command) {
  const policy = controlMigrationExecutionPolicy(command);
  invariant(policy.state !== 'blocked', 'CONTROL_MIGRATION_STOP_FIRST_DISABLED');
  return policy;
}
