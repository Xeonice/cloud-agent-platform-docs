import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { contextInputs, prepareContext } from "./prepare-context.mjs";

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
