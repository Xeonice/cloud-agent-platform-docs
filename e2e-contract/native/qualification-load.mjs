import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  digest,
  invariant,
  runInputFingerprint,
} from "../../deploy/upgrade/trust.mjs";

async function request(env, path, method = "GET", data, expected = 200) {
  const response = await env.request.fetch(env.origin + path, {
    method,
    data,
    headers: { Origin: env.origin, "X-Operation-Id": randomUUID() },
    timeout: 2000,
  });
  invariant(response.status() === expected, "MAXIMUM_LOAD_HTTP_FAILED");
  return response.json();
}

/** Populate valid existing business rows through the real public application. */
export async function populateQualifiedMaximum(env) {
  invariant(env.config.isolated === true, "ISOLATED_MAXIMUM_LOAD_REQUIRED");
  invariant(env.input.automationInput, "VALID_AUTOMATION_LOAD_REQUIRED");
  const projectFile = join(
    env.config.initialRoot,
    "api/packages/modules/project/dist/application/project-application.service.js",
  );
  const projectBytes = await readFile(projectFile);
  const limit = /const MAX_PROJECTS\s*=\s*(\d+)\s*;/.exec(
    projectBytes.toString(),
  );
  invariant(limit, "ACTUAL_COMPILED_PROJECT_LIMIT_REQUIRED");
  const projectLimit = Number(limit[1]);
  const require = createRequire(
    join(env.config.initialRoot, "api/packages/contracts/package.json"),
  );
  const {
    AUTOMATION_PER_PROJECT_LIMIT: ruleLimit,
  } = require("@platform/contracts");
  invariant(
    projectLimit === 50 && ruleLimit === 20,
    "MAXIMUM_LOAD_REQUIRES_UPDATED_LIMITS",
  );
  const projects = await request(env, "/api/projects");
  invariant(
    Array.isArray(projects) && projects.length <= projectLimit,
    "PROJECT_LOAD_INVALID",
  );
  while (projects.length < projectLimit) {
    projects.push(
      await request(
        env,
        "/api/projects",
        "POST",
        {
          name: "UPG maximum project " + projects.length,
          sourceType: "empty",
        },
        202,
      ),
    );
  }
  // Bound concurrency without changing the service's admission policy.
  let cursor = 0;
  const worker = async () => {
    while (cursor < projects.length) {
      const project = projects[cursor++];
      const rules = await request(
        env,
        `/api/projects/${project.id}/automations`,
      );
      invariant(
        Array.isArray(rules) && rules.length <= ruleLimit,
        "RULE_LOAD_INVALID",
      );
      for (let n = rules.length; n < ruleLimit; n++) {
        const rule = await request(
          env,
          `/api/projects/${project.id}/automations`,
          "POST",
          {
            ...env.input.automationInput,
            name: "UPG maximum rule " + n,
            scheduleKind: "hourly",
            scheduleConfig: { minute: (new Date().getUTCMinutes() + 30) % 60 },
            timezone: "UTC",
          },
          201,
        );
        const disabled = await request(
          env,
          `/api/automations/${rule.id}/disable`,
          "POST",
          {},
        );
        invariant(disabled.enabled === false, "LOAD_RULE_DISABLE_UNCONFIRMED");
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const measuredRows = {
    projects: env.database.prepare("SELECT count(*) n FROM projects").get().n,
    automations: env.database
      .prepare("SELECT count(*) n FROM automations")
      .get().n,
  };
  invariant(
    measuredRows.projects === projectLimit &&
      measuredRows.automations === projectLimit * ruleLimit,
    "MAXIMUM_LOAD_NOT_REACHED",
  );
  const database = await stat(env.database.name),
    wal = await stat(env.database.name + "-wal").catch(() => null);
  return {
    inputFingerprint: runInputFingerprint(env.fixture.envelope.manifest),
    declaredLimits: { projects: projectLimit, rulesPerProject: ruleLimit },
    declarationProof: {
      compiledProjectFileDigest: digest(projectBytes),
      contractsArtifactDigest:
        env.config.initialRelease.components.coordinator.artifactDigest,
    },
    measuredRows,
    measuredBytes: { database: database.size, wal: wal?.size ?? 0 },
    populatedViaPublicHttp: true,
    observedAt: new Date().toISOString(),
  };
}

/** Read actual namespace results; this does not advance or alter a migration. */
export function maximumMigrationReceipt(env, attemptId, load) {
  const row = env.database
    .prepare(
      "SELECT plan_digest,plan,stage,checkpoint,completed_work,read_epoch,degraded FROM upgrade_online_migrations WHERE attempt_id=?",
    )
    .get(attemptId);
  invariant(
    row?.stage === "complete" && row.read_epoch >= 1 && row.degraded === 0,
    "MAXIMUM_MIGRATION_NOT_CONFIRMED",
  );
  const plan = JSON.parse(row.plan),
    projections = [];
  for (const [source, expectedRows] of Object.entries(load.measuredRows)) {
    const projection = plan.projections.find(
      (item) => item.sourceTable === source,
    );
    invariant(
      projection && /^upg_shadow_[a-z0-9_]+$/.test(projection.targetTable),
      "MAXIMUM_PROJECTION_REQUIRED",
    );
    const count = env.database
      .prepare(
        'SELECT count(*) n FROM "' +
          projection.targetTable +
          '" WHERE tombstone=0',
      )
      .get().n;
    invariant(count === expectedRows, "MAXIMUM_PROJECTION_COUNT_CHANGED");
    const pending = env.database
      .prepare(
        "SELECT count(*) n FROM upgrade_projection_changes WHERE plan_digest=? AND projection=? AND projected=0",
      )
      .get(row.plan_digest, projection.targetTable).n;
    invariant(pending === 0, "MAXIMUM_PROJECTION_PENDING");
    const fields = projection.fields;
    invariant(
      fields.every(
        (field) =>
          /^[a-z][a-z0-9_]*$/.test(field.name) &&
          field.source &&
          /^[a-z][a-z0-9_]*$/.test(field.source),
      ),
      "MAXIMUM_PROJECTION_MAPPING_REQUIRED",
    );
    const different = env.database
      .prepare(
        'SELECT count(*) n FROM "' +
          projection.targetTable +
          '" shadow JOIN "' +
          source +
          '" original ON shadow.row_key=original.id WHERE shadow.tombstone=0 AND (' +
          fields
            .map(
              (field) =>
                'shadow."' +
                field.name +
                '" IS NOT original."' +
                field.source +
                '"',
            )
            .join(" OR ") +
          ")",
      )
      .get().n;
    invariant(different === 0, "MAXIMUM_PROJECTION_VALUE_DIFFERENCE");
    projections.push({
      sourceTable: source,
      targetTable: projection.targetTable,
      rows: count,
      pendingChanges: pending,
      differences: different,
    });
  }
  return {
    ...load,
    phaseReceipts: [
      {
        attemptId,
        planDigest: row.plan_digest,
        stage: row.stage,
        checkpoint: JSON.parse(row.checkpoint),
        completedWork: row.completed_work,
        readEpoch: row.read_epoch,
        degraded: row.degraded,
        projections,
      },
    ],
    actualDrizzleCount: env.database
      .prepare("SELECT count(*) n FROM __drizzle_migrations")
      .get().n,
  };
}
