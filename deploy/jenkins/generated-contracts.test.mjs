import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const current = '{"version":"current"}\n';
const declaration = 'export type Generated = "current";\n';

async function fixture(t, kind) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), `generated-${kind}-`)),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (path, contents) => {
    await fs.mkdir(dirname(join(root, path)), { recursive: true });
    await fs.writeFile(join(root, path), contents);
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Generated contract fixture");
  git("config", "user.email", "generated-contracts@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(root, "empty-hooks"));
  await fs.mkdir(join(root, "scripts"));
  // Execute the actual independently-cloneable child-repository gate. The fixture
  // only replaces its generators with real local build/emit programs, not Git.
  await fs.copyFile(
    join(repository, kind, "scripts/check-openapi.mjs"),
    join(root, "scripts/check-openapi.mjs"),
  );
  await write(".gitignore", "dist/\ntrace.log\n");
  await write(
    "package.json",
    JSON.stringify({
      name: `generated-contract-${kind}-fixture`,
      private: true,
      scripts: {
        build: "node fixtures/build.mjs",
        "openapi:emit": "node fixtures/emit.mjs",
        "generate:api": "node fixtures/generate.mjs",
      },
    }),
  );
  await write("contract.source.json", current);
  await write("type-name.txt", "Generated");
  await write("openapi.json", current);
  await write(
    "fixtures/build.mjs",
    `import * as fs from 'node:fs/promises';
await fs.mkdir('dist',{recursive:true});
await fs.writeFile('dist/openapi.json',await fs.readFile('contract.source.json'));
await fs.appendFile('trace.log','build\\n');
`,
  );
  await write(
    "fixtures/emit.mjs",
    `import * as fs from 'node:fs/promises';
await fs.writeFile('openapi.json',await fs.readFile('dist/openapi.json'));
await fs.appendFile('trace.log','emit\\n');
`,
  );
  await write(
    "fixtures/generate.mjs",
    `import * as fs from 'node:fs/promises';
const version=JSON.parse(await fs.readFile('openapi.json','utf8')).version;
const name=await fs.readFile('type-name.txt','utf8');
await fs.writeFile('src/types/generated/openapi.d.ts','export type '+name+' = '+JSON.stringify(version)+';\\n');
await fs.appendFile('trace.log','generate\\n');
`,
  );
  if (kind === "web")
    await write("src/types/generated/openapi.d.ts", declaration);
  git("add", ".");
  git("commit", "--quiet", "-m", "Baseline committed contracts and generators");
  await write("dist/openapi.json", '{"version":"stale-dist"}\n');
  const run = () =>
    new Promise((accept, reject) => {
      const child = spawn(process.execPath, ["scripts/check-openapi.mjs"], {
        cwd: root,
        env: { ...process.env, COREPACK_ENABLE_NETWORK: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => accept({ code, signal, output }));
    });
  return {
    root,
    write,
    git,
    run,
    output:
      kind === "api" ? "openapi.json" : "src/types/generated/openapi.d.ts",
  };
}

for (const kind of ["api", "web"]) {
  test(`${kind}: committed generation passes${kind === "api" ? " after rebuilding stale dist" : " with matching declarations"}`, async (t) => {
    const f = await fixture(t, kind);
    const result = await f.run();
    assert.equal(result.code, 0, result.output);
    assert.equal(
      await fs.readFile(join(f.root, f.output), "utf8"),
      kind === "api" ? current : declaration,
    );
    assert.equal(
      await fs.readFile(join(f.root, "trace.log"), "utf8"),
      kind === "api" ? "build\nemit\n" : "generate\n",
    );
  });

  const required =
    kind === "api"
      ? ["openapi.json"]
      : ["openapi.json", "src/types/generated/openapi.d.ts"];
  for (const path of required) {
    test(`${kind}: missing required ${path} fails before any generation`, async (t) => {
      const f = await fixture(t, kind);
      await fs.rm(join(f.root, path));
      const result = await f.run();
      assert.notEqual(result.code, 0);
      assert.match(result.output, /missing or not regular/);
      assert.equal(
        await fs.stat(join(f.root, "trace.log")).catch(() => null),
        null,
      );
    });
  }

  test(`${kind}: an untracked required file cannot pass merely because it exists`, async (t) => {
    const f = await fixture(t, kind);
    f.git("rm", "--cached", "--", f.output);
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /must be tracked in HEAD/);
    assert.equal(
      await fs.stat(join(f.root, "trace.log")).catch(() => null),
      null,
    );
  });

  test(`${kind}: a newly staged required file needs a HEAD commit before it can pass`, async (t) => {
    const f = await fixture(t, kind);
    f.git("rm", "--cached", "--", f.output);
    f.git("commit", "--quiet", "-m", "Remove required contract from HEAD");
    f.git("add", "--", f.output);
    const staged = await f.run();
    assert.notEqual(staged.code, 0);
    assert.match(staged.output, /must be tracked in HEAD/);
    assert.equal(
      await fs.stat(join(f.root, "trace.log")).catch(() => null),
      null,
    );
    f.git("commit", "--quiet", "-m", "Commit regenerated required contract");
    const committed = await f.run();
    assert.equal(committed.code, 0, committed.output);
  });

  test(`${kind}: staged output drift still fails when generation restores the working file to HEAD`, async (t) => {
    const f = await fixture(t, kind);
    await f.write(f.output, "staged drift\n");
    f.git("add", "--", f.output);
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /differ from HEAD/);
    assert.equal(f.git("diff", "--name-only", "HEAD", "--", f.output), "");
    assert.equal(
      f.git("diff", "--cached", "--name-only", "HEAD", "--", f.output),
      f.output,
    );
  });

  test(`${kind}: actual regenerated drift fails against the committed output`, async (t) => {
    const f = await fixture(t, kind);
    await f.write(
      kind === "api" ? "contract.source.json" : "type-name.txt",
      kind === "api" ? '{"version":"new-source"}\n' : "Changed",
    );
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /differ from HEAD/);
    assert.equal(
      await fs.readFile(join(f.root, f.output), "utf8"),
      kind === "api"
        ? '{"version":"new-source"}\n'
        : 'export type Changed = "current";\n',
    );
  });
}

for (const ignored of [false, true]) {
  test(`web: ${ignored ? "ignored" : "ordinary"} untracked generated additions cannot hide drift`, async (t) => {
    const f = await fixture(t, "web");
    const extra = "src/types/generated/extra.d.ts";
    if (ignored)
      await f.write(
        ".gitignore",
        "dist/\ntrace.log\nsrc/types/generated/extra.d.ts\n",
      );
    await f.write(extra, "export type Uncommitted = string;\n");
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /src\/types\/generated\/extra\.d\.ts/);
  });
}

test("web: OpenAPI input changes cannot hide behind otherwise valid generated declarations", async (t) => {
  const f = await fixture(t, "web");
  await f.write("openapi.json", '{"version":"changed-input"}\n');
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /openapi\.json/);
});

test("API build failure prevents a stale dist from being emitted and passing", async (t) => {
  const f = await fixture(t, "api");
  await f.write(
    "fixtures/build.mjs",
    "throw new Error('fixture build failed');\n",
  );
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /fixture build failed/);
  assert.equal(
    await fs.readFile(join(f.root, "openapi.json"), "utf8"),
    current,
  );
  assert.equal(
    await fs.stat(join(f.root, "trace.log")).catch(() => null),
    null,
  );
});
