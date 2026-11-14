/** Host IP entry only: preserve HTTP/WebSocket bytes and forward to Linux Entry.
 * Usage: node ip-entry-bridge.mjs --config /absolute/private.json
 * No access credentials, HTTP forwarding headers, or business data are read here.
 */
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const KEYS = [
  "schemaVersion",
  "listenHost",
  "listenPort",
  "targetHost",
  "targetPort",
  "expectedInstanceId",
];
const CODES = new Set([
  "IP_ENTRY_CONFIG_INVALID",
  "IP_ENTRY_CONFIG_UNSAFE",
  "IP_ENTRY_TARGET_UNAVAILABLE",
  "IP_ENTRY_INSTANCE_MISMATCH",
  "IP_ENTRY_ABORTED",
  "IP_ENTRY_LISTEN_FAILED",
  "IP_ENTRY_RUNTIME_FAILED",
]);
function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function aborted(signal) {
  if (signal?.aborted) throw failure("IP_ENTRY_ABORTED");
}

export function validateConfig(config) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).length !== KEYS.length ||
    !KEYS.every((key) => Object.hasOwn(config, key)) ||
    config.schemaVersion !== 1 ||
    config.listenHost !== "0.0.0.0" ||
    config.targetHost !== "127.0.0.1" ||
    !(
      (config.listenPort === 3000 && config.targetPort === 3181) ||
      (config.listenPort === 13000 && config.targetPort === 4181)
    ) ||
    typeof config.expectedInstanceId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(config.expectedInstanceId)
  ) {
    throw failure("IP_ENTRY_CONFIG_INVALID");
  }
  return Object.freeze({ ...config });
}

export async function readPrivateConfig(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /[\0\r\n]/.test(path)
  ) {
    throw failure("IP_ENTRY_CONFIG_UNSAFE");
  }
  let handle;
  try {
    const before = await fs.lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (before.mode & 0o7777) !== 0o600 ||
      ![0, process.getuid()].includes(before.uid) ||
      before.size > 16_384 ||
      (await fs.realpath(path)) !== path
    ) {
      throw failure("IP_ENTRY_CONFIG_UNSAFE");
    }
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    const after = await fs.lstat(path);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !opened.isFile() ||
      (opened.mode & 0o7777) !== 0o600 ||
      ![0, process.getuid()].includes(opened.uid) ||
      opened.size > 16_384 ||
      (await fs.realpath(path)) !== path
    ) {
      throw failure("IP_ENTRY_CONFIG_UNSAFE");
    }
    // Bound the actual read too, even if the file grows after stat.
    const bytes = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16_384) throw failure("IP_ENTRY_CONFIG_INVALID");
    let config;
    try {
      config = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw failure("IP_ENTRY_CONFIG_INVALID");
    }
    return validateConfig(config);
  } catch (error) {
    throw CODES.has(error?.code) ? error : failure("IP_ENTRY_CONFIG_UNSAFE");
  } finally {
    await handle?.close();
  }
}

function requestJson(target, path, { timeoutMs, signal }) {
  return new Promise((resolveRequest, reject) => {
    let settled = false;
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        request?.destroy();
        reject(error);
      } else resolveRequest(value);
    };
    const onAbort = () => finish(failure("IP_ENTRY_ABORTED"));
    const timer = setTimeout(
      () => finish(failure("IP_ENTRY_TARGET_UNAVAILABLE")),
      timeoutMs,
    );
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    request = http.get(
      {
        hostname: target.targetHost,
        port: target.targetPort,
        path,
        agent: false,
        headers: { Connection: "close" },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          finish(failure("IP_ENTRY_TARGET_UNAVAILABLE"));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16_384) {
            response.destroy();
            finish(failure("IP_ENTRY_TARGET_UNAVAILABLE"));
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          finish(failure("IP_ENTRY_TARGET_UNAVAILABLE")),
        );
        response.on("end", () => {
          if (path !== "/web-process") return finish(null, null);
          try {
            finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            finish(failure("IP_ENTRY_TARGET_UNAVAILABLE"));
          }
        });
      },
    );
    request.on("error", () => finish(failure("IP_ENTRY_TARGET_UNAVAILABLE")));
  });
}

/** Exported for real HTTP tests; production calls this with validated config. */
export async function probeTarget(config, { timeoutMs = 2000, signal } = {}) {
  aborted(signal);
  const identity = await requestJson(config, "/web-process", {
    timeoutMs,
    signal,
  });
  if (identity?.instanceId !== config.expectedInstanceId) {
    throw failure("IP_ENTRY_INSTANCE_MISMATCH");
  }
  await requestJson(config, "/api/health", { timeoutMs, signal });
}

