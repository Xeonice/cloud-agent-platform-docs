import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const directory =
  "/Users/douglasdong/.local/share/agent-platform-jenkins-tools";
if (process.getuid() !== 501 || !process.stdin.isTTY)
  throw new Error("Run in Douglas's interactive Terminal, without sudo");
const stat = await fs.lstat(directory);
if (!stat.isDirectory() || stat.uid !== 501 || stat.mode & 0o077)
  throw new Error("Unsafe private credential directory");
const result = spawnSync(
  "/usr/bin/python3",
  [
    "-c",
    "import getpass; print(getpass.getpass('GHCR classic PAT (hidden): '))",
  ],
  { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" },
);
if (result.status !== 0) throw new Error("Token entry cancelled");
const token = result.stdout.trim();
if (!/^ghp_[A-Za-z0-9_]{20,200}$/.test(token))
  throw new Error("Expected a new classic PAT; token was not stored");
const response = await fetch("https://api.github.com/user", {
  headers: {
    authorization: `Bearer ${token}`,
    "User-Agent": "agent-platform-jenkins",
    Accept: "application/vnd.github+json",
  },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok)
  throw new Error(
    `GitHub validation failed (${response.status}); token was not stored`,
  );
const user = await response.json();
if (
  user.login !== "Xeonice" ||
  !(response.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((value) => value.trim())
    .includes("write:packages")
)
  throw new Error(
    "Expected Xeonice classic PAT with write:packages; token was not stored",
  );
const temporary = join(directory, `ghcr-token.${randomUUID()}.tmp`);
await fs.writeFile(temporary, token, { flag: "wx", mode: 0o600 });
await fs.rename(temporary, join(directory, "ghcr-token"));
console.log(
  JSON.stringify({
    state: "private-ghcr-credential-validated",
    login: user.login,
    packagesWrite: true,
    file: join(directory, "ghcr-token"),
  }),
);
