/** Host-side Owner/VMM process continuity only. Never imports a provider SDK or
 * enters a Guest. The injected transport must use Docker inspect and Docker exec
 * in the Owner container, not Owner RPC exec/files APIs. A held/unknown read is
 * terminal for this collection; this module never retries or controls lifecycle.
 */
import { isAbsolute, resolve } from "node:path";
import { canonical, digest, invariant } from "../upgrade/trust.mjs";

export const OWNER_KERNEL_PROOF_MODE = "owner-kernel-process-continuity";
const SHA = /^sha256:[a-f0-9]{64}$/;
const CID = /^[a-f0-9]{64}$/;
const BOOT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_PROCESSES = 4096;
const MAX_PROC_BYTES = 1024 * 1024;
const keys = (v, expected, code) => {
  invariant(v && typeof v === "object" && !Array.isArray(v), code);
  invariant(
    canonical(Object.keys(v).sort()) === canonical([...expected].sort()),
    code,
  );
};
const text = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(v);
const absolute = (v) =>
  text(v) && isAbsolute(v) && resolve(v) === v && v !== "/";
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const same = (a, b, code) => invariant(canonical(a) === canonical(b), code);

/** Two bounded, independent /proc scans using shell builtins only. No argv/env,
 * SDK directory, business DB, Guest filesystem or child executable is read.
 * /proc is the Owner's container PID namespace. PID $$ and its descendants are
 * explicitly excluded by the parser, even if a transport makes it a PID1 child.
 * Stable historical zombies remain in the proof; live-to-zombie changes fail.
 * PID1 must remain live. Other processes retain their baseline class, including
 * historical destroyed-process zombies. R/S scheduler states are not identity.
 */
export const OWNER_PROC_COLLECTOR = String.raw`set -eu
round=1
while [ "$round" -le 2 ]; do
  IFS= read -r boot < /proc/sys/kernel/random/boot_id || exit 76
  printf 'H\t%s\t%s\t%s\n' "$round" "$boot" "$$"
  count=0
  for file in /proc/[0-9]*/stat; do
    count=$((count + 1))
    [ "$count" -le 4096 ] || exit 76
    IFS= read -r line < "$file" || exit 76
    pid=${"$"}{line%% *}
    tail=${"$"}{line##*) }
    comm=${"$"}{line#* (}
    comm=${"$"}{comm%") "*}
    set -- $tail
    [ "$#" -ge 20 ] || exit 76
    state=$1
    ppid=$2
    case "$state" in
      Z) liveness=zombie ;;
      R|S|D|T|t|K|W|P|I) liveness=live ;;
      *) exit 76 ;;
    esac
    shift 19
    ticks=$1
    printf 'P\t%s\t%s\t%s\t%s\t%s\t%s\n' "$round" "$pid" "$ppid" "$ticks" "$comm" "$liveness"
  done
  printf 'E\t%s\t%s\n' "$round" "$count"
  round=$((round + 1))
done
`;

// This constant is the sole executable descriptor handed to a transport.
export const OWNER_PROC_ARGV = Object.freeze([
  "/bin/sh",
  "-c",
  OWNER_PROC_COLLECTOR,
]);

function processRows(rows, collectorPid) {
  invariant(
    rows.size > 0 && rows.size <= MAX_PROCESSES && rows.has(1),
    "OWNER_PROC_ROOT_REQUIRED",
  );
  invariant(
    rows.has(collectorPid) && collectorPid !== 1,
    "OWNER_PROC_COLLECTOR_UNPROVEN",
  );
  const excluded = new Set([collectorPid]);
  const descendants = new Set([1]);
  for (let n = 0; n <= rows.size; n++) {
    let changed = false;
    for (const p of rows.values()) {
      if (excluded.has(p.ppid) && !excluded.has(p.pid)) {
        excluded.add(p.pid);
        changed = true;
      }
      if (descendants.has(p.ppid) && !descendants.has(p.pid)) {
        descendants.add(p.pid);
        changed = true;
      }
    }
    if (!changed) break;
  }
  invariant(
    rows.get(1).ppid === 0 && !excluded.has(1),
    "OWNER_PROC_ROOT_SCOPE_INVALID",
  );
  const result = [];
  for (const p of rows.values()) {
    if (excluded.has(p.pid)) continue;
    invariant(descendants.has(p.pid), "OWNER_PROC_UNROOTED_PROCESS");
    invariant(
      p.pid !== 1 || p.livenessClass === "live",
      "OWNER_PROC_REQUIRED_PROCESS_NOT_LIVE",
    );
    result.push(p);
  }
  return result.sort((a, b) => a.pid - b.pid);
}

