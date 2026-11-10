import * as fs from "node:fs/promises";
import { join, relative } from "node:path";

export const REQUIRED_DEPLOYMENT_TEST_DIRECTORIES = [
  "containers",
  "host",
  "jenkins",
  "ops",
  "upgrade",
];

/** Local runs and CI discover the same sources, including future deploy folders. */
export async function deploymentTestSources(source) {
  const deployment = join(source, "deploy");
  for (const directory of REQUIRED_DEPLOYMENT_TEST_DIRECTORIES) {
    const stat = await fs.lstat(join(deployment, directory)).catch(() => null);
    if (!stat?.isDirectory())
      throw new Error(`Deployment regression sources are missing: deploy/${directory}`);
  }
  const tests = [];
  async function visit(directory) {
    for (const file of await fs.readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(file.name)) continue;
      const path = join(directory, file.name);
      if (file.isDirectory()) await visit(path);
      else if (file.isFile() && file.name.endsWith(".test.mjs"))
        tests.push(relative(source, path).split("\\").join("/"));
    }
  }
  await visit(deployment);
  for (const directory of REQUIRED_DEPLOYMENT_TEST_DIRECTORIES)
    if (!tests.some((path) => path.startsWith(`deploy/${directory}/`)))
      throw new Error(`Deployment regression sources are missing: deploy/${directory} is empty`);
  return tests.sort();
}
