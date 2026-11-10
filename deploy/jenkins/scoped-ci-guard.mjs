import { exactParametersMatch, scopedRequests } from "./jenkins-discover.mjs";
import { canonicalJenkinsLocation } from "./deployment-platform.mjs";

const GiB = 1024 ** 3;
export const SCOPED_CI_CAPACITY = Object.freeze({
  startBytes: 8 * GiB,
  growthBytes: 3 * GiB,
  reserveBytes: 4 * GiB,
  maxSampleAgeMs: 2000,
});
const bytes = (value) => Number.isSafeInteger(value) && value >= 0;
// Root's external Mac monitor supplies actual statfs and allocated disk blocks.
// Disk allocation is sampled for the one explicit build VM, not Docker's virtual
// image-size estimate. No cache eviction or filesystem mutation occurs here.
export function capacityDecision(baseline, sample, now = Date.now()) {
  const names = ["hostFreeBytes", "vmFreeBytes", "buildVmAllocatedBytes"];
  if (
    !baseline ||
    !sample ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    names.some((name) => !bytes(baseline[name]) || !bytes(sample[name])) ||
    !Number.isSafeInteger(sample.observedAtMs) ||
    !Number.isSafeInteger(baseline.observedAtMs) ||
    baseline.observedAtMs < 0 ||
    baseline.observedAtMs > sample.observedAtMs ||
    sample.observedAtMs > now ||
    now - sample.observedAtMs > SCOPED_CI_CAPACITY.maxSampleAgeMs
  )
    return { admitted: false, reason: "capacity-observation-missing-or-stale" };
  if (
    baseline.hostFreeBytes < SCOPED_CI_CAPACITY.startBytes ||
    baseline.vmFreeBytes < SCOPED_CI_CAPACITY.startBytes
  )
    return { admitted: false, reason: "start-below-8gib" };
  const growth = Math.max(
    0,
    sample.buildVmAllocatedBytes - baseline.buildVmAllocatedBytes,
    baseline.hostFreeBytes - sample.hostFreeBytes,
    baseline.vmFreeBytes - sample.vmFreeBytes,
  );
  if (
    sample.hostFreeBytes < SCOPED_CI_CAPACITY.reserveBytes ||
    sample.vmFreeBytes < SCOPED_CI_CAPACITY.reserveBytes
  )
    return {
      admitted: false,
      reason: "reserve-below-4gib",
      growthBytes: growth,
    };
  if (growth > SCOPED_CI_CAPACITY.growthBytes)
    return {
      admitted: false,
      reason: "allocation-above-3gib",
      growthBytes: growth,
    };
  return { admitted: true, reason: "within-budget", growthBytes: growth };
}

// Return a stop endpoint only after matching the durable original dispatch and
// a fresh response from that exact queue/build ID. This pure helper never sends
// requests. A reused historical build is not an owned dispatch and is excluded.
export function ownedStopEndpoint(request, dispatch, observation) {
  const scope = scopedRequests(request);
  const selected = scope.requests.find((item) => item.repo === dispatch?.repo);
  if (
    !selected ||
    dispatch.scopeKey !== scope.key ||
    dispatch.dispatchedByScope !== true ||
    dispatch.job !== selected.job ||
    dispatch.sha !== selected.sha ||
    dispatch.ref !== selected.ref ||
    dispatch.key !== selected.key ||
    !exactParametersMatch(
      {
        actions: [
          {
            parameters: Object.entries(dispatch.params ?? {}).map(
              ([name, value]) => ({ name, value }),
            ),
          },
        ],
      },
      selected.params,
    ) ||
    !Number.isSafeInteger(dispatch.queueId) ||
    dispatch.queueId < 1 ||
    !exactParametersMatch(observation, selected.params)
  )
    throw new Error("Refusing to stop an unowned scoped CI execution");
  if (dispatch.buildNumber == null) {
    if (
      observation.id !== dispatch.queueId ||
      observation.executable ||
      observation.cancelled
    )
      throw new Error(
        "Scoped queue identity changed; resolve the actual executable first",
      );
    return { method: "POST", path: `queue/cancelItem?id=${dispatch.queueId}` };
  }
  const expectedUrl = `http://127.0.0.1:8080/job/${selected.job}/${dispatch.buildNumber}/`;
  if (
    !Number.isSafeInteger(dispatch.buildNumber) ||
    dispatch.buildNumber < 1 ||
    dispatch.executableQueueId !== dispatch.queueId ||
    observation.number !== dispatch.buildNumber ||
    observation.queueId !== dispatch.queueId ||
    canonicalJenkinsLocation(observation.url) !== expectedUrl ||
    observation.building !== true
  )
    throw new Error("Scoped build identity changed or it is no longer running");
  return {
    method: "POST",
    path: `job/${selected.job}/${dispatch.buildNumber}/stop`,
  };
}

