import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const forbidden = [
  /\.route\s*\(/,
  /\.routeWebSocket\s*\(/,
  /\.routeFromHAR\s*\(/,
];
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? walk(path)
      : entry.name.endsWith(".ts")
        ? [path]
        : [];
  });
}
export default function globalSetup() {
  const offenders: string[] = [];
  for (const file of walk(join(here, "acceptance"))) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (forbidden.some((pattern) => pattern.test(line)))
          offenders.push(`${file}:${index + 1}`);
      });
  }
  if (offenders.length)
    throw new Error(
      `Cross-repository acceptance cannot intercept browser requests: ${offenders.join(", ")}`,
    );
}
