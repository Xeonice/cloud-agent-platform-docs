import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contextInputs } from "./prepare-context.mjs";
import { CONTAINER_INPUTS } from "./api-context.mjs";
import { prepareDeployContext } from "./prepare-deploy-context.mjs";

// Guard: Mac host values are derived by deploy/containers/host-layout.mjs from
// the passwd account running a tool, never written into the code. Every
// non-test, non-documentation file under deploy/ and scripts/ (plus the root
// package.json and docker-compose.yml) is scanned line by line, comments
// included. Tests, test fixtures and Markdown may name example accounts.
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_DIRECTORIES = ["deploy", "scripts"];
const SCAN_FILES = ["package.json", "docker-compose.yml"];
const skipped = (path) =>
  /\.test\.[cm]?js$/.test(path) ||
  /(^|\/)fixtures\//.test(path) ||
  /\.md$/.test(path);
// Generated dependency pins: their versions and hashes carry arbitrary digit
// runs (a plugin version such as 501.v…), and no UID can hide in a pin. Only
// the UID rule skips them.
const generatedPin = (path) =>
  /(^|\/)(package-lock|plugins\.lock)\.json$/.test(path);

// The public deployment domain (agent., agent-api., jenkins.douglasdong.com) is
// a deployment identity, not a host account or path.
const DOMAIN =
  /(?<![A-Za-z0-9-])(?:[a-z0-9-]+\.)*douglasdong\.com(?![A-Za-z0-9-])/g;
// Content digests (npm integrity, sha256 hex) are not UIDs.
const DIGESTS = [
  /sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}/g,
  /(?<![0-9A-Za-z])[0-9a-f]{32,}(?![0-9A-Za-z])/gi,
];
const ENV_NAME = String.raw`(?:HOME|USER|LOGNAME|COLIMA_HOME|XDG_[A-Z0-9_]*|AGENT_PLATFORM_[A-Z0-9_]*)`;
const ENV_READ = new RegExp(
  String.raw`process\.env\??\.${ENV_NAME}\b|process\.env(?:\?\.)?\[\s*["'\x60]${ENV_NAME}["'\x60]\s*\]`,
);

// Line rules: id, what the line must not contain, and where the value comes from instead.
const LINE_RULES = [
  {
    id: "users-path",
    test: (line) => /\/Users\/[A-Za-z0-9._-]/.test(line),
    fix: "derive the account home with host-layout.mjs",
  },
  {
    id: "account-name",
    test: (line) => line.replace(DOMAIN, "").includes("douglasdong"),
    fix: "the operator is the passwd account (host-layout.mjs); only the deployment domain may appear",
  },
  {
    id: "uid-501",
    test: (line, path) =>
      !generatedPin(path) &&
      /(^|[^0-9])501([^0-9]|$)/.test(
        DIGESTS.reduce((text, digest) => text.replace(digest, "#"), line),
      ),
    fix: "use the running operator UID (host-layout.mjs), or an injected UID in tests",
  },
  {
    id: "homedir",
    test: (line) => /\bhomedir\s*\(|\bos\.homedir\b/.test(line),
    fix: "os.homedir() follows $HOME; take the home from os.userInfo() through host-layout.mjs",
  },
  {
    id: "env-identity",
    test: (line) => ENV_READ.test(line),
    fix: "identity and host paths never come from the environment; overrides live only in host-layout.json",
  },
  {
    id: "orbstack",
    test: (line) => /\.orbstack\//.test(line),
    fix: "the Docker CLI is layout.dockerCli (default and override in host-layout.mjs)",
  },
  {
    id: "fnm-node",
    test: (line) => /fnm\/node-versions/.test(line),
    fix: "the Node binary is the one running the tool (process.execPath)",
  },
];
// Constructs that span lines: importing homedir from os, destructuring
// identity variables out of process.env.
const FILE_RULES = [
  {
    id: "homedir",
    pattern:
      /\bimport\s*\{[^}]*\bhomedir\b[^}]*\}\s*from\s*["'](?:node:)?os["']/g,
  },
  {
    id: "env-identity",
    pattern: new RegExp(
      String.raw`\{[^{}]*\b${ENV_NAME}\b[^{}]*\}\s*=\s*process\.env\b`,
      "g",
    ),
  },
];

