import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import {
  privateFile,
  validateConfig,
  readJenkinsReceipt,
  jenkinsInvocation,
} from "../macmini/lib.mjs";

const [configPath, sha, number, directory] = process.argv.slice(2);
const config = validateConfig(
  JSON.parse(await privateFile(resolve(configPath))),
);
const request = jenkinsInvocation(
  config,
  "deploy",
  sha,
  number,
  process.env.BUILD_URL,
);
const receipt = await readJenkinsReceipt(config, request);
if (!receipt)
  throw new Error("No verified native Jenkins receipt for this build");
const output = resolve(directory);
const workspace = join(config.root, "jenkins-agent/workspace/");
if (
  !output.startsWith(workspace) ||
  output.split("/").at(-1) !== `api-reports-${request.buildNumber}`
)
  throw new Error("Unexpected Jenkins report destination");
await fs.mkdir(output, { mode: 0o700 });
for (const [input, name] of [
  ["acceptance/execution-report.json", "execution-report.json"],
  ["reports/acceptance/non-protocol.json", "non-protocol.json"],
  ["reports/acceptance/protocol.json", "protocol.json"],
]) {
  // Test runners write ordinary 0644 JSON in the private immutable CI tree.
  // These files carry test output, never runtime.env or production credentials.
  const handle = await fs.open(
    join(receipt.artifactPath, input),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o022 ||
      stat.size > 16 * 1024 * 1024
    )
      throw new Error("Unsafe native acceptance report");
    const data = await handle.readFile();
    JSON.parse(data);
    await fs.writeFile(join(output, name), data, { flag: "wx", mode: 0o600 });
  } finally {
    await handle.close();
  }
}
console.log(
  JSON.stringify({
    state: "collected",
    sha,
    buildNumber: request.buildNumber,
    reportDirectory: output,
  }),
);
