import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  validateConfig,
  readPrivateConfig,
  probeTarget,
  waitForTarget,
  createByteBridge,
} from "./ip-entry-bridge.mjs";

const config = {
  schemaVersion: 1,
  listenHost: "0.0.0.0",
  listenPort: 3000,
  targetHost: "127.0.0.1",
  targetPort: 3181,
  expectedInstanceId: "iflytek-linux-20261017",
};
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
const targetConfig = (port) => ({ ...config, targetPort: port });
async function fixture(t) {
  const path = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "ip-entry-"));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  const file = join(path, "private.json");
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  return { path, file };
}

test("production config allows only the two pinned loopback Entry mappings", () => {
  assert.deepEqual(validateConfig(config), config);
  assert.equal(Object.isFrozen(validateConfig(config)), true);
  assert.equal(
    validateConfig({ ...config, listenPort: 13000, targetPort: 4181 })
      .targetPort,
    4181,
  );
  for (const change of [
    { listenHost: "127.0.0.1" },
    { targetHost: "localhost" },
    { targetHost: "100.73.71.22" },
    { listenPort: 0 },
    { targetPort: 3001 },
    { targetPort: 4181 },
    { schemaVersion: 2 },
    { expectedInstanceId: "" },
    { expectedInstanceId: "a\r\nCookie: secret" },
    { accessPasscode: "must-never-be-consumed" },
  ]) {
    assert.throws(() => validateConfig({ ...config, ...change }), {
      code: "IP_ENTRY_CONFIG_INVALID",
    });
  }
});

test("private config requires a canonical regular 0600 file, never symlinks", async (t) => {
  const { path, file } = await fixture(t);
  assert.deepEqual(await readPrivateConfig(file), config);
  await fs.chmod(file, 0o644);
  await assert.rejects(readPrivateConfig(file), {
    code: "IP_ENTRY_CONFIG_UNSAFE",
  });
  await fs.chmod(file, 0o600);
  await fs.symlink(file, join(path, "link.json"));
  await assert.rejects(readPrivateConfig(join(path, "link.json")), {
    code: "IP_ENTRY_CONFIG_UNSAFE",
  });
  await fs.symlink(path, join(path, "alias"));
  await assert.rejects(readPrivateConfig(join(path, "alias/private.json")), {
    code: "IP_ENTRY_CONFIG_UNSAFE",
  });
  for (const badPath of ["private.json", `${path}/../private.json`, path]) {
    await assert.rejects(readPrivateConfig(badPath), {
      code: "IP_ENTRY_CONFIG_UNSAFE",
    });
  }
});

test("invalid/oversized config fails with a fixed code; CLI never echoes private content or path", async (t) => {
  const { file } = await fixture(t);
  const secret = "EXAMPLE_PRIVATE_PAYLOAD_NEVER_LOG";
  await fs.writeFile(file, secret);
  await assert.rejects(readPrivateConfig(file), {
    code: "IP_ENTRY_CONFIG_INVALID",
  });
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./ip-entry-bridge.mjs", import.meta.url)),
      "--config",
      file,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "IP_ENTRY_CONFIG_INVALID\n");
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stderr.includes(file), false);
  await fs.writeFile(file, " ".repeat(16_385));
  await assert.rejects(readPrivateConfig(file), {
    code: "IP_ENTRY_CONFIG_UNSAFE",
  });
});

test("real HTTP startup probe checks exact instance, health 200, no credentials or redirects", async (t) => {
  const seen = [];
  let instanceId = config.expectedInstanceId;
  let health = 200;
  const server = http.createServer((request, response) => {
    seen.push({ path: request.url, headers: request.headers });
    if (request.url === "/web-process") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ instanceId }));
    } else {
      response.writeHead(health, { Location: "/somewhere-else" });
      response.end("healthy");
    }
  });
  const port = await listen(server);
  t.after(() => close(server));
  await probeTarget(targetConfig(port));
  assert.deepEqual(
    seen.map((request) => request.path),
    ["/web-process", "/api/health"],
  );
  for (const request of seen) {
    assert.deepEqual(Object.keys(request.headers).sort(), [
      "connection",
      "host",
    ]);
  }
  instanceId = "wrong-instance";
  seen.length = 0;
  await assert.rejects(probeTarget(targetConfig(port)), {
    code: "IP_ENTRY_INSTANCE_MISMATCH",
  });
  assert.deepEqual(
    seen.map((request) => request.path),
    ["/web-process"],
  );
  instanceId = config.expectedInstanceId;
  for (health of [302, 401, 503]) {
    await assert.rejects(probeTarget(targetConfig(port)), {
      code: "IP_ENTRY_TARGET_UNAVAILABLE",
    });
  }
});

test("wrong instance is retried until the expected Entry becomes healthy", async (t) => {
  let attempts = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/web-process") {
      attempts++;
      response.end(
        JSON.stringify({
          instanceId: attempts < 3 ? "old-instance" : config.expectedInstanceId,
        }),
      );
    } else response.end("ok");
  });
  const port = await listen(server);
  t.after(() => close(server));
  await waitForTarget(targetConfig(port), {
    deadlineMs: 1000,
    intervalMs: 5,
    requestTimeoutMs: 100,
  });
  assert.equal(attempts, 3);
});