// The only accepted occurrences. Each names a file, a rule and the exact
// trimmed line, and must match exactly once: when the line changes or goes
// away the entry fails and has to be revisited.
const ALLOWED = [
  {
    file: "deploy/containers/host-layout.mjs",
    rule: "account-name",
    line: '"com.douglasdong.agent-platform.container-engine.";',
    why: "Default LaunchDaemon label prefix: the reversed deployment domain, a service name rather than an account or path. Defined once, overridable with launchdLabelPrefix in host-layout.json; kept because changing it replaces the three LaunchDaemons.",
  },
  {
    file: "deploy/containers/host-layout.mjs",
    rule: "uid-501",
    line: "export const MIN_OPERATOR_UID = 501;",
    why: "Floor of the operator policy (the first regular macOS account UID), not a pinned identity: any account at or above it qualifies.",
  },
  {
    file: "deploy/containers/host-layout.mjs",
    rule: "env-identity",
    line: "colimaHome: () => process.env.COLIMA_HOME,",
    why: "The module's single environment read, used only to refuse a COLIMA_HOME that points away from <home>/.colima.",
  },
  {
    file: "deploy/containers/host-layout.mjs",
    rule: "orbstack",
    line: 'const DEFAULT_DOCKER_CLI = ".orbstack/bin/docker";',
    why: "Default dockerCli, relative to the operator home; overridable in host-layout.json.",
  },
  {
    file: "deploy/containers/controller.mjs",
    rule: "env-identity",
    line: "value = process.env.AGENT_PLATFORM_JENKINS_URL,",
    why: "The variable Compose interpolates into the controller (${AGENT_PLATFORM_JENKINS_URL:-…}); it is read to be checked against the two approved controller URLs and selects a URL, never a host path or account.",
  },
  {
    file: "deploy/containers/verify-controller.mjs",
    rule: "account-name",
    line: 'credential.username === "douglasdong" &&',
    why: "Jenkins administrator of the lab controller, a Jenkins account rather than a Mac account. Renamed together with 10-container-guard.groovy in stage 3, at the next controller rebuild (T29).",
  },
  {
    file: "deploy/containers/init.groovy.d/10-container-guard.groovy",
    rule: "account-name",
    line: "realm.createAccount('douglasdong', password)",
    why: "Same lab controller administrator (stage 3, with verify-controller.mjs).",
  },
  {
    file: "deploy/containers/init.groovy.d/10-container-guard.groovy",
    rule: "account-name",
    line: "Files.writeString(admin, groovy.json.JsonOutput.toJson([username: 'douglasdong', password: password]))",
    why: "Same lab controller administrator (stage 3, with verify-controller.mjs).",
  },
];

// Installed dependencies and editor or VCS state are not repository code.
async function walk(relative, out) {
  for (const entry of await fs.readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && entry.name !== "node_modules")
        await walk(path, out);
    } else if (entry.isFile() && entry.name !== ".DS_Store" && !skipped(path))
      out.push(path);
  }
  return out;
}

async function scannedFiles() {
  const files = [];
  for (const directory of SCAN_DIRECTORIES) await walk(directory, files);
  for (const path of SCAN_FILES)
    if (await fs.stat(join(root, path)).catch(() => null)) files.push(path);
  return files.sort();
}