function delay(ms, signal) {
  return new Promise((resolveDelay, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };
    const stop = () => {
      done();
      reject(failure("IP_ENTRY_ABORTED"));
    };
    const timer = setTimeout(() => {
      done();
      resolveDelay();
    }, ms);
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export async function waitForTarget(
  config,
  {
    deadlineMs = 120_000,
    intervalMs = 1000,
    requestTimeoutMs = 2000,
    signal,
  } = {},
) {
  const deadline = performance.now() + deadlineMs;
  let last = failure("IP_ENTRY_TARGET_UNAVAILABLE");
  while (performance.now() < deadline) {
    aborted(signal);
    try {
      const remaining = deadline - performance.now();
      // Two sequential requests share the same overall startup deadline.
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, remaining));
      try {
        await probeTarget(config, {
          timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remaining)),
          signal: controller.signal,
        });
        aborted(signal);
        return;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    } catch (error) {
      aborted(signal);
      last =
        error.code === "IP_ENTRY_INSTANCE_MISMATCH"
          ? error
          : failure("IP_ENTRY_TARGET_UNAVAILABLE");
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(intervalMs, remaining), signal);
  }
  throw last;
}

/** Testable raw TCP relay. This helper allows ephemeral ports; the CLI does not. */
export async function createByteBridge(
  config,
  { connectTimeoutMs = 2000, onError = () => {} } = {},
) {
  const sockets = new Set();
  let stopping = false;
  let closePromise;
  const server = net.createServer({ allowHalfOpen: true }, (incoming) => {
    if (stopping) return incoming.destroy();
    const outgoing = net.createConnection({
      host: config.targetHost,
      port: config.targetPort,
      allowHalfOpen: true,
    });
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    const destroyPair = () => {
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.on("error", destroyPair);
    outgoing.on("error", destroyPair);
    // Normal EOF is handled by pipe().end(), which must be allowed to flush
    // the peer's buffered tail. Destroy only an abnormal close without EOF.
    incoming.on("close", () => {
      if (!incoming.readableEnded) outgoing.destroy();
    });
    outgoing.on("close", () => {
      if (!outgoing.readableEnded) incoming.destroy();
    });
    outgoing.setTimeout(connectTimeoutMs, destroyPair);
    outgoing.once("connect", () => outgoing.setTimeout(0));
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
  });
  await new Promise((resolveListen, reject) => {
    const failed = () => reject(failure("IP_ENTRY_LISTEN_FAILED"));
    server.once("error", failed);
    server.listen(config.listenPort, config.listenHost, () => {
      server.removeListener("error", failed);
      server.on("error", () => onError("IP_ENTRY_RUNTIME_FAILED"));
      resolveListen();
    });
  });
  return {
    address: server.address(),
    close({ graceMs = 15_000 } = {}) {
      if (closePromise) return closePromise;
      stopping = true;
      closePromise = new Promise((resolveClose) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, graceMs);
        server.close(() => {
          clearTimeout(timer);
          resolveClose();
        });
      });
      return closePromise;
    },
  };
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config") {
    throw failure("IP_ENTRY_CONFIG_INVALID");
  }
  const controller = new AbortController();
  let bridge;
  let stopping;
  let stopped;
  const signalReceived = new Promise((resolveStop) => {
    stopped = resolveStop;
  });
  const stop = () => {
    controller.abort();
    stopping ??= bridge?.close();
    stopped();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const config = await readPrivateConfig(args[1]);
    await waitForTarget(config, { signal: controller.signal });
    aborted(controller.signal);
    bridge = await createByteBridge(config, {
      onError: (code) => {
        process.stderr.write(`${code}\n`);
        process.exitCode = 1;
        stop();
      },
    });
    if (controller.signal.aborted) await bridge.close();
    else {
      process.stdout.write("IP_ENTRY_READY\n");
      await signalReceived;
      await stopping;
    }
  } catch (error) {
    if (error.code !== "IP_ENTRY_ABORTED") throw error;
  } finally {
    if (controller.signal.aborted) {
      await stopping;
      process.stdout.write("IP_ENTRY_STOPPED\n");
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  cli().catch((error) => {
    process.stderr.write(
      `${CODES.has(error?.code) ? error.code : "IP_ENTRY_RUNTIME_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