export function parseOwnerProcSnapshot(output) {
  invariant(
    typeof output === "string" &&
      Buffer.byteLength(output) <= MAX_PROC_BYTES &&
      output.endsWith("\n"),
    "OWNER_PROC_OUTPUT_INVALID",
  );
  const rounds = new Map();
  let active = null;
  for (const line of output.trimEnd().split("\n")) {
    const p = line.split("\t");
    if (p[0] === "H") {
      invariant(
        p.length === 4 &&
          ["1", "2"].includes(p[1]) &&
          BOOT.test(p[2]) &&
          /^[1-9][0-9]*$/.test(p[3]),
        "OWNER_PROC_HEADER_INVALID",
      );
      invariant(
        !active && !rounds.has(p[1]) && Number(p[1]) === rounds.size + 1,
        "OWNER_PROC_ROUND_INVALID",
      );
      active = { bootId: p[2], collectorPid: Number(p[3]), rows: new Map() };
      rounds.set(p[1], active);
    } else if (p[0] === "P") {
      invariant(
        active &&
          p.length === 7 &&
          rounds.get(p[1]) === active &&
          /^[1-9][0-9]*$/.test(p[2]) &&
          /^(0|[1-9][0-9]*)$/.test(p[3]) &&
          /^[1-9][0-9]{0,24}$/.test(p[4]) &&
          text(p[5]) &&
          p[5].length <= 64 &&
          ["live", "zombie"].includes(p[6]),
        "OWNER_PROC_STAT_INVALID",
      );
      const row = {
        pid: Number(p[2]),
        ppid: Number(p[3]),
        startTicks: p[4],
        comm: p[5],
        livenessClass: p[6],
      };
      invariant(
        positive(row.pid) &&
          Number.isSafeInteger(row.ppid) &&
          !active.rows.has(row.pid) &&
          active.rows.size < MAX_PROCESSES,
        "OWNER_PROC_PID_INVALID",
      );
      active.rows.set(row.pid, row);
    } else if (p[0] === "E") {
      invariant(
        active &&
          p.length === 3 &&
          rounds.get(p[1]) === active &&
          /^(0|[1-9][0-9]*)$/.test(p[2]) &&
          Number(p[2]) === active.rows.size,
        "OWNER_PROC_SCAN_INCOMPLETE",
      );
      active.processes = processRows(active.rows, active.collectorPid);
      active = null;
    } else invariant(false, "OWNER_PROC_RECORD_INVALID");
  }
  invariant(
    !active &&
      rounds.size === 2 &&
      rounds.get("1").processes &&
      rounds.get("2").processes,
    "OWNER_PROC_SCAN_INCOMPLETE",
  );
  const a = rounds.get("1"),
    b = rounds.get("2");
  invariant(
    a.bootId === b.bootId && a.collectorPid === b.collectorPid,
    "OWNER_PROC_BOOT_CHANGED",
  );
  same(a.processes, b.processes, "OWNER_PROC_CHANGED_DURING_SCAN");
  return { bootId: a.bootId, processes: a.processes };
}

function assignmentProof(rows) {
  invariant(
    Array.isArray(rows) && rows.length <= 10000,
    "OWNER_ASSIGNMENTS_INVALID",
  );
  const seen = new Set();
  let bytes = 0;
  const stable = rows
    .map((row) => {
      keys(
        row,
        ["sandboxId", "provider", "providerSandboxId", "state"],
        "OWNER_ASSIGNMENT_FIELDS",
      );
      invariant(
        text(row.sandboxId) &&
          text(row.provider) &&
          ["owned", "destroyed"].includes(row.state) &&
          text(row.providerSandboxId) &&
          !seen.has(row.sandboxId),
        "OWNER_ASSIGNMENT_INVALID",
      );
      bytes += Buffer.byteLength(canonical(row));
      invariant(bytes <= 1024 * 1024, "OWNER_ASSIGNMENTS_TOO_LARGE");
      seen.add(row.sandboxId);
      return {
        sandboxId: row.sandboxId,
        provider: row.provider,
        state: row.state,
        providerSandboxIdDigest: digest(row.providerSandboxId),
      };
    })
    .sort((a, b) => a.sandboxId.localeCompare(b.sandboxId));
  return { assignmentsDigest: digest(stable), assignmentsCount: stable.length };
}

