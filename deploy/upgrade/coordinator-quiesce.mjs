import { invariant } from './trust.mjs';

// Old Coordinators reject a busy provision/clone/cleanup before releasing the
// writer. Only their completed 409 plus the original durable prepared row can
// authorize another invocation. Timeout, transport loss and later stages are
// deliberately not retryable. This does not make unknown Control commands safe
// to replay; that journal continues to reject them independently.
export async function quiesceCoordinator({ coordinator, attemptId, body, deadline,
  clock = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  // The old status handler checks operation/plan/fence before returning, but
  // does not echo/check candidate. Keep our own exact original value; every
  // mutating quiesce still runs the old candidate equality/identity checks.
  const fixed = structuredClone({ ...body, action: 'quiesce' });
  const remaining = () => {
    const value = deadline - clock();
    invariant(Number.isFinite(value) && value > 0, 'ROLE_PREPARATION_STARTUP_EXCEEDED');
    return value;
  };
  while (true) {
    remaining();
    await coordinator.assertFence(attemptId, fixed.fence);
    remaining();
    try {
      // Never race an in-flight mutation against a local timeout: its eventual
      // result could be quiesced. A successful call goes straight to the
      // existing release/adopt critical window, with no startup deadline check.
      return await coordinator.coordinatorHandoff(attemptId, structuredClone(fixed));
    } catch (error) {
      if (error?.status !== 409 || error.code !== 'BACKGROUND_WORK_PENDING') throw error;
      remaining();
      await coordinator.assertFence(attemptId, fixed.fence);
      remaining();
      const status = await coordinator.coordinatorHandoff(attemptId,
        { ...structuredClone(fixed), action: 'status' });
      remaining();
      invariant(status?.stage === 'prepared' && status.applied === false &&
        status.commitKnown === true && status.resumeAction === 'quiesce' &&
        status.unknown !== true && status.definitelyNotApplied !== true,
      'COORDINATOR_QUIESCE_RETRY_UNPROVEN');
      await coordinator.assertFence(attemptId, fixed.fence);
      await pause(Math.min(100, remaining()));
    }
  }
}
