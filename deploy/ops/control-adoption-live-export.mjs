import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  canonical,
  digest,
  invariant,
  verifySignedManifest,
} from "../upgrade/trust.mjs";
import { atomicJson, secureDirectory } from "../upgrade/io.mjs";
import {
  legacyControlAttachmentLedgerRoot,
  assertLegacyControlAttachmentLedgerDirectory,
} from "../upgrade/control-adoption-layout.mjs";
import { validateControlAdoptionAttachSpec } from "../upgrade/control-adoption-reservation.mjs";
import {
  exportControlMetadata,
  importControlMetadata,
} from "../upgrade/control-migration.mjs";
import { createControlAdoptionAttachment } from "../upgrade/control-adoption-attachment.mjs";
import {
  createPrivateControlRpc,
  privateLoopbackOrigin,
} from "../upgrade/control-rpc.mjs";

const BASE = "/internal/upgrade-control-attachment";
const PREFIX = "CONTROL_ADOPTION_LIVE_EXPORT_";
const snapshot = (value) => JSON.parse(canonical(value));
const identity = (value) => ({
  dev: String(value.dev),
  ino: String(value.ino),
});
const same = (a, b) => canonical(a) === canonical(b);
const exact = (value, fields) =>
  value &&
  Object.getPrototypeOf(value) === Object.prototype &&
  same(Object.keys(value).sort(), [...fields].sort());
const fail = (ok, code) => invariant(ok, PREFIX + code);
const safeCode = (error) =>
  /^(?:CONTROL_|UPGRADE_)[A-Z0-9_]{1,100}$/.test(error?.code ?? "")
    ? error.code
    : PREFIX + "UNCONFIRMED";

async function privateJson(path, limit = 65536) {
  const before = await fs.lstat(path, { bigint: true });
  fail(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(limit) &&
      !(Number(before.mode) & 0o077) &&
      (!process.getuid || before.uid === BigInt(process.getuid())) &&
      (await fs.realpath(path)) === path,
    "PRIVATE_INPUT_REQUIRED",
  );
  const fd = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await fd.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    const raw = buffer.subarray(0, bytes),
      after = await fd.stat({ bigint: true }),
      named = await fs.lstat(path, { bigint: true });
    fail(
      [
        "dev",
        "ino",
        "mode",
        "uid",
        "gid",
        "size",
        "nlink",
        "mtimeNs",
        "ctimeNs",
      ].every((k) => before[k] === after[k] && before[k] === named[k]) &&
        raw.length === Number(before.size),
      "PRIVATE_INPUT_CHANGED",
    );
    return JSON.parse(raw);
  } finally {
    await fd.close();
  }
}

async function directory(path) {
  const s = await fs.lstat(path);
  fail(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      !(s.mode & 0o077) &&
      (!process.getuid || s.uid === process.getuid()) &&
      (await fs.realpath(path)) === path,
    "PRIVATE_DIRECTORY_REQUIRED",
  );
  return identity(s);
}

// Completed exports retain the exact three file identities BEFORE any reopen
// can call the importer's idempotent RW validation. The original export manifest
// and importer also verify every metadata row and the auth-state digest.
async function retainedFile(path) {
  const s = await fs.lstat(path, { bigint: true });
  fail(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1n &&
      !(Number(s.mode) & 0o077) &&
      (!process.getuid || s.uid === BigInt(process.getuid())) &&
      (await fs.realpath(path)) === path,
    "RETAINED_FILE_CUSTODY_CHANGED",
  );
  return {
    path,
    ...identity(s),
    uid: String(s.uid),
    gid: String(s.gid),
    mode: Number(s.mode),
    nlink: String(s.nlink),
  };
}

/** Privileged, one-operation worker port. The independent Agent does not import
 * this module or receive its source DB/auth paths. All paths and signing roots
 * are trusted deployment inputs, never public RPC fields. The source is opened
 * only readonly/query_only; only new private control/auth/export files are RW.
 * No settlement, Entry delegation, ordinary claim or source-stop is authorized.
 */
