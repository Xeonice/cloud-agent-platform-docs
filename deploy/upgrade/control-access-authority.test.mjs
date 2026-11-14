import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHmac, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControlAccessAuthority,
  createControlAccessHttpHandler,
} from "./control-access-authority.mjs";
import { digest } from "./trust.mjs";
const require = createRequire(
    new URL("../../api/package.json", import.meta.url),
  ),
  Database = require("better-sqlite3");
const TTL = 604800000,
  INSTANCE = "fixture-access-instance",
  SESSION = "fixture-original-cookie-secret",
  UPGRADE = Buffer.alloc(32, 17),
  PLAIN = "fixture-original-passcode";
const salt = Buffer.alloc(16, 9),
  HASH = [
    "scrypt",
    32768,
    8,
    1,
    salt.toString("base64"),
    scryptSync(PLAIN, salt, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }).toString("base64"),
  ].join("$");
function request(extra = {}) {
  return { remoteAddress: "198.51.100.2", clientIp: "198.51.100.2", ...extra };
}
function legacyToken(now, secret = SESSION) {
  const exp = String(now + TTL);
  return exp + "." + createHmac("sha256", secret).update(exp).digest("hex");
}
async function fixture(
  t,
  { clock = () => 1000000000, input = {}, ...options } = {},
) {
  const sqlite = new Database(":memory:");
  t.after(() => sqlite.close());
  const authority = createControlAccessAuthority({
    sqlite,
    instanceId: INSTANCE,
    clock,
    envPasscode: "",
    sessionSecretOverride: "",
    ...options,
  });
  await authority.importState({
    source: "stored",
    passcodeHash: HASH,
    sessionSecret: SESSION,
    upgradeSessionSecretBase64: UPGRADE.toString("base64"),
    updatedAt: clock(),
    ...input,
  });
  return { authority, sqlite, clock };
}
function authenticated(authority, extra = {}) {
  return request({
    cookie: `ap_session=${authority.issueSessionToken()}`,
    ...extra,
  });
}