// Findings of one file: [{rule, line (1-based), text (trimmed)}].
function findings(path, text) {
  const lines = text.split("\n");
  const found = [];
  lines.forEach((line, index) => {
    for (const rule of LINE_RULES)
      if (rule.test(line, path))
        found.push({ rule: rule.id, line: index + 1, text: line.trim() });
  });
  for (const rule of FILE_RULES)
    for (const match of text.matchAll(rule.pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      found.push({ rule: rule.id, line, text: lines[line - 1].trim() });
    }
  return found;
}

test("the guard rules catch host values and spare domains, digests and injected test values", () => {
  const caught = (text, path = "deploy/x.mjs") =>
    findings(path, text).map((entry) => entry.rule);
  for (const [text, rule] of [
    ['const home = "/Users/alice";', "users-path"],
    ["// see /Users/Shared/agent-platform-jenkins", "users-path"],
    ['if (user === "douglasdong") run();', "account-name"],
    ["label: com.douglasdong.agent-platform.x", "account-name"],
    ["s.uid === 501 &&", "uid-501"],
    ["allowed = [0, 501, 1000];", "uid-501"],
    ["gui/501", "uid-501"],
    ["const home = os.homedir();", "homedir"],
    ["const home = homedir ();", "homedir"],
    ["process.env.HOME", "env-identity"],
    ["process.env?.USER", "env-identity"],
    ["process.env.LOGNAME", "env-identity"],
    ['process.env["XDG_DATA_HOME"]', "env-identity"],
    ["process.env['AGENT_PLATFORM_PRIVATE_DIR']", "env-identity"],
    ["process.env.COLIMA_HOME", "env-identity"],
    ["const docker = home + '/.orbstack/bin/docker';", "orbstack"],
    ["node = '/x/fnm/node-versions/v22/bin/node'", "fnm-node"],
  ])
    assert.deepEqual(caught(text), [rule], text);
  assert.deepEqual(
    caught('import {\n  userInfo,\n  homedir,\n} from "node:os";'),
    ["homedir"],
  );
  assert.deepEqual(caught("const { HOME, PATH } = process.env;"), [
    "env-identity",
  ]);
  for (const text of [
    'url: "https://jenkins.douglasdong.com/",',
    '"https://agent-api.douglasdong.com"',
    '"integrity": "sha512-4Ob1qvYMPnlF2N9rdmKdkQFdrq16QVcQwBsO8yiPZXof0fHKFF+LmQV501XFbi7lHyrKm8rlJRfQ/M8bZZPVLw=="',
    '"sha256": "' + "a".repeat(30) + "e501f" + "b".repeat(29) + '"',
    "port: 5010, uid: 1501, gid: 15012",
    "uid: 5101, home: identity.homedir",
    "home: userInfo().homedir,",
    "process.env.HOMEBREW_CACHE",
    "process.env.CONTROLLER_MODE",
    'env: { HOME: "/home/jenkins", USER: "jenkins" }',
  ])
    assert.deepEqual(caught(text), [], text);
  assert.deepEqual(
    caught('"version": "501.v1234_abcd"', "deploy/jenkins/plugins.lock.json"),
    [],
  );
});

test("no deploy or scripts code names a Mac account, home, UID, Docker CLI or Node path", async () => {
  const files = await scannedFiles();
  // The scan really covers the operator tools, image modules and scripts.
  for (const path of [
    "deploy/containers/host-layout.mjs",
    "deploy/containers/bootstrap-host.mjs",
    "deploy/ops/upgrade-agents.mjs",
    "deploy/jenkins/manage.mjs",
    "deploy/jenkins/deployment-platform.mjs",
    "deploy/containers/init.groovy.d/10-container-guard.groovy",
    "deploy/containers/ci-tools/package-lock.json",
    "scripts/docs-check.mjs",
    "package.json",
  ])
    assert.ok(files.includes(path), path);
  assert.ok(!files.some(skipped));
  const used = new Map(ALLOWED.map((entry) => [entry, 0]));
  const violations = [];
  for (const path of files) {
    const bytes = await fs.readFile(join(root, path));
    if (bytes.includes(0)) continue;
    for (const finding of findings(path, bytes.toString("utf8"))) {
      const entry = ALLOWED.find(
        (allowed) =>
          allowed.file === path &&
          allowed.rule === finding.rule &&
          allowed.line === finding.text,
      );
      if (entry) used.set(entry, used.get(entry) + 1);
      else
        violations.push(
          `${path}:${finding.line} [${finding.rule}] ${finding.text}\n    -> ${LINE_RULES.find((rule) => rule.id === finding.rule).fix}`,
        );
    }
  }
  assert.deepEqual(violations, [], violations.join("\n"));
  for (const [entry, count] of used)
    assert.equal(
      count,
      1,
      `Allowed occurrence must match exactly once (stale entry?): ${entry.file} [${entry.rule}] ${entry.line}`,
    );
});

// The three Mac-only CLIs under deploy/jenkins are copied into the deploy
// image without ../containers; they may import the layout only on their CLI
// path. No other image file may load it at all.
const MAC_CLIS = new Set(
  ["manage.mjs", "setup-github-app.mjs", "import-ghcr-token.mjs"].map(
    (name) => "deploy/jenkins/" + name,
  ),
);
const STATIC_IMPORT =
  /^\s*(?:import|export)\s[^;]*?["'][^"']*host-layout(?:\.mjs)?["']/m;
const DYNAMIC_IMPORT =
  /\bimport\s*\(\s*["'\x60][^"'\x60]*host-layout\.mjs["'\x60]\s*\)/;

test("no image ships or statically imports host-layout.mjs; only the three Mac CLIs import it dynamically", async (t) => {
  const temporary = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "host-literals-")),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const { manifest } = await prepareDeployContext(root, temporary);
  const sources = new Set([
    ...manifest.files.map((file) => file.source),
    ...contextInputs("ci").map((input) => input.source),
    ...contextInputs("controller").map((input) => input.source),
    ...CONTAINER_INPUTS.map((name) => "deploy/containers/" + name),
  ]);
  for (const path of MAC_CLIS) assert.ok(sources.has(path), path);
  for (const source of sources) {
    assert.ok(!/host-layout/.test(source), source);
    if (!source.endsWith(".mjs")) continue;
    const text = await fs.readFile(join(root, source), "utf8");
    assert.doesNotMatch(text, STATIC_IMPORT, source);
    assert.equal(DYNAMIC_IMPORT.test(text), MAC_CLIS.has(source), source);
  }
  // Every non-test module under deploy/jenkins is part of the deploy image.
  for (const name of await fs.readdir(join(root, "deploy/jenkins")))
    if (name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
      assert.ok(sources.has("deploy/jenkins/" + name), name);
});