const INPUT_KEYS = [
  "ownerId",
  "ownerHome",
  "containerId",
  "artifactDigest",
  "inputFingerprint",
  "startIdentity",
];
function validateOwnerInput(row, instanceRoot) {
  keys(row, INPUT_KEYS, "OWNER_INPUT_FIELDS");
  invariant(
    text(row.ownerId) &&
      absolute(row.ownerHome) &&
      row.ownerHome.startsWith(instanceRoot + "/") &&
      CID.test(row.containerId) &&
      SHA.test(row.artifactDigest) &&
      SHA.test(row.inputFingerprint) &&
      text(row.startIdentity),
    "OWNER_INPUT_INVALID",
  );
}

function inspectProof(value, row, instanceId) {
  keys(
    value,
    [
      "containerId",
      "image",
      "instanceId",
      "role",
      "startIdentity",
      "state",
      "mounts",
    ],
    "OWNER_INSPECT_FIELDS",
  );
  invariant(
    value.containerId === row.containerId &&
      SHA.test(value.image) &&
      value.instanceId === instanceId &&
      value.role === "runtime-owner" &&
      value.startIdentity === row.startIdentity,
    "OWNER_CONTAINER_SCOPE_MISMATCH",
  );
  keys(
    value.state,
    [
      "status",
      "running",
      "pid",
      "startedAt",
      "restartCount",
      "oomKilled",
      "dead",
      "restarting",
    ],
    "OWNER_STATE_FIELDS",
  );
  const s = value.state;
  invariant(
    s.status === "running" &&
      s.running === true &&
      positive(s.pid) &&
      text(s.startedAt) &&
      Number.isFinite(Date.parse(s.startedAt)) &&
      Number.isSafeInteger(s.restartCount) &&
      s.restartCount >= 0 &&
      s.oomKilled === false &&
      s.dead === false &&
      s.restarting === false,
    "OWNER_NOT_STABLY_RUNNING",
  );
  invariant(
    Array.isArray(value.mounts) &&
      value.mounts.length > 0 &&
      value.mounts.length <= 128,
    "OWNER_MOUNTS_INVALID",
  );
  const destinations = new Set();
  const mounts = value.mounts
    .map((mount) => {
      keys(
        mount,
        ["type", "source", "destination", "rw"],
        "OWNER_MOUNT_FIELDS",
      );
      invariant(
        text(mount.type) &&
          absolute(mount.source) &&
          absolute(mount.destination) &&
          typeof mount.rw === "boolean" &&
          !destinations.has(mount.destination),
        "OWNER_MOUNT_INVALID",
      );
      destinations.add(mount.destination);
      return { ...mount };
    })
    .sort((a, b) => a.destination.localeCompare(b.destination));
  invariant(
    mounts.some(
      (m) =>
        m.type === "bind" &&
        m.source === row.ownerHome &&
        m.destination === row.ownerHome &&
        m.rw === true,
    ) && !mounts.some((m) => m.destination.startsWith(row.ownerHome + "/")),
    "OWNER_HOME_BIND_UNPROVEN",
  );
  return {
    image: value.image,
    hostPid: s.pid,
    startedAt: s.startedAt,
    restartCount: s.restartCount,
    mounts,
  };
}

/** Each transport call must honour signal and timeoutMs and return only its
 * narrow DTO, never a full Docker Config/Env. No automatic retry is permitted. */
async function boundedCall(fn, timeoutMs, maxBytes) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        fn({ timeoutMs, signal: controller.signal, maxBytes }),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("OWNER_PROOF_CALL_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The caller supplies its authenticated full Owner census (including retired
 * Owners and orphan assignments), and must bind that census to the signed plan.
 * This helper does not discover or silently omit containers outside ownerRows.
 * Unknown/unconfirmed assignments hold; process proof cannot settle a create.
 */
