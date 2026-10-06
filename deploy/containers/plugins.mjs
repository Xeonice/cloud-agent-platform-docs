import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const JENKINS_VERSION = "2.580.1";
export const JAVA_MAJOR = 21;

export function validatePluginLock(lock) {
  if (
    lock?.jenkins !== JENKINS_VERSION ||
    lock.javaMajor !== JAVA_MAJOR ||
    !Array.isArray(lock.plugins) ||
    lock.plugins.length === 0
  )
    throw new Error("The reviewed Jenkins/JDK plugin lock is required");
  const names = new Set();
  for (const plugin of lock.plugins) {
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(plugin.name ?? "") ||
      !/^[a-zA-Z0-9_.-]+$/.test(plugin.version ?? "") ||
      !/^[a-f0-9]{64}$/.test(plugin.sha256 ?? "") ||
      names.has(plugin.name)
    )
      throw new Error("Invalid or duplicate pinned plugin");
    names.add(plugin.name);
  }
  return lock;
}

export async function downloadPlugins(
  lock,
  destination,
  { fetchImpl = fetch } = {},
) {
  validatePluginLock(lock);
  await fs.mkdir(destination, { recursive: true });
  if ((await fs.readdir(destination)).length !== 0)
    throw new Error("Plugin output directory must be empty");
  try {
    for (const plugin of lock.plugins) {
      const url = `https://updates.jenkins.io/download/plugins/${plugin.name}/${plugin.version}/${plugin.name}.hpi`;
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body)
        throw new Error(`Pinned plugin download failed: ${plugin.name}`);
      const file = await fs.open(
        join(destination, `${plugin.name}.jpi`),
        "wx",
        0o644,
      );
      const digest = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 128 * 1024 * 1024)
            throw new Error(`Pinned plugin exceeds size limit: ${plugin.name}`);
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await file.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            if (bytesWritten === 0)
              throw new Error("Pinned plugin file could not be written");
            offset += bytesWritten;
          }
        }
      } finally {
        await file.close();
      }
      if (digest.digest("hex") !== plugin.sha256)
        throw new Error(`Pinned plugin SHA mismatch: ${plugin.name}`);
    }
  } catch (error) {
    for (const plugin of lock.plugins)
      await fs.rm(join(destination, `${plugin.name}.jpi`), { force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , lockPath, destination] = process.argv;
  if (!lockPath || !destination || process.argv.length !== 4)
    throw new Error(
      "Usage: plugins.mjs <reviewed-lock.json> <empty-output-directory>",
    );
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  await downloadPlugins(lock, destination);
  console.log(
    JSON.stringify({
      status: "verified",
      plugins: lock.plugins.length,
      jenkins: lock.jenkins,
    }),
  );
}
