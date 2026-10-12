import * as fs from "node:fs/promises";
import { join, resolve, dirname, isAbsolute, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { semanticContractGate } from "./semantic-contract-evidence.mjs";
import { onlineMigrationGate } from "./online-migration-evidence.mjs";
import { checkedPassed, uniqueAssertion } from "./execution-assertions.mjs";
import {
  atomicJson,
  treeManifest,
  fileDigest,
  inside,
} from "../../deploy/upgrade/io.mjs";
import {
  canonical,
  digest,
  invariant,
  runInputFingerprint,
} from "../../deploy/upgrade/trust.mjs";

const REQUIRED = [
  "N01",
  "N02",
  "N03",
  ...Array.from({ length: 14 }, (_, i) => "X" + String(i + 1).padStart(2, "0")),
  "WebA-APIA",
  "WebA-APIB",
  "WebB-APIB",
  "WebB-APIA",
];
const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "../..");
function argumentsOf(argv) {
  const value = {};
  for (let i = 0; i < argv.length; i += 2) {
    invariant(
      ["--report", "--package-root", "--manifest", "--config"].includes(
        argv[i],
      ) &&
        argv[i + 1] &&
        !argv[i + 1].startsWith("--"),
      "INVALID_NATIVE_ARGUMENT",
    );
    invariant(!(argv[i] in value), "DUPLICATE_NATIVE_ARGUMENT");
    value[argv[i]] = resolve(argv[i + 1]);
  }
  invariant(
    value["--report"] && value["--package-root"] && value["--manifest"],
    "NATIVE_INPUTS_REQUIRED",
  );
  return value;
}
async function run(
  program,
  args,
  { cwd = project, env = process.env, logPath } = {},
) {
  let log;
  if (logPath) log = await fs.open(logPath, "wx", 0o600);
  try {
    return await new Promise((ok, fail) => {
      const child = spawn(program, args, {
        cwd,
        env,
        shell: false,
        stdio: log ? ["ignore", log.fd, log.fd] : ["ignore", "pipe", "pipe"],
      });
      let output = "";
      if (!log)
        for (const stream of [child.stdout, child.stderr])
          stream.on("data", (bytes) => {
            output += String(bytes);
            if (output.length > 256 * 1024) output = output.slice(-128 * 1024);
          });
      child.once("error", fail);
      child.once("exit", (code, signal) =>
        ok({ code: code ?? 1, signal, output }),
      );
    });
  } finally {
    await log?.close();
  }
}
function testResults(suite) {
  const result = [];
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests ?? []) result.push({ spec, test });
  for (const nested of suite.suites ?? []) result.push(...testResults(nested));
  return result;
}
async function collectAssertions(browser, outputRoot) {
  const collected = [];
  for (const root of browser.suites ?? [])
    for (const { spec, test } of testResults(root)) {
      const results = test.results ?? [];
      for (const result of results)
        for (const attachment of result.attachments ?? []) {
          if (attachment.name !== "UPG assertions") continue;
          invariant(
            attachment.path &&
              isAbsolute(attachment.path) &&
              inside(outputRoot, attachment.path),
            "UNTRUSTED_ASSERTION_ARTIFACT",
          );
          const stat = await fs.lstat(attachment.path);
          invariant(
            stat.isFile() && !stat.isSymbolicLink(),
            "ASSERTION_ARTIFACT_INVALID",
          );
          const actual = JSON.parse(await fs.readFile(attachment.path, "utf8"));
          for (const assertion of actual.assertions ?? []) {
            invariant(
              typeof assertion.id === "string" &&
                ["passed", "failed", "partial", "not-run"].includes(
                  assertion.result,
                ) &&
                assertion.actualEvidence !== undefined,
              "INVALID_ACTUAL_ASSERTION",
            );
            collected.push({
              ...assertion,
              reportedResult: assertion.result,
              result:
                result.status === "passed"
                  ? assertion.result
                  : result.status === "skipped"
                    ? "not-run"
                    : "failed",
              expectLocation: `${spec.file}:${spec.line}`,
              actualEvidence: {
                path: relative(dirname(outputRoot), attachment.path),
                digest: (await fileDigest(attachment.path)).digest,
                actual: assertion.actualEvidence,
              },
              testStatus: result.status,
            });
          }
        }
    }
  return collected;
}
export async function verifyNativeUpgrade(input) {
  const reportPath = resolve(input.report),
    packageRoot = resolve(input.packageRoot),
    manifestPath = resolve(input.manifestPath);
  const outputRoot = join(dirname(reportPath), "native-" + randomUUID());
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const runId = "native-" + randomUUID();
  const report = {
    schemaVersion: 1,
    result: "not-run",
    skipped: 0,
    substituted: false,
    native: false,
    runId,
    recordedAt: new Date().toISOString(),
    assertions: [],
    gates: {},
  };
  let entered = false;
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")),
      manifest = raw.manifest ?? raw;
    report.commits = manifest.commits;
    report.runInputFingerprint = runInputFingerprint(manifest);
    const pkg = manifest.packages.find(
      (value) => value.platform === "linux" && value.arch === "arm64",
    );
    invariant(
      pkg && pkg.format === "native-tar",
      "LINUX_ARM64_PACKAGE_REQUIRED",
    );
    report.packageDigest = pkg.digest;
    invariant(
      manifest.runInputFingerprint === report.runInputFingerprint,
      "FROZEN_INPUT_FINGERPRINT_MISMATCH",
    );
    invariant(
      process.platform === "linux" &&
        process.arch === "arm64" &&
        Number(process.versions.node.split(".")[0]) === 22,
      "LINUX_ARM64_NODE22_REQUIRED",
    );
    const kvm = await fs.stat("/dev/kvm");
    invariant(kvm.isCharacterDevice(), "NATIVE_KVM_REQUIRED");
    const ioctl = await run("python3", [
      "-c",
      "import os,fcntl; f=os.open('/dev/kvm',os.O_RDWR); assert fcntl.ioctl(f,0xae00,0)==12; os.close(f); print('kvm-api-12')",
    ]);
    invariant(
      ioctl.code === 0 && ioctl.output.trim() === "kvm-api-12",
      "NATIVE_KVM_IOCTL_FAILED",
    );
    const installed = JSON.parse(
      await fs.readFile(join(packageRoot, "upgrade-artifact.json"), "utf8"),
    );
    invariant(
      installed.platform === "linux" &&
        installed.arch === "arm64" &&
        installed.nodeABI === process.versions.modules,
      "PACKAGE_NATIVE_ABI_MISMATCH",
    );
    invariant(
      canonical(installed.components) === canonical(manifest.components),
      "PACKAGE_COMPONENTS_MISMATCH",
    );
    const actualFiles = (await treeManifest(packageRoot)).filter(
      (file) =>
        !["upgrade-artifact.json", "installed.json"].includes(file.path),
    );
    invariant(
      canonical(actualFiles) === canonical(installed.files) &&
        digest(actualFiles) === installed.treeDigest,
      "PACKAGE_TREE_CHANGED",
    );
    const require = createRequire(join(packageRoot, "api", "package.json"));
    const Database = require("better-sqlite3"),
      db = new Database(":memory:");
    invariant(
      db.prepare("select 1 as ok").get().ok === 1,
      "ACTUAL_NATIVE_SQLITE_FAILED",
    );
    db.close();
    const sdkRequire = createRequire(
      join(packageRoot, "api/packages/modules/sandbox/package.json"),
    );
    const sdkPackage = JSON.parse(
      await fs.readFile(
        join(
          packageRoot,
          "api/packages/modules/sandbox/node_modules/@boxlite-ai/boxlite/package.json",
        ),
        "utf8",
      ),
    );
    invariant(
      sdkPackage.version === "0.9.7",
      "ACTUAL_BOXLITE_VERSION_REQUIRED",
    );
    await import(pathToFileURL(sdkRequire.resolve("@boxlite-ai/boxlite")).href);
    report.native = true;
    const configPath =
      input.configPath ?? process.env.UPGRADE_ACCEPTANCE_CONFIG;
    invariant(
      configPath && isAbsolute(configPath),
      "ACCEPTANCE_CONFIGURATION_REQUIRED",
    );
    const stat = await fs.lstat(configPath);
    invariant(
      stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
      "INSECURE_ACCEPTANCE_CONFIGURATION",
    );
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    invariant(
      ["external-model", "local-protocol-test"].includes(
        config.modelMode ?? "external-model",
      ),
      "INVALID_MODEL_QUALIFICATION_MODE",
    );
    report.modelMode = config.modelMode ?? "external-model";
    report.modelQualityQualified = false;
    invariant(
      config.isolated === true &&
        config.initialRoot &&
        config.archiveRoot &&
        config.legacyRoot,
      "REAL_BASELINE_AND_LEGACY_INPUTS_REQUIRED",
    );
    const archive = await fileDigest(join(config.archiveRoot, pkg.name));
    invariant(
      archive.digest === pkg.digest && archive.bytes === pkg.bytes,
      "ACTUAL_PACKAGE_ARCHIVE_MISMATCH",
    );
    invariant(
      resolve(config.targetRoot) === packageRoot &&
        canonical(config.targetManifest.components) ===
          canonical(manifest.components) &&
        canonical(config.targetManifest.commits) ===
          canonical(manifest.commits),
      "ACCEPTANCE_TARGET_MISMATCH",
    );
    const head = await run("git", ["rev-parse", "HEAD"]);
    invariant(
      head.code === 0 && head.output.trim() === manifest.commits.project,
      "NATIVE_RUNNER_SOURCE_NOT_PINNED",
    );
    const clean = await run("git", [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "deploy",
      "e2e-contract",
    ]);
    invariant(
      clean.code === 0 && clean.output.trim() === "",
      "NATIVE_RUNNER_SOURCE_DIRTY",
    );
    const built = {
      id: "native-build",
      result: "passed",
      expectLocation: "native/verify-upgrade.mjs",
      actualEvidence: {
        node: process.version,
        abi: process.versions.modules,
        kvmIoctl: 12,
        packageTreeDigest: installed.treeDigest,
        archiveDigest: archive.digest,
        boxlite: "0.9.7",
        inputFingerprint: report.runInputFingerprint,
      },
    };
    report.gates.build = { result: "passed", assertions: [built] };
    // Execute the repository's actual browser/role/native scenarios. There is no
    // external driver, mocked provider, pre-existing report or report override.
    const playwright = createRequire(
      join(project, "e2e-contract", "package.json"),
    ).resolve("@playwright/test/cli");
    const browserPath = join(outputRoot, "browser-results.json");
    entered = true;
    const executed = await run(
      process.execPath,
      [
        playwright,
        "test",
        "--config",
        join(project, "e2e-contract", "upgrade.playwright.config.ts"),
        "--output",
        join(outputRoot, "test-results"),
      ],
      {
        cwd: join(project, "e2e-contract"),
        env: {
          ...process.env,
          UPGRADE_ACCEPTANCE_CONFIG: configPath,
          UPGRADE_PLAYWRIGHT_REPORT: browserPath,
        },
        logPath: join(outputRoot, "browser.log"),
      },
    );
    const browser = JSON.parse(await fs.readFile(browserPath, "utf8"));
    const actual = await collectAssertions(browser, outputRoot);
    report.assertions = REQUIRED.map((id) => uniqueAssertion(actual, id));
    for (const name of [
      "contracts",
      "four-combinations",
      "native-continuity",
      "fault-recovery",
      ...(manifest.upgradePaths.some((path) => path.migrationPlanDigest)
        ? ["online-migration"]
        : []),
    ]) {
      const ids =
        name === "four-combinations"
          ? REQUIRED.filter((id) => id.startsWith("Web"))
          : name === "native-continuity"
            ? ["N01", "N02", "N03"]
            : name === "fault-recovery"
              ? REQUIRED.filter((id) => id.startsWith("X"))
              : name === "online-migration"
                ? ["X11", "X12", "X13", "X14"]
                : REQUIRED.filter((id) => id.startsWith("Web"));
      const assertions = report.assertions.filter((assertion) =>
        ids.includes(assertion.id),
      );
      report.gates[name] = {
        result:
          assertions.length === ids.length && assertions.every(checkedPassed)
            ? "passed"
            : "partial",
        assertions,
      };
    }
    if (manifest.contractPlans?.length)
      report.gates["semantic-contract"] = semanticContractGate(
        manifest.contractPlans,
        actual,
        report.runInputFingerprint,
      );
    if (manifest.upgradePaths.some((path) => path.migrationPlanDigest))
      report.gates["online-migration"] = onlineMigrationGate(
        actual,
        report.runInputFingerprint,
      );
    report.skipped = browser.stats?.skipped ?? 0;
    report.result =
      executed.code === 0 &&
      report.skipped === 0 &&
      report.assertions.every(checkedPassed) &&
      Object.values(report.gates).every((gate) => gate.result === "passed")
        ? "passed"
        : "failed";
    report.execution = {
      exitCode: executed.code,
      report: browserPath,
      isolation: config.isolation ?? "unconfirmed",
    };
    invariant(
      report.result === "passed",
      "NATIVE_MANDATORY_SCENARIOS_NOT_PASSED",
    );
    return report;
  } catch (error) {
    report.result = entered ? "failed" : "not-run";
    report.reason =
      error.code ??
      (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "NATIVE_EXECUTION_FAILED");
    for (const id of REQUIRED)
      if (!report.assertions.some((assertion) => assertion.id === id))
        report.assertions.push({
          id,
          result: "not-run",
          expectLocation: "native/verify-upgrade.mjs",
          actualEvidence: { reason: report.reason },
        });
    throw Object.assign(new Error(report.reason), {
      report,
      code: report.reason,
    });
  } finally {
    report.recordedAt = new Date().toISOString();
    await atomicJson(reportPath, report);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const value = argumentsOf(process.argv.slice(2));
    await verifyNativeUpgrade({
      report: value["--report"],
      packageRoot: value["--package-root"],
      manifestPath: value["--manifest"],
      configPath: value["--config"],
    });
    process.stdout.write("Native upgrade qualification passed\n");
  } catch (error) {
    process.stderr.write((error.code ?? "NATIVE_EXECUTION_FAILED") + "\n");
    process.exitCode = 1;
  }
}
