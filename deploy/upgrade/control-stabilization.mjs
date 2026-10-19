import { invariant, digest, canonical, DIGEST } from "./trust.mjs";
import { createPrivateControlRpc } from "./control-rpc.mjs";

/** Only fixed Supervisor inventory + each actual Coordinator's private identity
 * are read. This collector has no business SQLite or Docker capability. */
export function createControlStabilization({
  sqlite,
  instanceId,
  supervisorOrigin,
  supervisorKey,
  controllerKey,
  fetcher = fetch,
  clock = Date.now,
}) {
  const supervise = createPrivateControlRpc({
    origin: supervisorOrigin,
    key: supervisorKey,
    instanceId,
    fetcher,
  });
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS control_stabilization_witnesses(recovery_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,writer_digest TEXT NOT NULL,inventory_digest TEXT NOT NULL,proof TEXT NOT NULL,proof_digest TEXT NOT NULL,observed_at INTEGER NOT NULL)",
  );
  const fresh = (value) =>
    Number.isFinite(Date.parse(value)) &&
    clock() - Date.parse(value) >= 0 &&
    clock() - Date.parse(value) <= 5000;
  async function measure() {
    const inventory = await supervise("/coordinator-inventory");
    invariant(
      inventory.instanceId === instanceId &&
        inventory.complete === true &&
        fresh(inventory.observedAt) &&
        Array.isArray(inventory.coordinators) &&
        inventory.coordinators.length > 0 &&
        inventory.coordinators.length <= 128,
      "CONTROL_STABILIZATION_INVENTORY_UNKNOWN",
    );
    const coordinators = [],
      writers = [];
    // Concurrent bounded reads keep the complete witness within its 5s window;
    // no unknown peer is silently omitted from the inventory.
    const observed = await Promise.all(
      inventory.coordinators.map(async (record) => {
        invariant(
          typeof record.containerId === "string" &&
            typeof record.startIdentity === "string" &&
            DIGEST.test(record.artifactDigest) &&
            record.physical &&
            typeof record.physical.running === "boolean",
          "CONTROL_STABILIZATION_PHYSICAL_IDENTITY_UNKNOWN",
        );
        if (record.physical.running === false) {
          const proof = record.retiredPhysical,
            { receiptDigest, observedAt, ...facts } = proof ?? {};
          invariant(
            proof?.schemaVersion === 1 &&
              proof.kind === "coordinator-normal-exit" &&
              proof.instanceId === instanceId &&
              digest(facts) === receiptDigest &&
              fresh(observedAt) &&
              record.physical.hostPid === 0 &&
              record.physical.paused === false &&
              record.physical.restartPolicy === "no" &&
              proof.target?.containerId === record.containerId &&
              proof.target.startIdentity === record.startIdentity &&
              proof.target.artifactDigest === record.artifactDigest &&
              proof.target.DockerStartedAt ===
                record.physical.DockerStartedAt &&
              proof.target.restartCount === record.physical.restartCount &&
              proof.after?.running === false &&
              proof.after.hostPid === 0 &&
              proof.after.restartPolicy === "no" &&
              proof.after.restartCount === record.physical.restartCount,
            "CONTROL_STABILIZATION_RETIRED_PROOF_UNKNOWN",
          );
          return {
            containerId: record.containerId,
            startIdentity: record.startIdentity,
            artifactDigest: record.artifactDigest,
            generation: null,
            writerFenceValid: false,
            kind: "retired-physical",
            receiptDigest,
            exitedAt: proof.exitedAt,
            observedAt,
          };
        }
        invariant(
          record.physical.running === true && record.physical.paused === false,
          "CONTROL_STABILIZATION_PHYSICAL_PROCESS_UNKNOWN",
        );
        invariant(
          record.physical.startIdentity === record.startIdentity,
          "CONTROL_STABILIZATION_PHYSICAL_IDENTITY_CHANGED",
        );
        const identity = record.actualIdentity;
        invariant(
          identity &&
            fresh(identity.observedAt) &&
            identity.instanceId === instanceId &&
            identity.startIdentity === record.startIdentity &&
            identity.artifactDigest === record.artifactDigest &&
            Number.isSafeInteger(identity.generation) &&
            identity.generation >= 0 &&
            typeof identity.writerFenceValid === "boolean",
          "CONTROL_STABILIZATION_PEER_IDENTITY_CHANGED",
        );
        let writer = null;
        if (identity.writerFenceValid) {
          const app = createPrivateControlRpc({
            origin: record.applicationOrigin ?? record.origin,
            key: controllerKey,
            instanceId,
            fetcher,
          });
          const receipt = await app("/internal/upgrades/inspection", {
            action: "writerIdentity",
          });
          invariant(
            receipt.instanceId === instanceId &&
              receipt.action === "writerIdentity",
            "CONTROL_STABILIZATION_WRITER_RECEIPT_INVALID",
          );
          writer = receipt.result;
          invariant(
            writer?.instanceId === instanceId &&
              writer.writerFenceValid === true &&
              writer.startIdentity === record.startIdentity &&
              writer.artifactDigest === record.artifactDigest &&
              writer.generation === identity.generation &&
              writer.lease?.instanceId === instanceId &&
              writer.lease.generation === identity.generation &&
              Number.isSafeInteger(writer.lease.fence) &&
              writer.lease.fence > 0 &&
              typeof writer.lease.holderId === "string" &&
              writer.lease.expiresAt > clock() &&
              fresh(writer.observedAt),
            "CONTROL_STABILIZATION_WRITER_UNKNOWN",
          );
        }
        return {
          containerId: record.containerId,
          startIdentity: record.startIdentity,
          artifactDigest: record.artifactDigest,
          generation: identity.generation,
          writerFenceValid: identity.writerFenceValid,
          observedAt: identity.observedAt,
          writer,
        };
      }),
    );
    for (const { writer, ...peer } of observed) {
      coordinators.push(peer);
      if (writer) writers.push(writer);
    }
    invariant(
      writers.length === 1 &&
        new Set(coordinators.map((p) => p.containerId)).size ===
          coordinators.length &&
        new Set(coordinators.map((p) => p.startIdentity)).size ===
          coordinators.length &&
        coordinators.every((peer) => fresh(peer.observedAt)),
      "CONTROL_STABILIZATION_SINGLE_WRITER_UNCONFIRMED",
    );
    const actual = writers[0],
      writer = {
        artifactDigest: actual.artifactDigest,
        startIdentity: actual.startIdentity,
        generation: actual.generation,
        fence: actual.lease.fence,
        holderId: actual.lease.holderId,
      };
    const identities = coordinators
      .map(({ containerId, startIdentity, artifactDigest, receiptDigest }) => ({
        containerId,
        startIdentity,
        artifactDigest,
        ...(receiptDigest ? { receiptDigest } : {}),
      }))
      .sort((a, b) => a.containerId.localeCompare(b.containerId));
    return {
      proof: {
        instanceId,
        writer,
        coordinators,
        observedAt: new Date(
          Math.min(
            ...coordinators.map((peer) => Date.parse(peer.observedAt)),
            Date.parse(actual.observedAt),
          ),
        ).toISOString(),
      },
      inventoryDigest: digest(identities),
      needed: actual.accepting === false,
    };
  }
  function save(recoveryId, value) {
    const serialized = canonical(value.proof);
    invariant(
      Buffer.byteLength(serialized) <= 262144 && fresh(value.proof.observedAt),
      "CONTROL_STABILIZATION_WITNESS_STALE",
    );
    sqlite
      .prepare(
        "INSERT INTO control_stabilization_witnesses VALUES(?,?,?,?,?,?,?) ON CONFLICT(recovery_id) DO UPDATE SET proof=excluded.proof,proof_digest=excluded.proof_digest,observed_at=excluded.observed_at WHERE control_stabilization_witnesses.instance_id=excluded.instance_id AND control_stabilization_witnesses.writer_digest=excluded.writer_digest AND control_stabilization_witnesses.inventory_digest=excluded.inventory_digest",
      )
      .run(
        recoveryId,
        instanceId,
        digest(value.proof.writer),
        value.inventoryDigest,
        serialized,
        digest(value.proof),
        clock(),
      );
    const saved = sqlite
      .prepare(
        "SELECT proof_digest FROM control_stabilization_witnesses WHERE recovery_id=? AND instance_id=?",
      )
      .get(recoveryId, instanceId);
    invariant(
      saved?.proof_digest === digest(value.proof),
      "CONTROL_STABILIZATION_TARGET_CHANGED",
    );
    return {
      writer: value.proof.writer,
      inventoryDigest: value.inventoryDigest,
    };
  }
  return {
    async capture({ recoveryId }) {
      const measured = await measure();
      return measured.needed ? save(recoveryId, measured) : null;
    },
    async refresh(intent) {
      const measured = await measure();
      invariant(
        digest(measured.proof.writer) ===
          digest(intent.authorizationPlan.stabilization.writer) &&
          measured.inventoryDigest ===
            intent.authorizationPlan.stabilization.inventoryDigest,
        "CONTROL_STABILIZATION_TARGET_CHANGED",
      );
      return save(intent.recoveryId, measured);
    },
  };
}