test("startup has a finite deadline for mismatches and stalled HTTP; cancellation is prompt", async (t) => {
  let stall = false;
  const server = http.createServer((request, response) => {
    if (!stall) response.end(JSON.stringify({ instanceId: "wrong-instance" }));
  });
  const port = await listen(server);
  t.after(() => close(server));
  const options = { deadlineMs: 60, intervalMs: 5, requestTimeoutMs: 1000 };
  // An observed wrong identity is always rejected explicitly. At the overall
  // retry deadline, the final request may instead be aborted before its reply.
  await assert.rejects(probeTarget(targetConfig(port)), {
    code: "IP_ENTRY_INSTANCE_MISMATCH",
  });
  const mismatchStarted = performance.now();
  await assert.rejects(
    waitForTarget(targetConfig(port), options),
    (error) =>
      error.code === "IP_ENTRY_INSTANCE_MISMATCH" ||
      error.code === "IP_ENTRY_TARGET_UNAVAILABLE",
  );
  assert.ok(performance.now() - mismatchStarted < 500);
  stall = true;
  const started = performance.now();
  await assert.rejects(waitForTarget(targetConfig(port), options), {
    code: "IP_ENTRY_TARGET_UNAVAILABLE",
  });
  assert.ok(performance.now() - started < 500);
  const controller = new AbortController();
  const pending = waitForTarget(targetConfig(port), {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { code: "IP_ENTRY_ABORTED" });
});

test("raw TCP preserves bidirectional binary/header bytes and half-close tail responses", async (t) => {
  const request = Buffer.concat([
    Buffer.from(
      "GET /terminal HTTP/1.1\r\nUpgrade: websocket\r\nCookie: private-test\r\n\r\n",
    ),
    Buffer.from([0, 255, 128, 13, 10, 0]),
  ]);
  const response = Buffer.concat([
    Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
    Buffer.from([255, 0, 1, 128, 254]),
  ]);
  let received;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      received = Buffer.concat(chunks);
      socket.end(response);
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const bridge = await createByteBridge({
    ...targetConfig(port),
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  t.after(() => bridge.close({ graceMs: 20 }));
  const actual = await new Promise((resolve, reject) => {
    const client = net.connect(bridge.address.port, "127.0.0.1");
    const chunks = [];
    client.on("error", reject);
    client.on("data", (chunk) => chunks.push(chunk));
    client.on("end", () => resolve(Buffer.concat(chunks)));
    client.once("connect", () => client.end(request));
  });
  assert.deepEqual(received, request);
  assert.deepEqual(actual, response);
});

test("shutdown immediately stops admission, permits bounded drain, then closes only relay sockets", async (t) => {
  const upstream = new Set();
  const server = net.createServer((socket) => {
    upstream.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => upstream.delete(socket));
    socket.on("data", (bytes) => socket.write(bytes));
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of upstream) socket.destroy();
    await close(server);
  });
  const bridge = await createByteBridge({
    ...targetConfig(port),
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  t.after(() => bridge.close({ graceMs: 0 }));
  const client = net.connect(bridge.address.port, "127.0.0.1");
  client.on("error", () => {});
  t.after(() => client.destroy());
  await new Promise((resolve) => client.once("connect", resolve));
  const echoed = new Promise((resolve) => client.once("data", resolve));
  client.write(Buffer.from([0, 255, 10]));
  assert.deepEqual(await echoed, Buffer.from([0, 255, 10]));
  const ended = new Promise((resolve) => client.once("close", resolve));
  const started = performance.now();
  const closing = bridge.close({ graceMs: 80 });
  assert.equal(bridge.close(), closing);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const refused = net.connect(bridge.address.port, "127.0.0.1");
      refused.once("error", reject);
      refused.once("connect", () => {
        refused.destroy();
        resolve();
      });
    }),
  );
  assert.equal(client.destroyed, false);
  const drainingEcho = new Promise((resolve) => client.once("data", resolve));
  client.write(Buffer.from("still-draining"));
  assert.deepEqual(await drainingEcho, Buffer.from("still-draining"));
  await closing;
  await ended;
  assert.ok(performance.now() - started >= 60);
  // The upstream listener is independent of this bridge and remains usable.
  const direct = net.connect(port, "127.0.0.1");
  direct.on("error", () => {});
  await new Promise((resolve) => direct.once("connect", resolve));
  direct.destroy();
});

test("target connection errors close the accepted pair; occupied listen ports fail with a fixed code", async (t) => {
  const occupied = net.createServer();
  const occupiedPort = await listen(occupied);
  t.after(() => close(occupied));
  await assert.rejects(
    createByteBridge({
      ...targetConfig(occupiedPort),
      listenHost: "127.0.0.1",
      listenPort: occupiedPort,
    }),
    { code: "IP_ENTRY_LISTEN_FAILED" },
  );
  const released = net.createServer();
  const unusedPort = await listen(released);
  await close(released);
  const bridge = await createByteBridge({
    ...targetConfig(unusedPort),
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  t.after(() => bridge.close({ graceMs: 0 }));
  await new Promise((resolve) => {
    const client = net.connect(bridge.address.port, "127.0.0.1");
    client.on("error", () => {});
    client.once("close", resolve);
  });
});

test("normal upstream EOF preserves a large buffered tail through a paused client", async (t) => {
  const payload = Buffer.alloc(4 * 1024 * 1024, 0xa6);
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    socket.on("data", () => {});
    socket.on("end", () => socket.end(payload));
  });
  const port = await listen(server);
  t.after(() => close(server));
  const bridge = await createByteBridge({
    ...targetConfig(port),
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  t.after(() => bridge.close({ graceMs: 20 }));
  const actual = await new Promise((resolve, reject) => {
    const client = net.connect(bridge.address.port, "127.0.0.1");
    const chunks = [];
    client.on("error", reject);
    client.on("data", (chunk) => chunks.push(chunk));
    client.on("end", () => resolve(Buffer.concat(chunks)));
    client.on("connect", () => {
      client.pause();
      client.end("request-with-half-close");
      setTimeout(() => client.resume(), 80);
    });
  });
  assert.equal(actual.length, payload.length);
  assert.equal(
    createHash("sha256").update(actual).digest("hex"),
    createHash("sha256").update(payload).digest("hex"),
  );
});
