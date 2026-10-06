import { spawnSync } from "node:child_process";

// Generated launchd XML is public fixture data. macOS exercises its real
// plutil; Linux exercises Python's standard plist parser, preserving types.
function convert(input, format) {
  const result =
    process.platform === "darwin"
      ? spawnSync(
          "/usr/bin/plutil",
          [
            "-convert",
            format === "json" ? "json" : "xml1",
            "-o",
            "-",
            "--",
            "-",
          ],
          { input, encoding: "utf8", cwd: "/", timeout: 10000 },
        )
      : spawnSync(
          "/usr/bin/python3",
          [
            "-c",
            format === "json"
              ? "import json,plistlib,sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"
              : "import json,plistlib,sys; plistlib.dump(json.load(sys.stdin),sys.stdout.buffer,sort_keys=False)",
          ],
          { input, encoding: "utf8", cwd: "/", timeout: 10000 },
        );
  if (result.status !== 0 || result.error || result.signal)
    throw new Error("Generated plist fixture conversion failed");
  return result.stdout;
}

export const parsePlistFixture = (xml) => JSON.parse(convert(xml, "json"));
export const serializePlistFixture = (value) =>
  convert(JSON.stringify(value), "xml");