export function createControlAdoptionLiveExporter(
  configuration,
  {
    Database,
    fetcher = fetch,
    clock = Date.now,
    monotonic = () => performance.now(),
  } = {},
) {
  const c = {
    ...configuration,
    freezeConfiguration: snapshot(configuration.freezeConfiguration),
    trustRoot: snapshot(configuration.trustRoot),
    sourceCoordinator: snapshot(configuration.sourceCoordinator),
    limits: snapshot(configuration.limits),
  };
  const plan = c.freezeConfiguration.spec,
    origin = privateLoopbackOrigin(c.coordinatorOrigin),
    ledgerRoot = legacyControlAttachmentLedgerRoot(c.root, plan.operationId);
  const controlPath = join(ledgerRoot, "control.db"),
    exportPath = join(c.exportRoot, "metadata.db"),
    accessPath = join(c.privateRoot, "auth", "access.db"),
    statePath = join(c.privateRoot, "live-export.json");
  fail(
    [
      c.root,
      c.apiRoot,
      c.businessPath,
      c.exportRoot,
      c.privateRoot,
      c.accessEnvironmentPath,
    ].every(
      (p) =>
        typeof p === "string" &&
        isAbsolute(p) &&
        resolve(p) === p &&
        !/[\r\n\0]/.test(p),
    ),
    "FIXED_PATHS_REQUIRED",
  );
  fail(
    plan.kind === "legacy-control-admission-freeze" &&
      plan.instanceId === c.instanceId &&
      Number.isSafeInteger(c.epoch) &&
      c.epoch > 1 &&
      typeof c.executorId === "string" &&
      typeof c.attachCommandId === "string" &&
      typeof c.settlementCommandId === "string" &&
      c.attachCommandId !== c.settlementCommandId &&
      typeof c.internalKey === "string" &&
      c.internalKey.length >= 32 &&
      typeof c.sourceMetadataKey === "string" &&
      c.sourceMetadataKey.length >= 32,
    "SCOPE_REQUIRED",
  );
  fail(
    c.sourceCoordinator.generation === plan.source.businessWriterGeneration &&
      c.sourceCoordinator.artifactDigest ===
        plan.target.coordinatorArtifactDigest &&
      typeof c.sourceCoordinator.startIdentity === "string" &&
      c.sourceCoordinator.startIdentity.length > 0 &&
      [
        "/internal/application/identity",
        "/internal/coordinator/identity",
      ].includes(c.sourceCoordinator.metadataPath),
    "SOURCE_COORDINATOR_REQUIRED",
  );
  const roots = [
    ledgerRoot,
    c.exportRoot,
    c.privateRoot,
    dirname(c.businessPath),
  ];
  fail(
    roots.every((p, i) =>
      roots.every(
        (q, j) =>
          i === j ||
          !(p === q || p.startsWith(q + "/") || q.startsWith(p + "/")),
      ),
    ),
    "ROOTS_OVERLAP",
  );
  let inFlight, inFlightScope;
  async function execute({
    freezeReceipt,
    freezeConfiguration,
    deadline,
    signal,
  }) {
    const end = monotonic() + Math.max(0, deadline - clock());
    const live = () =>
      fail(
        !signal?.aborted &&
          deadline === plan.deadline &&
          deadline > clock() &&
          end > monotonic(),
        "ORIGINAL_DEADLINE_EXPIRED",
      );
    const remaining = () => {
      live();
      return Math.max(
        1,
        Math.floor(Math.min(deadline - clock(), end - monotonic())),
      );
    };
    fail(
      same(freezeConfiguration, c.freezeConfiguration),
      "ORIGINAL_CONFIGURATION_CHANGED",
    );
    const verified = verifySignedManifest(
        c.freezeConfiguration.signedManifest,
        c.trustRoot,
        clock(),
      ),
      manifest = verified.manifest;
    fail(
      verified.manifestDigest === plan.target.signedManifestDigest &&
        manifest.components.api.artifactDigest ===
          plan.target.apiArtifactDigest &&
        manifest.components.coordinator.artifactDigest ===
          plan.target.coordinatorArtifactDigest &&
        manifest.commits.project === plan.target.projectRevision &&
        manifest.controlPackage?.manifestDigest ===
          plan.target.controlPackageDigest &&
        (verified.purpose !== "qualification" ||
          (c.trustRoot.qualificationInstanceId === c.instanceId &&
            manifest.qualification.instanceId === c.instanceId)),
      "SIGNED_TARGET_CHANGED",
    );
    const receiptFields = [
      "schemaVersion",
      "kind",
      "instanceId",
      "operationId",
      "commandId",
      "specDigest",
      "sourceConfirmedDigest",
      "admissionRevision",
      "legacyLedgerEpoch",
      "frozenAt",
      "businessWriterGeneration",
      "businessWriterFence",
    ];
    const receipt = Object.fromEntries(
      receiptFields.map((k) => [k, freezeReceipt?.[k]]),
    );
    fail(
      receipt.schemaVersion === 1 &&
        receipt.kind === "legacy-control-admission-frozen" &&
        receipt.instanceId === c.instanceId &&
        receipt.operationId === plan.operationId &&
        receipt.commandId === plan.commandId &&
        receipt.specDigest === digest(plan) &&
        receipt.sourceConfirmedDigest === plan.source.confirmedDigest &&
        receipt.admissionRevision === 1 &&
        Number.isSafeInteger(receipt.legacyLedgerEpoch) &&
        receipt.legacyLedgerEpoch > 0 &&
        receipt.businessWriterGeneration ===
          plan.source.businessWriterGeneration &&
        receipt.businessWriterFence === plan.source.businessWriterFence &&
        Number.isSafeInteger(receipt.frozenAt) &&
        receipt.frozenAt <= clock() &&
        digest(receipt) === freezeReceipt.receiptDigest,
      "FREEZE_RECEIPT_CHANGED",
    );
    const frozen = { ...receipt, receiptDigest: freezeReceipt.receiptDigest };
    live();
    const rpc = async (path, key) =>
      createPrivateControlRpc({
        origin,
        instanceId: c.instanceId,
        key,
        maxBytes: 16384,
        timeoutMs: Math.min(2000, remaining()),
        fetcher: (url, init) =>
          fetcher(url, {
            ...init,
            signal: signal
              ? AbortSignal.any([signal, init.signal])
              : init.signal,
          }),
      })(path);
    async function observe() {
      const status = await rpc(BASE, c.internalKey);
      live();
      fail(
        status.admissionClosed === true &&
          status.active === 0 &&
          status.readonly === false &&
          same(status.freeze, frozen) &&
          same(status.businessWriter, {
            generation: plan.source.businessWriterGeneration,
            fence: plan.source.businessWriterFence,
          }),
        "FROZEN_SOURCE_CHANGED",
      );
      const value = await rpc(
        c.sourceCoordinator.metadataPath,
        c.sourceMetadataKey,
      );
      live();
      const generation =
        c.sourceCoordinator.metadataPath === "/internal/application/identity"
          ? value.coordinatorGeneration
          : value.generation;
      fail(
        value.instanceId === c.instanceId &&
          value.role === "coordinator" &&
          value.startIdentity === c.sourceCoordinator.startIdentity &&
          value.artifactDigest === c.sourceCoordinator.artifactDigest &&
          value.inputFingerprint ===
            manifest.components.coordinator.inputFingerprint &&
          generation === plan.source.businessWriterGeneration &&
          value.writerFenceValid === true,
        "LIVE_WRITER_CHANGED",
      );
      const source = new NativeDatabase(c.businessPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 0,
      });
      try {
        source.pragma("query_only = ON");
        fail(
          same(identity(await fs.lstat(c.businessPath)), identity(sourceStat)),
          "BUSINESS_REPLACED",
        );
        const sizes = source
          .prepare(
            "SELECT coalesce(octet_length(confirmed_release),0) bytes FROM upgrade_instances WHERE instance_id=?",
          )
          .get(c.instanceId);
        fail(
          Number.isSafeInteger(sizes?.bytes) &&
            sizes.bytes > 0 &&
            sizes.bytes <= 262144,
          "CONFIRMED_SOURCE_BYTE_LIMIT",
        );
        const current = source
          .prepare(
            "SELECT activation_generation,confirmed_release,service_state,ready FROM upgrade_instances WHERE instance_id=?",
          )
          .get(c.instanceId);
        fail(
          current?.activation_generation === plan.source.activationGeneration &&
            current.service_state === "confirmed" &&
            current.ready === 1 &&
            digest(JSON.parse(current.confirmed_release)) ===
              plan.source.confirmedDigest,
          "CONFIRMED_SOURCE_CHANGED",
        );
        const size = source
          .prepare(
            "SELECT coalesce(octet_length(receipt),0)+coalesce(octet_length(operation_id),0)+coalesce(octet_length(spec_digest),0)+coalesce(octet_length(phase),0) bytes FROM upgrade_control_attachment WHERE instance_id=?",
          )
          .get(c.instanceId);
        fail(
          Number.isSafeInteger(size?.bytes) &&
            size.bytes > 0 &&
            size.bytes <= 16384,
          "FROZEN_SOURCE_BYTE_LIMIT",
        );
        const row = source
          .prepare(
            "SELECT operation_id,spec_digest,phase,receipt FROM upgrade_control_attachment WHERE instance_id=?",
          )
          .get(c.instanceId);
        fail(
          row?.operation_id === plan.operationId &&
            row.spec_digest === digest(plan) &&
            row.phase === "frozen" &&
            same(JSON.parse(row.receipt), frozen),
          "PERSISTED_FREEZE_CHANGED",
        );
        const writer = source
          .prepare(
            "SELECT instance_id,generation,fence,expires_at FROM platform_role_leases WHERE role='state-coordinator'",
          )
          .get();
        fail(
          writer?.instance_id === c.instanceId &&
            writer.generation === plan.source.businessWriterGeneration &&
            writer.fence === plan.source.businessWriterFence &&
            Number.isSafeInteger(writer.expires_at) &&
            writer.expires_at > clock(),
          "PERSISTED_WRITER_CHANGED",
        );
      } finally {
        source.close();
      }
      live();
      return {
        instanceId: c.instanceId,
        artifactDigest: value.artifactDigest,
        generation,
        writerFenceValid: true,
        observedAt: new Date(clock()).toISOString(),
      };
    }
    const sourceStat = await fs.lstat(c.businessPath);
    fail(
      sourceStat.isFile() &&
        !sourceStat.isSymbolicLink() &&
        (await fs.realpath(c.businessPath)) === c.businessPath &&
        (!process.getuid || sourceStat.uid === process.getuid()),
      "BUSINESS_IDENTITY_REQUIRED",
    );
    const wal = await fs.lstat(c.businessPath + "-wal").catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (wal) {
      const shm = await fs.lstat(c.businessPath + "-shm");
      fail(
        wal.isFile() &&
          !wal.isSymbolicLink() &&
          shm.isFile() &&
          !shm.isSymbolicLink(),
        "EXISTING_WAL_SHM_REQUIRED",
      );
    }
    await assertLegacyControlAttachmentLedgerDirectory({
      root: c.root,
      operationId: plan.operationId,
      controlLedgerRoot: ledgerRoot,
    });
    await directory(c.exportRoot);
    await directory(c.privateRoot);
    await secureDirectory(dirname(accessPath));
    await directory(dirname(accessPath));
    fail((await fs.realpath(c.apiRoot)) === c.apiRoot, "API_ROOT_CHANGED");
    const NativeDatabase =
      Database ??
      createRequire(join(c.apiRoot, "apps/api/package.json"))("better-sqlite3");
    // Preserve real SQLite behavior while checking the ONE original deadline at
    // each streamed row/statement; no per-table or retry deadline is refreshed.
    function BoundedDatabase(path, options) {
      live();
      if (path === c.businessPath)
        fail(
          options?.readonly === true && options.fileMustExist === true,
          "BUSINESS_RW_FORBIDDEN",
        );
      const db = new NativeDatabase(path, options),
        prepare = db.prepare.bind(db);
      for (const name of ["exec", "pragma"]) {
        const original = db[name].bind(db);
        db[name] = (...args) => {
          if (name === "exec" && /^\s*ROLLBACK\s*;?\s*$/i.test(args[0]))
            return original(...args);
          live();
          const value = original(...args);
          live();
          return value;
        };
      }
      db.prepare = (sql) => {
        live();
        const stmt = prepare(sql);
        for (const name of ["get", "all", "run"]) {
          const original = stmt[name].bind(stmt);
          stmt[name] = (...args) => {
            live();
            const value = original(...args);
            live();
            return value;
          };
        }
        const iterate = stmt.iterate.bind(stmt);
        stmt.iterate = function* (...args) {
          const rows = iterate(...args);
          try {
            for (;;) {
              live();
              const row = rows.next();
              if (row.done) return;
              yield row.value;
            }
          } finally {
            rows.return?.();
          }
        };
        return stmt;
      };
      return db;
    }
    const original = {
      operationId: plan.operationId,
      freezeSpecDigest: digest(plan),
      freezeReceiptDigest: frozen.receiptDigest,
      source: plan.source,
      target: plan.target,
      business: { path: c.businessPath, ...identity(sourceStat) },
      apiRoot: c.apiRoot,
      epoch: c.epoch,
      executorId: c.executorId,
      attachCommandId: c.attachCommandId,
      settlementCommandId: c.settlementCommandId,
      ledgerRoot,
      exportPath,
      controlPath,
      accessPath,
      deadline: plan.deadline,
      limits: c.limits,
    };
    let lock, state, sqlite;
    try {
      lock = await fs.open(statePath + ".lock", "wx", 0o600);
      await lock.writeFile(canonical({ operationId: plan.operationId }));
      await lock.sync();
      const parent = await fs.open(c.privateRoot, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      state = await privateJson(statePath).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (state) {
        fail(
          same(state.original, original) && state.phase === "complete",
          "PRIOR_RESULT_UNKNOWN",
        );
        fail(
          exact(state.retainedFiles, ["control", "export", "access"]) &&
            same(state.retainedFiles, {
              control: await retainedFile(controlPath),
              export: await retainedFile(exportPath),
              access: await retainedFile(accessPath),
            }),
          "RETAINED_FILE_IDENTITY_CHANGED",
        );
      }
      const before = await observe();
      let exported;
      if (!state) {
        for (const path of [controlPath, exportPath, accessPath])
          fail(
            !(await fs.lstat(path).catch((e) => {
              if (e.code === "ENOENT") return null;
              throw e;
            })),
            "TARGET_ALREADY_EXISTS",
          );
        await atomicJson(statePath, { phase: "export-started", original });
        const environment = await privateJson(c.accessEnvironmentPath);
        fail(
          exact(environment, ["UPGRADE_SESSION_SECRET_BASE64"]) ||
            Object.keys(environment).every((k) =>
              [
                "ACCESS_PASSCODE",
                "PASSCODE_COOKIE_SECRET",
                "UPGRADE_SESSION_SECRET_BASE64",
                "UPGRADE_LEGACY_AUTH_CONTINUITY_KEY",
                "UPGRADE_ADMIN_KEY",
              ].includes(k),
            ),
          "ACCESS_ENVIRONMENT_UNKNOWN",
        );
        exported = await exportControlMetadata({
          Database: BoundedDatabase,
          apiRoot: c.apiRoot,
          businessPath: c.businessPath,
          exportPath,
          accessPath,
          instanceId: c.instanceId,
          migrationId: plan.operationId,
          epochFloor: c.epoch - 1,
          limits: c.limits,
          readSourceCoordinator: async () => before,
          readAccessEnvironment: async () => {
            live();
            return environment;
          },
          clock,
        });
      } else exported = state.exported;
      live();
      await observe();
      fail(
        same(identity(await fs.lstat(c.businessPath)), identity(sourceStat)),
        "BUSINESS_REPLACED",
      );
      const imported = importControlMetadata({
        Database: BoundedDatabase,
        apiRoot: c.apiRoot,
        exportPath,
        controlPath,
        accessPath,
        instanceId: c.instanceId,
        expectedExportDigest: exported.exportDigest,
        clock,
      });
      fail(imported.mode === "passive", "CONTROL_NOT_PASSIVE");
      live();
      await observe();
      fail(
        same(identity(await fs.lstat(c.businessPath)), identity(sourceStat)),
        "BUSINESS_REPLACED",
      );
      const stat = await fs.lstat(controlPath);
      const readonlyControl = new NativeDatabase(controlPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        readonlyControl.pragma("query_only = ON");
        const source = readonlyControl
          .prepare(
            "SELECT activation_generation,confirmed_release,service_state,ready FROM upgrade_instances WHERE instance_id=?",
          )
          .get(c.instanceId);
        const confirmed =
          source?.confirmed_release && JSON.parse(source.confirmed_release);
        fail(
          source?.activation_generation === plan.source.activationGeneration &&
            source.service_state === "confirmed" &&
            source.ready === 1 &&
            digest(confirmed) === plan.source.confirmedDigest &&
            confirmed.schema === plan.source.schema &&
            confirmed.components.api.artifactDigest ===
              plan.target.apiArtifactDigest &&
            confirmed.components.coordinator.artifactDigest ===
              plan.target.coordinatorArtifactDigest &&
            confirmed.commits.project === plan.target.projectRevision,
          "EXPORTED_CONFIRMED_SOURCE_CHANGED",
        );
      } finally {
        readonlyControl.close();
      }
      const spec = validateControlAdoptionAttachSpec({
        ...plan,
        kind: "legacy-control-ledger-attach",
        commandId: c.attachCommandId,
        epoch: c.epoch,
        executorId: c.executorId,
        freezeReceiptDigest: frozen.receiptDigest,
        controlDatabase: { path: controlPath, ...identity(stat) },
        settlement: {
          operationId: plan.operationId,
          commandId: c.settlementCommandId,
        },
      });
      const attachConfiguration = {
        signedManifest: c.freezeConfiguration.signedManifest,
        spec,
      };
      if (state)
        fail(
          same(state.attachConfiguration, attachConfiguration),
          "ATTACH_CONFIGURATION_CHANGED",
        );
      live();
      sqlite = new NativeDatabase(controlPath, { fileMustExist: true });
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("busy_timeout = 50");
      fail(
        sqlite
          .prepare("SELECT mode FROM control_authority WHERE instance_id=?")
          .get(c.instanceId)?.mode === "passive",
        "CONTROL_NOT_PASSIVE",
      );
      const retainedFiles = {
        control: await retainedFile(controlPath),
        export: await retainedFile(exportPath),
        access: await retainedFile(accessPath),
      };
      fail(
        !state || same(state.retainedFiles, retainedFiles),
        "RETAINED_FILE_IDENTITY_CHANGED",
      );
      live();
      await atomicJson(statePath, {
        phase: "complete",
        original,
        exported,
        attachConfiguration,
        retainedFiles,
      });
      live();
      const result = {
        sqlite,
        attachConfiguration,
        receipt: {
          schemaVersion: 1,
          kind: "passive-live-control-metadata-export",
          instanceId: c.instanceId,
          operationId: plan.operationId,
          exportDigest: exported.exportDigest,
          controlDatabase: spec.controlDatabase,
          mode: "passive",
          businessWriterPreserved: true,
          onlineAdoptionImplemented: false,
          controlActivated: false,
          authorizesEntryMutation: false,
          settlementQualified: false,
          sourceDatabaseWrites: 0,
          SDKCalls: 0,
        },
      };
      sqlite = null;
      return result;
    } catch (error) {
      if (lock && state?.phase !== "complete")
        await atomicJson(statePath, {
          phase: "unknown",
          original,
          safeCode: safeCode(error),
        }).catch(() => {});
      throw error;
    } finally {
      sqlite?.close();
      if (lock) {
        await lock.close();
        await fs.unlink(statePath + ".lock");
      }
    }
  }
  return (input) => {
    fail(
      input?.deadline === plan.deadline &&
        same(input.freezeConfiguration, c.freezeConfiguration),
      "ORIGINAL_CONFIGURATION_CHANGED",
    );
    const scope = digest({
      deadline: input.deadline,
      freezeReceipt: input.freezeReceipt,
      freezeConfiguration: input.freezeConfiguration,
    });
    fail(!inFlight || scope === inFlightScope, "CONCURRENT_SCOPE_CHANGED");
    inFlightScope = scope;
    return (inFlight ??= execute({
      ...input,
      freezeReceipt: snapshot(input.freezeReceipt),
      freezeConfiguration: snapshot(input.freezeConfiguration),
    }).finally(() => {
      inFlight = undefined;
      inFlightScope = undefined;
    }));
  };
}

/** Production composition uses the real HTTP/SQLite exporter by default.
 * Missing/unknown legacy settlement still prevents attachment; no success port
 * is substituted and the stop-first migration executor remains disabled. */
export function createLiveControlAdoptionAttachment(configuration, ports = {}) {
  const exporter = createControlAdoptionLiveExporter(configuration, ports),
    handles = new Set();
  const exportPassive = async (input) => {
    const result = await exporter(input);
    handles.add(result.sqlite);
    return result;
  };
  const attachment = createControlAdoptionAttachment({
    ...configuration,
    ...ports,
    exportPassive,
    settlementObserver: configuration.settlementObserver,
  });
  return {
    observe: attachment.observe,
    async run() {
      try {
        return await attachment.run();
      } finally {
        for (const handle of handles) {
          if (handle.open) handle.close();
        }
        handles.clear();
      }
    },
  };
}
