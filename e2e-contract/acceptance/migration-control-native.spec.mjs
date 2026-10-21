import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  startLegacyMigrationSource,
  assertMigrationNativeIdentity,
} from "../server/start-migration-upgrade.mjs";
import { prepareMigrationUpgrade } from "../server/prepare-migration-upgrade.mjs";
import { runMigrationNativeCommand } from "../server/migration-native-command.mjs";
import { cleanupMigrationUpgrade } from "../server/cleanup-migration-upgrade.mjs";
import {
  api,
  browserStatus,
  unlock,
  cliCounter,
  originalBusiness,
  originalPhysical,
  continuous,
} from "../server/migration-native-business.mjs";
import {
  startQualificationModel,
  qualificationPrompt,
  configureQualificationImage,
} from "../server/qualification-model.mjs";
import { digest, invariant } from "../../deploy/upgrade/trust.mjs";
import { atomicJson } from "../../deploy/upgrade/io.mjs";

function legacyRows(db, instanceId) {
  const query = {
    upgrade_attempts: "instance_id=?",
    upgrade_events:
      "attempt_id IN (SELECT attempt_id FROM upgrade_attempts WHERE instance_id=?)",
    upgrade_steps:
      "attempt_id IN (SELECT attempt_id FROM upgrade_attempts WHERE instance_id=?)",
    upgrade_recoveries: "instance_id=?",
    upgrade_continuity_baselines:
      "attempt_id IN (SELECT attempt_id FROM upgrade_attempts WHERE instance_id=?)",
    platform_operations:
      "instance_id=? AND role IN ('upgrade-plan','project-name-contract','upgrade-observation','upgrade-stage-progress')",
  };
  return Object.fromEntries(
    Object.entries(query).map(([table, where]) => {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => r.name);
      return [
        table,
        {
          columns,
          rows: db
            .prepare(
              `SELECT ${columns.map((c) => '"' + c + '"').join(",")} FROM ${table} WHERE ${where} ORDER BY rowid`,
            )
            .all(instanceId),
        },
      ];
    }),
  );
}
function assertLegacyRows(db, instanceId, before) {
  for (const [table, { columns, rows }] of Object.entries(before)) {
    const current = db
      .prepare(
        `SELECT ${columns.map((c) => '"' + c + '"').join(",")} FROM ${table} WHERE ${table === "upgrade_events" || table === "upgrade_steps" || table === "upgrade_continuity_baselines" ? "attempt_id IN (SELECT attempt_id FROM upgrade_attempts WHERE instance_id=?)" : table === "platform_operations" ? "instance_id=? AND role IN ('upgrade-plan','project-name-contract','upgrade-observation','upgrade-stage-progress')" : "instance_id=?"} ORDER BY rowid`,
      )
      .all(instanceId);
    expect(current, table + " imported original bytes").toEqual(rows);
  }
}

