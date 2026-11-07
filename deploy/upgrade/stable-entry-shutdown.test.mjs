import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStableEntry } from "./stable-entry.mjs";

// Actual TCP/HTTP/SSE peers verify transport retirement. The backend is a small
// contract receiver, not an SDK, business database or Native upgrade witness.
for (const kind of ["api", "web"])
  test(
    "explicit entry close releases a long " +
      kind +
      " SSE without stopping its backend",
    async (t) => {
      const root = await fs.realpath(
        await fs.mkdtemp(join(tmpdir(), "entry-sse-close-")),
      );
      let streamClosed = false,
        runtimeStops = 0;
      const requests = [];
      const backend = http.createServer((req, res) => {
        requests.push(req.method + " " + req.url);
        if (req.method !== "GET") runtimeStops++;
        if (req.url === "/api/health") {
          res.end("backend-live");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        res.write("data: original-peer\n\n");
        const timer = setInterval(() => res.write(": still-live\n\n"), 20);
        res.once("close", () => {
          clearInterval(timer);
          streamClosed = true;
        });
      });
      await new Promise((r) => backend.listen(0, "127.0.0.1", r));
      const origin = "http://127.0.0.1:" + backend.address().port,
        d = "sha256:" + "a".repeat(64),
        w = "sha256:" + "b".repeat(64);
      const entry = await createStableEntry({
        root: join(root, "entry"),
        instanceId: "sse-case",
        controlKey: "c".repeat(32),
        stickyKey: "s".repeat(32),
        verifyFence: async () => {},
        initialBinding: {
          instanceId: "sse-case",
          attemptId: "initial",
          fence: 1,
          routeGeneration: 1,
          weight: 0,
          oldApi: { origin, digest: d },
          candidateApi: null,
          web: { origin, root, digest: w, treeDigest: w },
          retainedWeb: [],
        },
      });
      t.after(async () => {
        await entry.close();
        backend.closeAllConnections();
        await new Promise((r) => backend.close(r));
        await fs.rm(root, { recursive: true, force: true });
      });
      const response = await fetch(
        entry.origin + (kind === "api" ? "/api/events" : "/live-web-stream"),
      );
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /original-peer/,
      );
      const started = Date.now();
      await entry.close();
      assert.ok(
        Date.now() - started < 1000,
        "only owned transports should close promptly",
      );
      assert.equal(entry.server.listening, false);
      assert.equal(entry.control.listening, false);
      const deadline = Date.now() + 1000;
      while (!streamClosed && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        streamClosed,
        true,
        "corresponding upstream SSE response also closes",
      );
      assert.equal(
        await (await fetch(origin + "/api/health")).text(),
        "backend-live",
      );
      assert.equal(backend.listening, true);
      assert.equal(runtimeStops, 0);
      assert.ok(requests.every((x) => x.startsWith("GET ")));
      await entry.close();
    },
  );