export function ownedChildStopEndpoint(
  request,
  webDispatch,
  webObservation,
  childDispatch,
  childObservation,
) {
  if (
    !Number.isSafeInteger(webDispatch?.buildNumber) ||
    webDispatch.buildNumber < 1
  )
    throw new Error("An actual owned Web build is required");
  ownedStopEndpoint(request, webDispatch, webObservation);
  const scope = scopedRequests(request),
    child = scope.requests.find((item) => item.repo === "project");
  const expectedUrl = `http://127.0.0.1:8080/job/${child.job}/${childDispatch?.buildNumber}/`;
  const causes = (childObservation?.actions ?? []).flatMap(
    (action) => action.causes ?? [],
  );
  if (
    webDispatch.repo !== "web" ||
    childDispatch?.scopeKey !== scope.key ||
    childDispatch.job !== child.job ||
    childDispatch.webBuildNumber !== webDispatch.buildNumber ||
    !Number.isSafeInteger(childDispatch.queueId) ||
    childDispatch.queueId < 1 ||
    !Number.isSafeInteger(childDispatch.buildNumber) ||
    childDispatch.buildNumber < 1 ||
    childObservation?.number !== childDispatch.buildNumber ||
    childObservation.queueId !== childDispatch.queueId ||
    canonicalJenkinsLocation(childObservation.url) !== expectedUrl ||
    childObservation.building !== true ||
    !exactParametersMatch(childObservation, child.params) ||
    !causes.some(
      (cause) =>
        cause._class === "hudson.model.Cause$UpstreamCause" &&
        cause.upstreamProject === webDispatch.job &&
        cause.upstreamBuild === webDispatch.buildNumber,
    )
  )
    throw new Error("Refusing to stop an unowned contract child");
  return {
    method: "POST",
    path: `job/${child.job}/${childDispatch.buildNumber}/stop`,
  };
}

export function ownedChildQueueStopEndpoint(
  request,
  webDispatch,
  webObservation,
  childObservation,
) {
  ownedStopEndpoint(request, webDispatch, webObservation);
  const scope = scopedRequests(request),
    child = scope.requests.find((item) => item.repo === "project");
  const causes = (childObservation?.actions ?? []).flatMap(
    (action) => action.causes ?? [],
  );
  if (
    webDispatch.repo !== "web" ||
    !Number.isSafeInteger(webDispatch.buildNumber) ||
    childObservation?.task?.name !== child.job ||
    !Number.isSafeInteger(childObservation.id) ||
    childObservation.id < 1 ||
    childObservation.executable ||
    childObservation.cancelled ||
    !exactParametersMatch(childObservation, child.params) ||
    !causes.some(
      (cause) =>
        cause._class === "hudson.model.Cause$UpstreamCause" &&
        cause.upstreamProject === webDispatch.job &&
        cause.upstreamBuild === webDispatch.buildNumber,
    )
  )
    throw new Error("Refusing to cancel an unowned contract queue item");
  return { method: "POST", path: `queue/cancelItem?id=${childObservation.id}` };
}