export async function collectOwnerKernelContinuityProof({
  instanceId,
  instanceRoot,
  ownerRows,
  transport,
  timeoutMs = 5000,
  concurrency = 2,
}) {
  invariant(
    text(instanceId) &&
      absolute(instanceRoot) &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 5000 &&
      Number.isSafeInteger(concurrency) &&
      concurrency >= 1 &&
      concurrency <= 2,
    "OWNER_PROOF_OPTIONS_INVALID",
  );
  invariant(
    Array.isArray(ownerRows) &&
      ownerRows.length > 0 &&
      ownerRows.length <= 64 &&
      transport &&
      ["inspectOwner", "readAssignments", "readOwnerProc"].every(
        (k) => typeof transport[k] === "function",
      ),
    "OWNER_PROOF_INPUT_REQUIRED",
  );
  const ids = new Set(),
    containers = new Set();
  const inputs = ownerRows
    .map((row) => {
      validateOwnerInput(row, instanceRoot);
      invariant(
        !ids.has(row.ownerId) && !containers.has(row.containerId),
        "OWNER_PROOF_DUPLICATE_OWNER",
      );
      ids.add(row.ownerId);
      containers.add(row.containerId);
      return Object.freeze({ ...row });
    })
    .sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  const rows = new Array(inputs.length);
  let next = 0;
  let heldError;
  const read = (fn, maxBytes) => {
    if (heldError) throw heldError;
    return boundedCall(fn, timeoutMs, maxBytes);
  };
  async function worker() {
    for (;;) {
      if (heldError) return;
      const index = next++;
      if (index >= inputs.length) return;
      const row = inputs[index];
      try {
        const inspect = () =>
          read((o) => transport.inspectOwner(row.containerId, o), 128 * 1024);
        const assignments = () =>
          read((o) => transport.readAssignments(row, o), 1024 * 1024);
        const before = inspectProof(await inspect(), row, instanceId);
        const a = assignmentProof(await assignments());
        const raw = await read(
          (o) =>
            transport.readOwnerProc(row.containerId, {
              ...o,
              script: OWNER_PROC_COLLECTOR,
              argv: OWNER_PROC_ARGV,
            }),
          MAX_PROC_BYTES,
        );
        keys(raw, ["exitCode", "stdout"], "OWNER_PROC_TRANSPORT_FIELDS");
        invariant(raw.exitCode === 0, "OWNER_PROC_EXEC_FAILED");
        const proc = parseOwnerProcSnapshot(raw.stdout);
        const b = assignmentProof(await assignments());
        same(a, b, "OWNER_ASSIGNMENTS_CHANGED_DURING_CAPTURE");
        same(
          before,
          inspectProof(await inspect(), row, instanceId),
          "OWNER_CONTAINER_CHANGED_DURING_CAPTURE",
        );
        rows[index] = { ...row, ...a, container: before, ...proc };
      } catch (error) {
        heldError ??= error;
        throw error;
      }
    }
  }
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, inputs.length) }, worker),
  );
  if (heldError) throw heldError;
  const proof = {
    schemaVersion: 1,
    proofMode: OWNER_KERNEL_PROOF_MODE,
    instanceId,
    instanceRoot,
    rows,
    stableDigest: digest(rows),
    guestProcessContinuityQualified: false,
    sdkCalls: 0,
    guestExecCalls: 0,
  };
  validateOwnerKernelContinuityProof(proof);
  return proof;
}