test("legacy v20 → independent control → ordinary B: original Owner/Guest/KVM, real Claude job and access cookie survive", async ({
  page,
  context,
}, info) => {
  let h,
    model,
    business,
    ledger,
    migrationDb,
    config,
    prepared,
    passed = false;
  const evidence = {
    schemaVersion: 1,
    scenario: "legacy-to-independent-and-business-upgrade",
    result: "not-run",
    nativeQualified: false,
    modelQualityQualified: false,
    ordinaryUpgradePostCount: 0,
    assertions: [],
  };
  try {
    const path = process.env.MIGRATION_UPGRADE_ACCEPTANCE_CONFIG;
    invariant(path, "MIGRATION_UPGRADE_ACCEPTANCE_CONFIG_REQUIRED");
    const stat = await fs.lstat(path);
    invariant(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 1048576,
      "MIGRATION_NATIVE_CONFIG_INSECURE",
    );
    config = JSON.parse(await fs.readFile(path, "utf8"));
    assertMigrationNativeIdentity(config);
    invariant(
      config.modelMode === "local-protocol-test",
      "MIGRATION_NATIVE_REAL_CLI_PROTOCOL_SERVICE_REQUIRED",
    );
    model = await startQualificationModel({
      isolated: true,
      instanceId: config.instanceId,
      host: config.localModel?.bindHost ?? "127.0.0.1",
      guestHost: config.localModel?.guestHost ?? "host.boxlite.internal",
    });
    h = await startLegacyMigrationSource(config);
    const Database = createRequire(
      join(config.target.artifactRoot, "api/apps/api/package.json"),
    )("better-sqlite3");
    business = new Database(h.businessDatabasePath, {
      readonly: true,
      fileMustExist: true,
    });
    business.pragma("query_only=ON");
    const request = context.request,
      origin = h.entryOrigin;
    await unlock(page, config, origin);
    const init = await api(request, origin, "/api/system/init-status");
    if (!init.initialized)
      await api(
        request,
        origin,
        "/api/system/init",
        "POST",
        { acknowledgeOffline: true },
        201,
      );
    await configureQualificationImage(request, origin, model);
    await api(
      request,
      origin,
      `/api/runtimes/${model.runtimeId}/credentials/secret`,
      "POST",
      model.runtimeCredential,
    );
    const project = await api(
        request,
        origin,
        "/api/projects",
        "POST",
        { name: "Legacy control migration Native", sourceType: "empty" },
        201,
      ),
      sandbox = await api(
        request,
        origin,
        "/api/sandboxes",
        "POST",
        {
          projectId: project.id,
          runtime: model.runtimeId,
          headless: true,
          timeoutMinutes: 30,
        },
        201,
      );
    await expect
      .poll(
        async () =>
          (await api(request, origin, `/api/sandboxes/${sandbox.id}`)).status,
        { timeout: 180000 },
      )
      .toBe("running");
    const marker = randomUUID(),
      task = await api(
        request,
        origin,
        `/api/sandboxes/${sandbox.id}/runtimes/${model.runtimeId}/tasks`,
        "POST",
        { prompt: qualificationPrompt(marker), timeoutMinutes: 30 },
        202,
      );
    let counterBefore;
    await expect
      .poll(
        async () => {
          try {
            counterBefore = await cliCounter(
              request,
              origin,
              sandbox.id,
              marker,
            );
            return counterBefore.seq.length;
          } catch {
            return 0;
          }
        },
        { timeout: 180000 },
      )
      .toBeGreaterThanOrEqual(3);
    expect(counterBefore.launches).toHaveLength(1);
    const physicalBefore = await originalPhysical(
        h,
        config,
        Database,
        sandbox.id,
      ),
      businessBefore = originalBusiness(business, sandbox.id, task.id),
      history = legacyRows(business, config.instanceId),
      cookieBefore = (await context.cookies(origin)).find(
        (c) => c.name === "ap_session",
      );
    expect(cookieBefore).toBeTruthy();
    prepared = await prepareMigrationUpgrade(config, h, {
      protectedProcesses: physicalBefore.vmm.map((r) => ({
        hostPid: r.hostPid,
        containerId: physicalBefore.owner.containerId,
        birthTicks: r.birthTicks,
        cgroupDigest: r.cgroupDigest,
      })),
    });
    const cli = (command) =>
      runMigrationNativeCommand({
        artifactRoot: config.target.controlArtifactRoot,
        configPath: prepared.configPath,
        command,
        evidenceRoot: prepared.paths.journal,
      });
    const plan = await cli("plan");
    expect(plan.businessSchema).toBe(29);
    await cli("prepare");
    const applied = await cli("apply");
    expect(applied.state).toBe("migrated");
    expect(applied.pending).toEqual([]);
    migrationDb = new Database(join(prepared.paths.journal, "migration.db"), {
      readonly: true,
      fileMustExist: true,
    });
    migrationDb.pragma("query_only=ON");
    const beforeResume = migrationDb
        .prepare(
          "SELECT command_id,spec_digest,state,result_digest FROM control_commands ORDER BY command_id",
        )
        .all(),
      resumed = await cli("resume");
    expect(resumed.migrationId).toBe(applied.migrationId);
    expect(resumed.configDigest).toBe(applied.configDigest);
    expect(resumed.completedAt).toBe(applied.completedAt);
    expect(
      migrationDb
        .prepare(
          "SELECT command_id,spec_digest,state,result_digest FROM control_commands ORDER BY command_id",
        )
        .all(),
    ).toEqual(beforeResume);
    ledger = new Database(prepared.controlDbPath, {
      readonly: true,
      fileMustExist: true,
    });
    ledger.pragma("query_only=ON");
    assertLegacyRows(ledger, config.instanceId, history);
    const migratedInstance = ledger
      .prepare(
        "SELECT confirmed_release,activation_generation FROM upgrade_instances WHERE instance_id=?",
      )
      .get(config.instanceId);
    expect(JSON.parse(migratedInstance.confirmed_release)).toEqual(h.release);
    expect(migratedInstance.activation_generation).toBe(1);
    await expect
      .poll(
        async () => {
          try {
            return (await browserStatus(page)).value.controlSystem?.state;
          } catch {
            return "unavailable";
          }
        },
        { timeout: 120000 },
      )
      .toBe("ready");
    expect(
      (await context.cookies(origin)).find((c) => c.name === "ap_session")
        ?.value,
    ).toBe(cookieBefore.value);
    await api(request, origin, "/api/system/settings");
    await page.reload();
    await expect(
      page.getByRole("dialog", { name: "访问口令", exact: true }),
    ).toHaveCount(0);
    const middle = await originalPhysical(h, config, Database, sandbox.id);
    expect(middle).toEqual(physicalBefore);
    expect(originalBusiness(business, sandbox.id, task.id)).toEqual(
      businessBefore,
    );
    const afterMigration = await cliCounter(
      request,
      origin,
      sandbox.id,
      marker,
    );
    continuous(counterBefore, afterMigration);
    await expect
      .poll(async () => (await browserStatus(page)).value.catalog.state, {
        timeout: 30000,
      })
      .toBe("verified");
    const state = (await browserStatus(page)).value;
    expect(state.catalog.availableRelease).toBeTruthy();
    const command = {
      requestId: randomUUID(),
      targetReleaseId: state.catalog.availableRelease.releaseId,
      targetDigest: state.catalog.availableRelease.targetDigest,
      expectedActivationGeneration: state.activationGeneration,
    };
    const response = await page.evaluate(
      async ({ command, csrf }) => {
        const r = await fetch("/api/system/upgrade/requests", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Upgrade-CSRF": csrf,
          },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(2000),
        });
        return { status: r.status, body: await r.json() };
      },
      { command, csrf: state.csrfToken },
    );
    evidence.ordinaryUpgradePostCount++;
    expect(response.status).toBe(202);
    const deadline = Date.now() + 900000;
    let final;
    while (Date.now() < deadline) {
      const result = (await browserStatus(page)).value;
      if (
        ["failed", "candidate-rejected", "deferred"].includes(
          result.attempt?.state,
        ) ||
        result.recovery?.phase === "blocked"
      )
        throw Object.assign(
          Error("Actual post-migration business upgrade did not confirm"),
          {
            code:
              result.attempt?.reason ??
              result.recovery?.reason ??
              "MIGRATION_NATIVE_BUSINESS_UPGRADE_FAILED",
          },
        );
      if (
        result.attempt?.state === "activation-confirmed" &&
        result.serviceAvailability?.state === "available" &&
        result.observation?.state === "fresh"
      ) {
        final = result;
        break;
      }
      await delay(500);
    }
    expect(final).toBeTruthy();
    expect(
      ledger
        .prepare("SELECT count(*) n FROM upgrade_attempts WHERE request_id=?")
        .get(command.requestId).n,
    ).toBe(1);
    expect(await originalPhysical(h, config, Database, sandbox.id)).toEqual(
      physicalBefore,
    );
    expect(originalBusiness(business, sandbox.id, task.id)).toEqual(
      businessBefore,
    );
    const counterAfter = await cliCounter(request, origin, sandbox.id, marker);
    continuous(counterBefore, counterAfter);
    evidence.result = "passed";
    evidence.nativeQualified = true;
    evidence.migrationId = prepared.migrationId;
    evidence.migrationConfigDigest = applied.configDigest;
    evidence.oldSourceManifestDigest = h.provisionReceipt.sourceManifestDigest;
    evidence.sourceArchiveDigest = h.provisionReceipt.archive.digest;
    evidence.qualifiedPhysical = physicalBefore;
    evidence.counter = {
      pid: counterAfter.pid,
      birth: counterAfter.birth,
      launches: counterAfter.launches,
      beforeSamples: counterBefore.seq.length,
      afterSamples: counterAfter.seq.length,
    };
    evidence.cookieDigest = digest(cookieBefore.value);
    evidence.finalReleaseId = final.confirmedServiceRelease.releaseId;
    evidence.assertions = [
      "real immutable legacy Foundation/Installer/API/Coordinator/Owner/Web",
      "separate QA signature over unchanged old package bytes",
      "fixed runner/target UID/GID and private file ownership",
      "actual production migration prepare/apply/resume same ID",
      "original metadata/history preserved and unconfirmed A not fabricated",
      "same original access cookie",
      "same Owner/SDK/VMM/KVM and Guest Bash PID/birth",
      "exactly one ordinary post-migration upgrade request",
    ];
    await api(
      request,
      origin,
      `/api/sandboxes/${sandbox.id}/tasks/${task.id}/cancel`,
      "POST",
      undefined,
      202,
    );
    await api(
      request,
      origin,
      `/api/sandboxes/${sandbox.id}`,
      "DELETE",
      undefined,
      204,
    );
    await api(
      request,
      origin,
      `/api/projects/${project.id}`,
      "DELETE",
      undefined,
      204,
    );
    await expect
      .poll(
        () => business.prepare("SELECT count(*) n FROM sandboxes").get().n,
        { timeout: 30000 },
      )
      .toBe(0);
    evidence.cleanup = await cleanupMigrationUpgrade(config, h, prepared);
    passed = true;
  } catch (error) {
    evidence.result = "failed";
    evidence.nativeQualified = false;
    evidence.code = /^[A-Z0-9_]{1,128}$/.test(error?.code ?? "")
      ? error.code
      : "MIGRATION_NATIVE_ASSERTION_FAILED";
    throw error;
  } finally {
    business?.close();
    ledger?.close();
    migrationDb?.close();
    if (h)
      await atomicJson(join(h.root, "migration-native-evidence.json"), {
        ...evidence,
        resourcesCleaned: passed,
        recordedAt: new Date().toISOString(),
      });
    await model?.close();
    await info.attach("migration-native-evidence", {
      body: Buffer.from(JSON.stringify(evidence)),
      contentType: "application/json",
    });
  }
});
