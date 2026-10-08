import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { contextInputs, prepareContext } from "./prepare-context.mjs";
import { prepareDeployContext } from "./prepare-deploy-context.mjs";
import { CONTAINER_INPUTS } from "./api-context.mjs";

async function fixture(component, callback) {
  const temporary = await fs.mkdtemp(join(tmpdir(), "container-context-test-"));
  const source = join(temporary, "source");
  await fs.mkdir(source);
  for (const { source: relative } of contextInputs(component)) {
    const path = join(source, relative);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, `public ${relative}\n`);
  }
  try {
    await callback(source, temporary);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

test("controller and CI contexts contain only their fixed public input files", async () => {
  for (const component of ["controller", "ci"])
    await fixture(component, async (source, temporary) => {
      await fs.writeFile(
        join(source, ".env"),
        "must never enter Docker context",
      );
      await fs.mkdir(join(source, "private"));
      await fs.writeFile(
        join(source, "private", "runtime.env"),
        "private sentinel",
      );
      const { context, manifest } = await prepareContext(
        component,
        source,
        temporary,
      );
      assert.equal((await fs.stat(context)).mode & 0o777, 0o700);
      assert.deepEqual(
        manifest.files.map(({ target }) => target),
        contextInputs(component).map(({ target }) => target),
      );
      for (const input of manifest.files) {
        assert.equal(
          await fs.readFile(join(context, input.target), "utf8"),
          `public ${input.source}\n`,
        );
        assert.match(input.sha256, /^[a-f0-9]{64}$/);
        assert.equal(
          (await fs.stat(join(context, input.target))).mode & 0o777,
          0o644,
        );
      }
      await assert.rejects(fs.stat(join(context, ".env")), { code: "ENOENT" });
      await assert.rejects(fs.stat(join(context, "private")), {
        code: "ENOENT",
      });
    });
});

test("a symlink file, symlink parent or missing input is refused before creating a context", async () => {
  for (const kind of ["file", "parent", "missing"])
    await fixture("controller", async (source, temporary) => {
      const input = contextInputs("controller")[0].source;
      const path = join(source, input);
      if (kind === "parent") {
        await fs.rename(join(source, "deploy"), join(source, "outside"));
        await fs.symlink(join(source, "outside"), join(source, "deploy"));
      } else {
        await fs.rm(path);
        if (kind === "file")
          await fs.symlink(
            join(source, "deploy/jenkins/plugins.lock.json"),
            path,
          );
      }
      await assert.rejects(prepareContext("controller", source, temporary));
      assert.deepEqual(
        (await fs.readdir(temporary)).filter((name) =>
          name.startsWith("agent-platform-"),
        ),
        [],
      );
    });
});

test("component names cannot select arbitrary repository files", () => {
  for (const value of [
    "../private",
    "constructor",
    "__proto__",
    "api",
    undefined,
  ])
    assert.throws(() => contextInputs(value), /controller or ci/);
});

test("the current trusted deploy context builds without retired Mac sources and contains every relative tool dependency", async (t) => {
  const temporary = await fs.mkdtemp(join(tmpdir(), "current-deploy-context-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const { context, manifest } = await prepareDeployContext(root, temporary);
  await assert.rejects(fs.stat(join(context, "macmini")), { code: "ENOENT" });
  for (const name of [".env", "private", "api", "web"])
    await assert.rejects(fs.stat(join(context, name)), { code: "ENOENT" });
  assert.equal(
    manifest.files.some(({ source }) => source.includes("/macmini/")),
    false,
  );
  const dockerfile = await fs.readFile(
    join(context, "deploy.Dockerfile"),
    "utf8",
  );
  const copied = [...dockerfile.matchAll(/^COPY ([\w-]+)\/ /gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(copied, ["tools", "container-tools"]);
  for (const directory of copied)
    assert.equal((await fs.stat(join(context, directory))).isDirectory(), true);
  const tools = manifest.files.filter(({ target }) =>
    target.startsWith("tools/"),
  );
  assert.ok(tools.length > 0);
  for (const { target } of tools) {
    const contents = await fs.readFile(join(context, target), "utf8");
    for (const match of contents.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g))
      assert.equal(
        (await fs.stat(resolve(context, dirname(target), match[1]))).isFile(),
        true,
        `Missing public dependency of ${target}`,
      );
  }
});

test("the trusted deploy image carries exactly the API image inputs the build pins", async (t) => {
  const temporary = await fs.mkdtemp(join(tmpdir(), "current-deploy-inputs-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const { manifest } = await prepareDeployContext(root, temporary);
  assert.deepEqual(
    manifest.files
      .filter(({ target }) => target.startsWith("container-tools/"))
      .map(({ target }) => target.slice("container-tools/".length))
      .sort(),
    [...CONTAINER_INPUTS].sort(),
  );
});

test("a linked trusted tool directory is refused before a deploy build context is created", async (t) => {
  const temporary = await fs.mkdtemp(join(tmpdir(), "current-deploy-symlink-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, "source");
  await fs.mkdir(join(source, "deploy/containers"), { recursive: true });
  await fs.writeFile(
    join(source, "deploy/containers/deploy.Dockerfile"),
    "public fixture",
  );
  const outside = join(temporary, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(
    join(outside, "tool.mjs"),
    "export const publicTool = true;",
  );
  await fs.symlink(outside, join(source, "deploy/jenkins"));
  await assert.rejects(prepareDeployContext(source, temporary), /symlink/);
  assert.equal(
    (await fs.readdir(temporary)).some((name) =>
      name.startsWith("agent-platform-deploy-context-"),
    ),
    false,
  );
});
