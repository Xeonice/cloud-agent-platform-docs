import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type Observation = {
  title: string;
  sourceLocation?: string;
  passed: boolean;
};
type Attempt = {
  title: string;
  file: string;
  retry: number;
  status?: string;
  durationMs?: number;
  observations: Observation[];
};

/** Public reporter events count runtime expects, including completed expect.poll steps. */
export default class ExecutionReporter implements Reporter {
  private readonly startedAt = new Date().toISOString();
  private readonly attempts: Attempt[] = [];
  private readonly running = new Map<TestResult, Attempt>();

  onTestBegin(test: TestCase, result: TestResult) {
    const attempt: Attempt = {
      title: test.titlePath().join(" > "),
      file: relative(root, test.location.file),
      retry: result.retry,
      observations: [],
    };
    this.attempts.push(attempt);
    this.running.set(result, attempt);
  }

  onStepEnd(_test: TestCase, result: TestResult, step: TestStep) {
    if (step.category !== "expect") return;
    const location = step.location;
    this.running.get(result)?.observations.push({
      title: step.title,
      sourceLocation: location
        ? `${relative(root, location.file)}:${location.line}:${location.column}`
        : undefined,
      passed: step.error === undefined,
    });
  }

  onTestEnd(_test: TestCase, result: TestResult) {
    const attempt = this.running.get(result);
    if (attempt) {
      attempt.status = result.status;
      attempt.durationMs = result.duration;
    }
  }

  async onEnd(result: FullResult) {
    const observations = this.attempts.flatMap(
      (attempt) => attempt.observations,
    );
    const locations = new Set(
      observations.flatMap((observation) =>
        observation.sourceLocation ? [observation.sourceLocation] : [],
      ),
    );
    const files = [
      ...new Set([
        ...this.attempts.map((attempt) => attempt.file),
        "e2e-contract/acceptance/execution-reporter.ts",
        "e2e-contract/playwright.config.ts",
        "e2e-contract/global-setup.ts",
        "e2e-contract/server/start-api.ts",
        "e2e-contract/server/start-web.mjs",
        "api/acceptance/support/protocol-resources.ts",
      ]),
    ];
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          createHash("sha256")
            .update(await readFile(resolve(root, file)))
            .digest("hex"),
        ]),
      ),
    );
    const report = {
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      status: result.status,
      actualScenarios: this.attempts.length,
      passedScenarios: this.attempts.filter(
        (attempt) => attempt.status === "passed",
      ).length,
      failedScenarios: this.attempts.filter((attempt) =>
        ["failed", "timedOut"].includes(attempt.status ?? ""),
      ).length,
      skippedScenarios: this.attempts.filter(
        (attempt) => attempt.status === "skipped",
      ).length,
      runtimeExpectSteps: observations.length,
      distinctObservedAssertionLocations: locations.size,
      assertionCounting:
        "Actual public Playwright onStepEnd events with category=expect; distinct assertions are observed source locations. A completed expect.poll is one public step; internal polling retries are not counted separately.",
      sourceHashes,
      attempts: this.attempts,
      realBoundaries: [
        "Chromium UI actions and same-origin production Next.js proxy without request/WS/HAR interception",
        "Complete compiled Nest AppModule and current production SQLite migrations in an isolated DATA_ROOT",
        "Production project workspace filesystem, repositories, business services, HTTP responses and terminal gateway",
      ],
      controlledExternalBoundaries: [
        "External sandbox provider transport and OCI manifest metadata; terminal output uses a real native Node subprocess byte stream",
        "A synthetic API key and local TCP model-connectivity destination; production connectivity probe still runs",
        "Test-created anonymous Git repository served as real HTTP bytes on a non-loopback IPv4 interface; production Git clone and local branch queries run unchanged",
      ],
      unverifiedExternalCapabilities: [
        "Real Docker/BoxLite resources",
        "Vendor OAuth/account authentication",
        "Native PTY device semantics",
      ],
    };
    const output = resolve(
      root,
      "e2e-contract/artifacts/execution-report.json",
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  }
}
