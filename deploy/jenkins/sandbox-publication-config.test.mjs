import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const config = {
  version: 1,
  registry: "ghcr.io",
  owner: "xeonice",
  platforms: ["linux/amd64", "linux/arm64"],
  defaultTag: "latest",
  tagPrefix: "sandbox-image-",
  images: [
    {
      tier: "aio",
      context: "images/platform-sandbox",
      image: "agent-platform-sandbox",
    },
    {
      tier: "boxlite",
      context: "images/platform-boxlite",
      image: "agent-platform-boxlite",
    },
  ],
};
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "publication-config-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "scripts"));
  await fs.cp(
    new URL(
      "../../api/scripts/check-default-image-consistency.mjs",
      import.meta.url,
    ),
    join(root, "scripts/check.mjs"),
  );
  await fs.mkdir(join(root, "config"));
  await fs.mkdir(join(root, "packages/shared-kernel/src/domain"), {
    recursive: true,
  });
  await fs.writeFile(
    join(root, "docker-compose.yml"),
    "SANDBOX_DEFAULT_IMAGE: ${SANDBOX_DEFAULT_IMAGE:-}\n",
  );
  await fs.writeFile(join(root, ".env.example"), "SANDBOX_DEFAULT_IMAGE=\n");
  await fs.writeFile(
    join(root, "packages/shared-kernel/src/domain/builtin-image.ts"),
    "aio: 'ghcr.io/xeonice/agent-platform-sandbox:latest',\nboxlite: 'ghcr.io/xeonice/agent-platform-boxlite:latest',\n'xeonice/agent-platform-sandbox',\n'xeonice/agent-platform-boxlite',\n",
  );
  for (const image of config.images) {
    await fs.mkdir(join(root, image.context), { recursive: true });
    await fs.writeFile(
      join(root, image.context, "Dockerfile"),
      "FROM node:22\nENV LANG=C.UTF-8\n",
    );
  }
  return {
    root,
    run: () => exec(process.execPath, ["scripts/check.mjs"], { cwd: root }),
    write: (value) =>
      fs.writeFile(
        join(root, "config/sandbox-publish.json"),
        JSON.stringify(value),
      ),
  };
}

test("actual default-image gate uses the Jenkins configuration with no Actions workflow; rejects provider/architecture/owner/default drift", async (t) => {
  const f = await fixture(t);
  await f.write(config);
  const valid = await f.run();
  assert.match(valid.stdout, /Jenkins/);
  await assert.rejects(
    fs.access(join(f.root, ".github/workflows/publish-sandbox-image.yml")),
  );
  for (const bad of [
    { ...config, owner: "someone-else" },
    { ...config, defaultTag: "stable" },
    { ...config, platforms: ["linux/arm64"] },
    { ...config, images: [config.images[0]] },
    {
      ...config,
      images: [
        config.images[0],
        { ...config.images[1], context: config.images[0].context },
      ],
    },
  ]) {
    await f.write(bad);
    await assert.rejects(f.run(), (error) => error.code === 1);
  }
  await f.write(config);
  await fs.writeFile(
    join(f.root, ".env.example"),
    "SANDBOX_DEFAULT_IMAGE=ghcr.io/xeonice/agent-platform-boxlite:latest\n",
  );
  await assert.rejects(
    f.run(),
    (error) => error.code === 1 && error.stderr.includes("留空"),
  );
});