export function validateOwnerKernelContinuityProof(proof) {
  keys(
    proof,
    [
      "schemaVersion",
      "proofMode",
      "instanceId",
      "instanceRoot",
      "rows",
      "stableDigest",
      "guestProcessContinuityQualified",
      "sdkCalls",
      "guestExecCalls",
    ],
    "OWNER_PROOF_FIELDS",
  );
  invariant(
    proof.schemaVersion === 1 &&
      proof.proofMode === OWNER_KERNEL_PROOF_MODE &&
      text(proof.instanceId) &&
      absolute(proof.instanceRoot) &&
      proof.guestProcessContinuityQualified === false &&
      proof.sdkCalls === 0 &&
      proof.guestExecCalls === 0 &&
      Array.isArray(proof.rows) &&
      proof.rows.length > 0 &&
      proof.rows.length <= 64 &&
      SHA.test(proof.stableDigest),
    "OWNER_PROOF_INVALID",
  );
  const ids = new Set(),
    cids = new Set();
  for (const row of proof.rows) {
    keys(
      row,
      [
        ...INPUT_KEYS,
        "assignmentsDigest",
        "assignmentsCount",
        "container",
        "bootId",
        "processes",
      ],
      "OWNER_PROOF_ROW_FIELDS",
    );
    validateOwnerInput(
      Object.fromEntries(INPUT_KEYS.map((k) => [k, row[k]])),
      proof.instanceRoot,
    );
    invariant(
      !ids.has(row.ownerId) &&
        !cids.has(row.containerId) &&
        SHA.test(row.assignmentsDigest) &&
        Number.isSafeInteger(row.assignmentsCount) &&
        row.assignmentsCount >= 0 &&
        row.assignmentsCount <= 10000 &&
        BOOT.test(row.bootId),
      "OWNER_PROOF_ROW_INVALID",
    );
    ids.add(row.ownerId);
    cids.add(row.containerId);
    keys(
      row.container,
      ["image", "hostPid", "startedAt", "restartCount", "mounts"],
      "OWNER_PROOF_CONTAINER_FIELDS",
    );
    const c = row.container;
    same(
      c,
      inspectProof(
        {
          containerId: row.containerId,
          image: c.image,
          instanceId: proof.instanceId,
          role: "runtime-owner",
          startIdentity: row.startIdentity,
          state: {
            status: "running",
            running: true,
            pid: c.hostPid,
            startedAt: c.startedAt,
            restartCount: c.restartCount,
            oomKilled: false,
            dead: false,
            restarting: false,
          },
          mounts: c.mounts,
        },
        row,
        proof.instanceId,
      ),
      "OWNER_PROOF_CONTAINER_ORDER_INVALID",
    );
    invariant(
      Array.isArray(row.processes) &&
        row.processes.length > 0 &&
        row.processes.length <= MAX_PROCESSES,
      "OWNER_PROOF_PROCESSES_REQUIRED",
    );
    const processes = new Map();
    for (const p of row.processes) {
      keys(
        p,
        ["pid", "ppid", "startTicks", "comm", "livenessClass"],
        "OWNER_PROOF_PROCESS_FIELDS",
      );
      invariant(
        positive(p.pid) &&
          Number.isSafeInteger(p.ppid) &&
          p.ppid >= 0 &&
          /^[1-9][0-9]{0,24}$/.test(p.startTicks) &&
          text(p.comm) &&
          p.comm.length <= 64 &&
          ["live", "zombie"].includes(p.livenessClass) &&
          (p.pid !== 1 || p.livenessClass === "live") &&
          !processes.has(p.pid),
        "OWNER_PROOF_PROCESS_INVALID",
      );
      processes.set(p.pid, p);
    }
    invariant(
      processes.has(1) && processes.get(1).ppid === 0,
      "OWNER_PROOF_PID1_REQUIRED",
    );
    for (const p of processes.values()) {
      const seen = new Set();
      let at = p.pid;
      while (at !== 1) {
        invariant(
          !seen.has(at) && processes.has(at),
          "OWNER_PROOF_PROCESS_ANCESTRY_INVALID",
        );
        seen.add(at);
        at = processes.get(at).ppid;
      }
    }
    same(
      [...processes.values()],
      [...processes.values()].sort((a, b) => a.pid - b.pid),
      "OWNER_PROOF_PROCESS_ORDER_INVALID",
    );
  }
  same(
    proof.rows.map((r) => r.ownerId),
    [...ids].sort((a, b) => a.localeCompare(b)),
    "OWNER_PROOF_OWNER_ORDER_INVALID",
  );
  invariant(
    new Set(proof.rows.map((r) => r.bootId)).size === 1,
    "OWNER_PROOF_MIXED_KERNEL_BOOT",
  );
  invariant(
    digest(proof.rows) === proof.stableDigest,
    "OWNER_PROOF_DIGEST_MISMATCH",
  );
  return proof;
}

export function compareOwnerKernelContinuityProof(before, after) {
  validateOwnerKernelContinuityProof(before);
  validateOwnerKernelContinuityProof(after);
  invariant(
    before.instanceId === after.instanceId &&
      before.instanceRoot === after.instanceRoot,
    "OWNER_PROOF_SCOPE_CHANGED",
  );
  same(before.rows, after.rows, "OWNER_KERNEL_OR_ASSIGNMENTS_CHANGED");
  invariant(
    before.stableDigest === after.stableDigest,
    "OWNER_PROOF_DIGEST_CHANGED",
  );
  return {
    proofMode: OWNER_KERNEL_PROOF_MODE,
    ownerKernelContinuityQualified: true,
    preservedOwners: before.rows.length,
    stableDigest: before.stableDigest,
    guestProcessContinuityQualified: false,
    businessQualityQualified: false,
    sdkCalls: 0,
    guestExecCalls: 0,
  };
}
