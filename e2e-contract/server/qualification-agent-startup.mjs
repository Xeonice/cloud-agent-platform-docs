// Setup readiness only. Service SLOs and the Native total deadline are unchanged.
export const QUALIFICATION_TOOL_STARTUP_MS = 180000;
export const QUALIFICATION_COUNTER_STARTUP_MS = 60000;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const need = (value, code) => { if (!value) fail(code); };
const time = (value) => Number.isSafeInteger(value) && value >= 0;

export function inspectQualificationToolStartup({ taskId, requestAtMs, acceptedAtMs, nowMs, requests }) {
  need(typeof taskId === "string" && /^[a-f0-9-]{36}$/.test(taskId) && time(requestAtMs) && time(acceptedAtMs) && time(nowMs) && requestAtMs <= acceptedAtMs && acceptedAtMs <= nowMs && Array.isArray(requests), "AGENT_STARTUP_SCOPE_INVALID");
  const deadlineAtMs = requestAtMs + QUALIFICATION_TOOL_STARTUP_MS;
  const issued = requests.filter((row) => row?.taskId === taskId && row.phase === "tool-issued");
  need(issued.length <= 1, "AGENT_STARTUP_TOOL_ISSUE_AMBIGUOUS");
  if (issued.length === 0) {
    need(nowMs < deadlineAtMs, "AGENT_TOOL_STARTUP_TIMEOUT");
    return { phase: "waiting-for-tool", deadlineAtMs, elapsedMs: nowMs - requestAtMs };
  }
  const toolIssuedAtMs = Date.parse(issued[0].at);
  need(time(toolIssuedAtMs) && toolIssuedAtMs >= requestAtMs && toolIssuedAtMs <= nowMs, "AGENT_STARTUP_TOOL_TIME_INVALID");
  need(toolIssuedAtMs <= deadlineAtMs, "AGENT_TOOL_STARTUP_TIMEOUT");
  return { phase: "tool-issued", toolIssuedAtMs, deadlineAtMs, elapsedMs: toolIssuedAtMs - requestAtMs };
}

export function inspectQualificationCounterStartup({ toolIssuedAtMs, nowMs, counter, firstIdentity }) {
  need(time(toolIssuedAtMs) && time(nowMs) && nowMs >= toolIssuedAtMs, "AGENT_STARTUP_COUNTER_TIME_INVALID");
  const deadlineAtMs = toolIssuedAtMs + QUALIFICATION_COUNTER_STARTUP_MS;
  need(nowMs <= deadlineAtMs, "AGENT_COUNTER_STARTUP_TIMEOUT");
  if (counter === undefined) return { phase: "waiting-for-counter", deadlineAtMs, elapsedMs: nowMs - toolIssuedAtMs, identity: firstIdentity ?? null };
  need(counter && Number.isSafeInteger(counter.pid) && counter.pid > 0 && typeof counter.birth === "string" && /^[1-9][0-9]*$/.test(counter.birth) && Array.isArray(counter.launches), "AGENT_STARTUP_COUNTER_INVALID");
  need(counter.launches.length === 1 && counter.launches[0] === counter.pid, "AGENT_COUNTER_MULTIPLE_LAUNCHES");
  need(Array.isArray(counter.seq) && counter.seq.length > 0 && counter.seq.every((n, i) => Number.isSafeInteger(n) && n === i + 1), "AGENT_STARTUP_COUNTER_SEQUENCE_INVALID");
  const identity = { pid: counter.pid, birth: counter.birth };
  need(!firstIdentity || firstIdentity.pid === identity.pid && firstIdentity.birth === identity.birth, "AGENT_COUNTER_IDENTITY_CHANGED");
  return { phase: counter.seq.length >= 2 ? "counter-ready" : "waiting-for-counter", deadlineAtMs, elapsedMs: nowMs - toolIssuedAtMs, identity };
}