test("imports original scrypt/HMAC format; seven day expiry and file restart preserve existing cookie", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "control-access-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "control.db");
  let now = 1000000000,
    sqlite = new Database(file);
  let authority = createControlAccessAuthority({
    sqlite,
    instanceId: INSTANCE,
    clock: () => now,
    envPasscode: "",
    sessionSecretOverride: "",
  });
  await authority.importState({
    source: "stored",
    passcodeHash: HASH,
    sessionSecret: SESSION,
    upgradeSessionSecretBase64: UPGRADE.toString("base64"),
  });
  const token = legacyToken(now);
  assert.equal(authority.issueSessionToken(), token);
  assert.equal(
    (await authority.evaluate(request({ passcode: PLAIN }))).authorized,
    true,
  );
  sqlite.close();
  sqlite = new Database(file);
  t.after(() => sqlite.close());
  authority = createControlAccessAuthority({
    sqlite,
    instanceId: INSTANCE,
    clock: () => now,
    envPasscode: "",
    sessionSecretOverride: "",
  });
  assert.equal(
    (await authority.evaluate(request({ cookie: `ap_session=${token}` })))
      .authorized,
    true,
  );
  now += TTL;
  assert.equal(authority.verifySessionToken(token), false);
  assert.deepEqual(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((x) => x.name),
    ["control_access"],
  );
});
test("env has priority, is immutable and leaves original stored hash available after removal", async (t) => {
  const { authority, sqlite, clock } = await fixture(t, {
    envPasscode: "fixture-env",
  });
  assert.equal(authority.status().source, "env");
  assert.equal(
    (await authority.evaluate(request({ passcode: PLAIN }))).authorized,
    false,
  );
  assert.equal(
    (await authority.evaluate(request({ passcode: "fixture-env" }))).authorized,
    true,
  );
  const before = sqlite.prepare("SELECT * FROM control_access").get();
  await assert.rejects(
    authority.change({ request: authenticated(authority), action: "disable" }),
    { code: "INVALID_STATE" },
  );
  assert.deepEqual(
    sqlite.prepare("SELECT * FROM control_access").get(),
    before,
  );
  const restarted = createControlAccessAuthority({
    sqlite,
    instanceId: INSTANCE,
    clock,
    envPasscode: "",
    sessionSecretOverride: "",
  });
  assert.equal(restarted.status().source, "stored");
  assert.equal(
    (await restarted.evaluate(request({ passcode: PLAIN }))).authorized,
    true,
  );
});
test('independent Agent retains ENV priority and pinned cookies across file restart without plaintext ENV or Supervisor access', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'control-access-retained-env-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'access.db'), now = 1000000000;
  let sqlite = new Database(file), authority = createControlAccessAuthority({ sqlite, instanceId: INSTANCE, clock: () => now, envPasscode: '', sessionSecretOverride: '', retainEnvironment: true });
  await authority.importState({ source: 'env', envPasscode: 'fixture-private-original-env', storedPasscodeHash: HASH, sessionSecret: SESSION, secretPinned: true });
  const token = authority.issueSessionToken();
  assert.equal((await authority.evaluate(request({ passcode: 'fixture-private-original-env' }))).authorized, true);
  sqlite.close(); sqlite = new Database(file); t.after(() => sqlite.close());
  authority = createControlAccessAuthority({ sqlite, instanceId: INSTANCE, clock: () => now, envPasscode: '', sessionSecretOverride: '', retainEnvironment: true });
  assert.equal(authority.status().source, 'env'); assert.equal(authority.status().sessionSecretPinned, true);
  assert.equal((await authority.evaluate(request({ passcode: 'fixture-private-original-env' }))).authorized, true);
  assert.equal((await authority.evaluate(request({ passcode: PLAIN }))).authorized, false);
  assert.equal(authority.verifySessionToken(token), true);
  assert.equal(sqlite.prepare('SELECT passcode_hash FROM control_access').get().passcode_hash, HASH);
  const verifier = sqlite.prepare('SELECT * FROM control_access_environment').get();
  assert.match(verifier.passcode_hash, /^scrypt\$/); assert.equal(JSON.stringify(verifier).includes('fixture-private-original-env'), false);
  await assert.rejects(authority.change({ request: authenticated(authority), action: 'disable' }), { code: 'INVALID_STATE' });
});
test("ordinary regeneration preserves old browser; explicit revoke alone rotates; all legal enable/disable branches", async (t) => {
  const { authority } = await fixture(t);
  const old = authority.issueSessionToken(),
    auth = request({ cookie: `ap_session=${old}` });
  await assert.rejects(authority.change({ request: auth, action: "enable" }), {
    code: "INVALID_STATE",
  });
  await assert.rejects(
    authority.change({
      request: auth,
      action: "disable",
      invalidateSessions: true,
    }),
    { code: "INVALID_STATE" },
  );
  const changed = await authority.change({
    request: auth,
    action: "regenerate",
  });
  assert.equal(changed.result.passcode.length, 16);
  assert.equal(authority.verifySessionToken(old), true);
  assert.equal(
    (await authority.evaluate(request({ passcode: PLAIN }))).authorized,
    false,
  );
  assert.equal(
    (await authority.evaluate(request({ passcode: changed.result.passcode })))
      .authorized,
    true,
  );
  const revoked = await authority.change({
    request: auth,
    action: "regenerate",
    invalidateSessions: true,
  });
  assert.equal(authority.verifySessionToken(old), false);
  assert.equal(authority.verifySessionToken(revoked.sessionToken), true);
  const next = request({ cookie: `ap_session=${revoked.sessionToken}` });
  assert.equal(
    (await authority.change({ request: next, action: "disable" })).changed,
    true,
  );
  const revision = authority.status().revision;
  assert.equal(
    (await authority.change({ request: request(), action: "disable" })).changed,
    false,
  );
  assert.equal(authority.status().revision, revision);
  await assert.rejects(
    authority.change({ request: request(), action: "regenerate" }),
    { code: "INVALID_STATE" },
  );
  assert.equal(
    (await authority.change({ request: request(), action: "enable" })).result
      .enabled,
    true,
  );
});
test("pinned session secret refuses revocation without changing policy", async (t) => {
  const { authority } = await fixture(t, {
      sessionSecretOverride: "fixture-pinned-cookie-secret",
    }),
    before = authority.status();
  await assert.rejects(
    authority.change({
      request: authenticated(authority),
      action: "regenerate",
      invalidateSessions: true,
    }),
    { code: "INVALID_STATE" },
  );
  assert.deepEqual(authority.status(), before);
  assert.equal(authority.status().sessionSecretPinned, true);
});
test("HTTP/unlock share exactly five failures and five minute lock; valid cookie bypasses lock", async (t) => {
  let now = 1000000000;
  const { authority } = await fixture(t, { clock: () => now });
  for (let i = 0; i < 12; i++)
    assert.equal(
      (await authority.evaluate(request())).failure.kind,
      "required",
    );
  for (let i = 1; i <= 5; i++) {
    const value = await authority.evaluate(
      request({ passcode: "wrong" }),
      i % 2 ? "http" : "unlock",
    );
    assert.equal(value.failure.kind, "invalid");
    assert.equal(value.failure.consecutiveFailures, i);
    assert.equal(value.failure.lockedForSec, i === 5 ? 300 : 0);
  }
  assert.equal(
    (await authority.evaluate(request({ passcode: PLAIN }))).failure.kind,
    "locked",
  );
  assert.equal(
    (await authority.evaluate(authenticated(authority))).authorized,
    true,
  );
  assert.equal(
    (
      await authority.evaluate(
        authenticated(authority, { passcode: PLAIN }),
        "unlock",
      )
    ).failure.kind,
    "locked",
  );
  now += 300000;
  assert.equal(
    (await authority.evaluate(request({ passcode: PLAIN }), "unlock"))
      .authorized,
    true,
  );
  assert.equal(
    (await authority.evaluate(request({ passcode: "wrong" }))).failure
      .consecutiveFailures,
    1,
  );
});
test("bounded clients and async KDF reject overload; existing valid cookie still works", async (t) => {
  const { authority } = await fixture(t, {
    maxClients: 1,
    maxKdfConcurrency: 1,
  });
  let settled = false;
  const checking = authority
    .evaluate(request({ passcode: "wrong" }))
    .finally(() => {
      settled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    settled,
    false,
    "event loop must run before the expensive KDF completes",
  );
  await assert.rejects(
    authority.evaluate(request({ clientIp: "198.51.100.3", passcode: PLAIN })),
    { code: "CONTROL_ACCESS_BUSY" },
  );
  await checking;
  await assert.rejects(
    authority.evaluate(request({ clientIp: "198.51.100.3", passcode: PLAIN })),
    { code: "CONTROL_ACCESS_BUSY" },
  );
  assert.equal(
    (
      await authority.evaluate(
        authenticated(authority, { clientIp: "198.51.100.3" }),
      )
    ).authorized,
    true,
  );
});
test("KDF concurrency is bounded independently of per-client slots", async (t) => {
  const { authority } = await fixture(t, { maxKdfConcurrency: 1 });
  const pending = authority.evaluate(request({ passcode: PLAIN }));
  await assert.rejects(
    authority.evaluate(request({ clientIp: "198.51.100.3", passcode: PLAIN })),
    { code: "CONTROL_ACCESS_BUSY" },
  );
  assert.equal((await pending).authorized, true);
});
test("concurrent policy writes are CAS guarded; failed/unknown RPC cannot mint a later session", async (t) => {
  const { authority } = await fixture(t),
    auth = authenticated(authority),
    before = authority.status().revision;
  const first = authority.change({
    request: auth,
    action: "regenerate",
    invalidateSessions: true,
  });
  await assert.rejects(
    authority.change({ request: auth, action: "regenerate" }),
    { code: "CONTROL_ACCESS_BUSY" },
  );
  const result = await first;
  assert.equal(result.status.revision, before + 1);
  await assert.rejects(authority.change({ request: auth, action: "disable" }), {
    code: "PASSCODE_REQUIRED",
  });
  await assert.rejects(
    authority.change({
      request: request({ cookie: `ap_session=${result.sessionToken}` }),
      action: "regenerate",
      expectedRevision: before,
    }),
    { code: "CONTROL_ACCESS_POLICY_CHANGED" },
  );
});
test("in-flight scrypt auth rechecks policy after an independent disable", async (t) => {
  const { authority } = await fixture(t),
    pending = authority.evaluate(request({ passcode: PLAIN }));
  await authority.change({
    request: authenticated(authority),
    action: "disable",
  });
  await assert.rejects(pending, { code: "CONTROL_ACCESS_POLICY_CHANGED" });
});
test("continuity fingerprint/challenge preserve original upgrade and cookie algorithms without exposing secrets", async (t) => {
  const legacy = "fixture-legacy-key-at-least-thirty-two-bytes",
    { authority } = await fixture(t, {
      input: { legacyContinuityKey: legacy },
    });
  const hmac = (s) => createHmac("sha256", UPGRADE).update(s).digest("hex");
  assert.equal(
    authority.fingerprint().fingerprint,
    digest({
      upgrade: hmac(`session-continuity:${INSTANCE}`),
      access: legacyToken(0),
    }),
  );
  assert.equal(
    authority.fingerprint().legacyFingerprint,
    digest({
      upgrade: hmac(`session-continuity:${INSTANCE}:${legacy}`),
      access: legacyToken(0),
    }),
  );
  const proof = authority.challenge({ legacyBaseline: true }),
    value = await authority.evaluate(request({ cookie: proof.cookie }));
  assert.equal(value.authorized, true);
  assert.equal(value.principal.userScope, proof.userScope);
  assert.equal(value.viewerCookie, undefined);
  assert.equal(proof.legacy, true);
  const safe = JSON.stringify({
    status: authority.status(),
    fingerprint: authority.fingerprint(),
  });
  for (const secret of [
    SESSION,
    PLAIN,
    HASH,
    UPGRADE.toString("base64"),
    legacy,
  ])
    assert.equal(safe.includes(secret), false);
});
test("unknown/malformed state and oversized input fail closed", async (t) => {
  const { authority, sqlite } = await fixture(t);
  await assert.rejects(
    authority.evaluate(request({ passcode: "x".repeat(1025) })),
    { code: "CONTROL_ACCESS_REQUEST_INVALID" },
  );
  await assert.rejects(
    authority.evaluate(
      request({ clientIp: "invented-browser-forwarded-host" }),
    ),
    { code: "CONTROL_ACCESS_REQUEST_INVALID" },
  );
  await assert.rejects(
    authority.importState({ source: "none", sessionSecret: SESSION }),
    /CONTROL_ACCESS_ALREADY_IMPORTED/,
  );
  sqlite.prepare("UPDATE control_access SET passcode_hash='corrupt'").run();
  assert.equal(
    (await authority.evaluate(request({ passcode: PLAIN }))).authorized,
    false,
  );
  sqlite.prepare("UPDATE control_access SET instance_id='other'").run();
  await assert.rejects(
    authority.evaluate(request()),
    /CONTROL_ACCESS_STATE_UNKNOWN/,
  );
});
test("fixed private RPC authenticates instance/key, rejects extra fields and uses real cookie authority", async (t) => {
  const { authority } = await fixture(t),
    key = "fixture-controller-key-32-characters-long",
    handler = createControlAccessHttpHandler({
      authority,
      instanceId: INSTANCE,
      key,
    });
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (action, body = {}, headers = {}) =>
    fetch(origin + "/internal/control/access/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-platform-internal-key": key,
        "x-platform-instance-id": INSTANCE,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await call("status", {}, { "x-platform-internal-key": "wrong" })).status,
    403,
  );
  assert.equal(
    (await call("status", {}, { "x-platform-instance-id": "other" })).status,
    403,
  );
  assert.equal((await call("status", { unknown: true })).status, 400);
  assert.equal(
    (await call("status", { padding: "x".repeat(17000) })).status,
    413,
  );
  assert.equal((await call("status?query=1")).status, 403);
  assert.equal((await call("arbitrary")).status, 404);
  const status = await (await call("status")).json();
  assert.equal(status.source, "stored");
  const auth = await (
    await call("authenticate", {
      mode: "http",
      request: authenticated(authority),
    })
  ).json();
  assert.equal(auth.authorized, true);
  assert.equal(auth.policyRevision, status.revision);
  assert.equal(auth.principal.canUpgrade, true);
});
