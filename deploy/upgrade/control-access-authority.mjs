import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { invariant, digest } from "./trust.mjs";
const derive = promisify(scrypt),
  TTL = 7 * 24 * 60 * 60 * 1000,
  LOCK_MS = 300000;
const MAX_BODY = 16384,
  ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const equal = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const object = (value) =>
  value && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, required, optional = []) =>
  object(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => [...required, ...optional].includes(key));
const error = (
  code,
  status = 409,
  message = "Access authority request rejected",
) => Object.assign(new Error(message), { code, status });
function cookie(raw, name) {
  for (const part of String(raw || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return undefined;
      }
    }
  }
}
function requestShape(value) {
  return (
    keys(value, ["remoteAddress", "clientIp"], ["cookie", "passcode"]) &&
    (value.remoteAddress === null ||
      (typeof value.remoteAddress === "string" &&
        value.remoteAddress.length <= 128 &&
        isIP(value.remoteAddress) !== 0)) &&
    (value.clientIp === "unknown" ||
      (typeof value.clientIp === "string" &&
        value.clientIp.length <= 128 &&
        isIP(value.clientIp) !== 0)) &&
    (value.cookie === undefined ||
      (typeof value.cookie === "string" &&
        Buffer.byteLength(value.cookie) <= 8192)) &&
    (value.passcode === undefined ||
      (typeof value.passcode === "string" &&
        Buffer.byteLength(value.passcode) <= 1024))
  );
}
function hashParts(hash) {
  if (typeof hash !== "string" || hash.length > 512) return null;
  const parts = hash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, n, r, p, salt, expected] = parts,
    N = Number(n),
    R = Number(r),
    P = Number(p),
    key = Buffer.from(expected, "base64"),
    saltBytes = Buffer.from(salt, "base64");
  if (
    !Number.isSafeInteger(N) ||
    N < 2 ||
    N > 65536 ||
    N & (N - 1) ||
    !Number.isSafeInteger(R) ||
    R < 1 ||
    R > 16 ||
    !Number.isSafeInteger(P) ||
    P < 1 ||
    P > 2 ||
    key.length !== 32 ||
    saltBytes.length !== 16
  )
    return null;
  return { N, r: R, p: P, key, salt: saltBytes };
}

/** Private authentication tables only. No platform.db, runtime SDK or cross-request auth cache. */
export function createControlAccessAuthority({
  sqlite,
  instanceId,
  clock = Date.now,
  allowLoopback = false,
  cookieSecure = false,
  envPasscode = process.env.ACCESS_PASSCODE || "",
  sessionSecretOverride = process.env.PASSCODE_COOKIE_SECRET || "",
  retainEnvironment = false,
  maxClients = 1024,
  maxKdfConcurrency = 2,
}) {
  invariant(
    sqlite &&
      ID.test(instanceId) &&
      typeof envPasscode === "string" &&
      Buffer.byteLength(envPasscode) <= 1024 &&
      typeof sessionSecretOverride === "string" &&
      sessionSecretOverride.length <= 4096 &&
      typeof retainEnvironment === 'boolean' &&
      Number.isInteger(maxClients) &&
      maxClients > 0 &&
      maxClients <= 65536 &&
      Number.isInteger(maxKdfConcurrency) &&
      maxKdfConcurrency > 0 &&
      maxKdfConcurrency <= 2,
    "CONTROL_ACCESS_CONFIG_REQUIRED",
  );
  sqlite.exec(`CREATE TABLE IF NOT EXISTS control_access (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance_id TEXT NOT NULL,
    source TEXT NOT NULL,passcode_hash TEXT,session_secret TEXT NOT NULL,secret_pinned INTEGER NOT NULL,
    revision INTEGER NOT NULL,session_generation INTEGER NOT NULL,updated_at INTEGER,
    upgrade_secret TEXT NOT NULL,legacy_key TEXT
  )`);
  if (retainEnvironment) sqlite.exec(`CREATE TABLE IF NOT EXISTS control_access_environment(
    instance_id TEXT PRIMARY KEY,passcode_hash TEXT NOT NULL
  )`);
  let hashing = 0,
    changing = false,
    importedEnv = "";
  const attempts = new Map(),
    clientsInFlight = new Set(),
    verifiedRequests = new WeakMap();
  function row() {
    const state = sqlite
      .prepare("SELECT * FROM control_access WHERE singleton=1")
      .get();
    invariant(
      state?.instance_id === instanceId &&
        ["none", "stored"].includes(state.source) &&
        typeof state.session_secret === "string" &&
        state.session_secret.length > 0 &&
        typeof state.upgrade_secret === "string" &&
        Buffer.from(state.upgrade_secret, "base64").length >= 32,
      "CONTROL_ACCESS_STATE_UNKNOWN",
    );
    return state;
  }
  const environment = () => envPasscode || importedEnv;
  const environmentHash = () => {
    if (!retainEnvironment) return undefined;
    const value = sqlite.prepare('SELECT passcode_hash FROM control_access_environment WHERE instance_id=?').get(instanceId)?.passcode_hash;
    invariant(value === undefined || hashParts(value), 'CONTROL_ACCESS_STATE_UNKNOWN');
    return value;
  };
  const source = (state) => (environment() || environmentHash() ? "env" : state.source);
  const secret = (state) => sessionSecretOverride || state.session_secret;
  function status(state = row()) {
    const actual = source(state);
    return {
      enabled: actual !== "none",
      source: actual,
      envOverride: actual === "env",
      sessionSecretPinned: Boolean(
        sessionSecretOverride || state.secret_pinned,
      ),
      revision: state.revision,
      updatedAt:
        actual === "stored" && state.updated_at !== null
          ? new Date(state.updated_at).toISOString()
          : null,
    };
  }
  async function kdf(work) {
    if (hashing >= maxKdfConcurrency) throw error("CONTROL_ACCESS_BUSY", 503);
    hashing++;
    try {
      return await work();
    } finally {
      hashing--;
    }
  }
  async function hashPasscode(plain) {
    return kdf(async () => {
      const salt = randomBytes(16),
        key = await derive(plain, salt, 32, {
          N: 32768,
          r: 8,
          p: 1,
          maxmem: 64 * 1024 * 1024,
        });
      return [
        "scrypt",
        32768,
        8,
        1,
        salt.toString("base64"),
        key.toString("base64"),
      ].join("$");
    });
  }
  async function matches(plain, state) {
    if (source(state) === "env" && environment()) return equal(plain, environment());
    const parts = hashParts(source(state) === 'env' ? environmentHash() : state.passcode_hash);
    if (!parts) return false;
    try {
      return await kdf(async () =>
        equal(
          await derive(plain, parts.salt, 32, {
            N: parts.N,
            r: parts.r,
            p: parts.p,
            maxmem: 64 * 1024 * 1024,
          }),
          parts.key,
        ),
      );
    } catch (failure) {
      if (failure.code === "CONTROL_ACCESS_BUSY") throw failure;
      return false;
    }
  }
  async function importState(input) {
    invariant(
      keys(
        input,
        ["source", "sessionSecret"],
        [
          "passcodeHash",
          "storedPasscodeHash",
          "envPasscode",
          "secretPinned",
          "updatedAt",
          "upgradeSessionSecretBase64",
          "legacyContinuityKey",
        ],
      ) &&
        ["none", "stored", "env"].includes(input.source) &&
        typeof input.sessionSecret === "string" &&
        input.sessionSecret.length > 0 &&
        input.sessionSecret.length <= 4096 &&
        (input.secretPinned === undefined ||
          typeof input.secretPinned === "boolean") &&
        (input.envPasscode === undefined ||
          (typeof input.envPasscode === "string" &&
            Buffer.byteLength(input.envPasscode) <= 1024)),
      "CONTROL_ACCESS_IMPORT_INVALID",
    );
    const stored =
      input.storedPasscodeHash ??
      (input.source === "stored" ? input.passcodeHash : null);
    invariant(
      stored == null || hashParts(stored),
      "CONTROL_ACCESS_IMPORT_INVALID",
    );
    invariant(
      input.source !== "stored" || stored != null,
      "CONTROL_ACCESS_IMPORT_INVALID",
    );
    invariant(
      input.source !== "env" || Boolean(envPasscode || input.envPasscode),
      "CONTROL_ACCESS_IMPORT_INVALID",
    );
    const upgradeSecret =
      input.upgradeSessionSecretBase64 || randomBytes(32).toString("base64");
    invariant(
      typeof upgradeSecret === "string" &&
        upgradeSecret.length <= 256 &&
        Buffer.from(upgradeSecret, "base64").length >= 32 &&
        (input.legacyContinuityKey === undefined ||
          (typeof input.legacyContinuityKey === "string" &&
            input.legacyContinuityKey.length >= 32 &&
            input.legacyContinuityKey.length <= 4096)),
      "CONTROL_ACCESS_IMPORT_INVALID",
    );
    const updatedAt =
      input.updatedAt == null
        ? null
        : typeof input.updatedAt === "number"
          ? input.updatedAt
          : Date.parse(input.updatedAt);
    invariant(
      updatedAt === null || Number.isFinite(updatedAt),
      "CONTROL_ACCESS_IMPORT_INVALID",
    );
    // The privileged migration transfers the original ENV once in memory. A
    // Supervisor must never acquire it merely to restart the Agent. Retain a
    // bounded scrypt verifier in the Agent's private access.db so ENV priority
    // survives process replacement without persisting the plaintext passcode.
    const effectiveEnvironment = envPasscode || input.envPasscode || '';
    const retainedEnvironmentHash = retainEnvironment && effectiveEnvironment ? await hashPasscode(effectiveEnvironment) : null;
    sqlite
      .transaction(() => {
        invariant(
          !sqlite
            .prepare("SELECT 1 FROM control_access WHERE singleton=1")
            .get(),
          "CONTROL_ACCESS_ALREADY_IMPORTED",
        );
        sqlite
          .prepare("INSERT INTO control_access VALUES(1,?,?,?,?,?,1,1,?,?,?)")
          .run(
            instanceId,
            stored == null ? "none" : "stored",
            stored ?? null,
            retainEnvironment ? sessionSecretOverride || input.sessionSecret : input.sessionSecret,
            input.secretPinned || retainEnvironment && sessionSecretOverride ? 1 : 0,
            updatedAt,
            upgradeSecret,
            input.legacyContinuityKey ?? null,
          );
        if (retainedEnvironmentHash) sqlite.prepare('INSERT INTO control_access_environment VALUES(?,?)').run(instanceId, retainedEnvironmentHash);
      })
      .immediate();
    importedEnv = input.envPasscode || "";
    return status();
  }
  const sign = (value, state) =>
    createHmac("sha256", secret(state)).update(value).digest("hex");
  function verifySessionToken(token, now = clock(), state = row()) {
    if (typeof token !== "string" || token.length > 256) return false;
    const dot = token.lastIndexOf(".");
    if (dot < 1) return false;
    const expiry = token.slice(0, dot),
      number = Number(expiry);
    return (
      Number.isFinite(number) &&
      number > now &&
      equal(token.slice(dot + 1), sign(expiry, state))
    );
  }
  function issueSessionToken(now = clock(), state = row()) {
    invariant(Number.isFinite(now), "CONTROL_ACCESS_CLOCK_UNKNOWN");
    const expiry = String(now + TTL);
    return `${expiry}.${sign(expiry, state)}`;
  }
  function sessionCookie(token) {
    return `ap_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL / 1000}${cookieSecure ? "; Secure" : ""}`;
  }
  function loopback(address) {
    const peer = address?.startsWith("::ffff:") ? address.slice(7) : address;
    return (
      allowLoopback &&
      (peer === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(peer || ""))
    );
  }
  const upgradeKey = (state) => Buffer.from(state.upgrade_secret, "base64");
  const upgradeHmac = (state, text, encoding = "hex") =>
    createHmac("sha256", upgradeKey(state)).update(text).digest(encoding);
  function signViewer(payload, state) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${upgradeHmac(state, encoded, "base64url")}`;
  }
  function viewer(raw, state) {
    if (typeof raw !== "string" || raw.length > 4096) return null;
    const [payload, signature, extra] = raw.split(".");
    if (
      !payload ||
      !signature ||
      extra ||
      !equal(signature, upgradeHmac(state, payload, "base64url"))
    )
      return null;
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      return value?.instanceId === instanceId &&
        typeof value.viewerId === "string" &&
        ID.test(value.viewerId) &&
        value.expiresAt > clock()
        ? value
        : null;
    } catch {
      return null;
    }
  }
  function principal(request, authorized, state) {
    let value = viewer(cookie(request.cookie, "ap_upgrade_viewer"), state),
      viewerCookie;
    if (!value) {
      value = { instanceId, viewerId: randomUUID(), expiresAt: clock() + TTL };
      viewerCookie = `ap_upgrade_viewer=${signViewer(value, state)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}${cookieSecure ? "; Secure" : ""}`;
    }
    const viewerId = value.viewerId;
    return {
      principal: {
        actorId: authorized ? "instance-administrator" : `viewer-${viewerId}`,
        viewerId,
        canUpgrade: authorized,
        userScope: upgradeHmac(state, `scope:${instanceId}:${viewerId}`),
        csrfToken: upgradeHmac(
          state,
          `csrf:${instanceId}:${viewerId}`,
          "base64url",
        ),
      },
      ...(viewerCookie ? { viewerCookie } : {}),
    };
  }
  async function evaluate(request, mode = "http") {
    if (
      !requestShape(request) ||
      !["http", "ws", "read-only", "unlock"].includes(mode)
    )
      throw error("CONTROL_ACCESS_REQUEST_INVALID", 400);
    const state = row(),
      policy = status(state),
      now = clock();
    const finish = (authorized, extra = {}) => {
      if (row().revision !== state.revision)
        throw error("CONTROL_ACCESS_POLICY_CHANGED");
      return {
        authorized,
        policyRevision: state.revision,
        status: policy,
        ...(mode === "http" ? principal(request, authorized, state) : {}),
        ...extra,
      };
    };
    if (!policy.enabled) return finish(true);
    if (
      mode !== "unlock" &&
      (loopback(request.remoteAddress) ||
        verifySessionToken(cookie(request.cookie, "ap_session"), now, state))
    )
      return finish(true);
    const client = request.clientIp,
      previous = attempts.get(client),
      lockedForSec =
        previous?.lockedUntil > now
          ? Math.ceil((previous.lockedUntil - now) / 1000)
          : 0;
    if (mode !== "read-only" && lockedForSec)
      return finish(false, {
        failure: { kind: "locked", retryAfterSec: lockedForSec },
      });
    if (request.passcode === undefined)
      return finish(false, { failure: { kind: "required" } });
    if (
      clientsInFlight.has(client) ||
      (!attempts.has(client) && attempts.size >= maxClients)
    )
      throw error("CONTROL_ACCESS_BUSY", 503);
    clientsInFlight.add(client);
    if (mode !== "read-only" && !previous)
      attempts.set(client, { count: 0, lockedUntil: 0 });
    try {
      const valid = await matches(request.passcode, state);
      if (row().revision !== state.revision)
        throw error("CONTROL_ACCESS_POLICY_CHANGED");
      if (valid) {
        if (mode !== "read-only") attempts.delete(client);
        return finish(
          true,
          mode === "ws" || mode === "read-only"
            ? {}
            : { sessionToken: issueSessionToken(now, state) },
        );
      }
      let failure = { kind: "invalid" };
      if (mode !== "read-only") {
        const count = (previous?.count || 0) + 1,
          lockedUntil = count >= 5 ? now + LOCK_MS : 0;
        attempts.set(client, { count, lockedUntil });
        failure = {
          kind: "invalid",
          consecutiveFailures: count,
          maxFailures: 5,
          lockedForSec:
            lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0,
        };
      }
      return finish(false, { failure });
    } catch (failure) {
      if (!previous && attempts.get(client)?.count === 0)
        attempts.delete(client);
      throw failure;
    } finally {
      clientsInFlight.delete(client);
    }
  }
  async function change(input) {
    if (
      !keys(
        input,
        ["request", "action"],
        ["invalidateSessions", "expectedRevision"],
      ) ||
      !requestShape(input.request) ||
      !["enable", "regenerate", "disable"].includes(input.action) ||
      (input.invalidateSessions !== undefined &&
        typeof input.invalidateSessions !== "boolean") ||
      (input.expectedRevision !== undefined &&
        !Number.isSafeInteger(input.expectedRevision))
    )
      throw error("CONTROL_ACCESS_CHANGE_INVALID", 400);
    const auth = await evaluate(input.request, "http");
    if (!auth.authorized) throw error("PASSCODE_REQUIRED", 401);
    const original = row(),
      before = status(original),
      invalidate = input.invalidateSessions === true;
    if (before.source === "env")
      throw error(
        "INVALID_STATE",
        409,
        "此实例的访问口令由部署配置 ACCESS_PASSCODE 固定，无法在这里修改。",
      );
    if (invalidate && input.action !== "regenerate")
      throw error(
        "INVALID_STATE",
        409,
        "只有重新生成口令时可以同时让已登录的浏览器失效。",
      );
    if (invalidate && before.sessionSecretPinned)
      throw error(
        "INVALID_STATE",
        409,
        "会话签名密钥由部署配置 PASSCODE_COOKIE_SECRET 固定；口令没有改变。",
      );
    if (input.action === "enable" && before.enabled)
      throw error(
        "INVALID_STATE",
        409,
        "访问口令已经启用了，请使用重新生成口令。",
      );
    if (input.action === "regenerate" && !before.enabled)
      throw error(
        "INVALID_STATE",
        409,
        "访问口令还没启用，请先把访问口令打开。",
      );
    if (changing) throw error("CONTROL_ACCESS_BUSY", 503);
    changing = true;
    try {
      const alphabet =
        "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const plain =
        input.action === "disable"
          ? null
          : [...randomBytes(16)]
              .map((value) => alphabet[value % alphabet.length])
              .join("");
      const hash = plain === null ? null : await hashPasscode(plain);
      return sqlite
        .transaction(() => {
          const current = row();
          if (
            current.revision !== original.revision ||
            auth.policyRevision !== current.revision ||
            (input.expectedRevision !== undefined &&
              input.expectedRevision !== current.revision)
          )
            throw error("CONTROL_ACCESS_POLICY_CHANGED");
          if (plain !== null || current.source !== "none")
            sqlite
              .prepare(
                "UPDATE control_access SET source=?,passcode_hash=?,session_secret=?,revision=revision+1,session_generation=session_generation+?,updated_at=? WHERE singleton=1",
              )
              .run(
                plain === null ? "none" : "stored",
                hash,
                invalidate
                  ? randomBytes(32).toString("hex")
                  : current.session_secret,
                invalidate ? 1 : 0,
                plain === null ? null : clock(),
              );
          const after = row();
          return {
            changed: plain !== null || current.source !== "none",
            result: {
              enabled: plain !== null,
              ...(plain !== null ? { passcode: plain } : {}),
            },
            status: status(after),
            ...(invalidate
              ? { sessionToken: issueSessionToken(clock(), after) }
              : {}),
          };
        })
        .immediate();
    } finally {
      changing = false;
    }
  }
  function fingerprint() {
    const state = row(),
      access = issueSessionToken(0, state),
      upgrade = upgradeHmac(state, `session-continuity:${instanceId}`);
    const legacy = state.legacy_key
      ? upgradeHmac(
          state,
          `session-continuity:${instanceId}:${state.legacy_key}`,
        )
      : null;
    return {
      instanceId,
      policyRevision: state.revision,
      fingerprint: digest({ upgrade, access }),
      legacyFingerprint: legacy ? digest({ upgrade: legacy, access }) : null,
    };
  }
  function challenge({ legacyBaseline = false } = {}) {
    invariant(
      typeof legacyBaseline === "boolean",
      "CONTROL_ACCESS_CHALLENGE_INVALID",
    );
    const state = row(),
      viewerId = randomUUID(),
      expiresAt = clock() + 60000,
      legacy = legacyBaseline && Boolean(state.legacy_key);
    const grant = legacy
      ? signViewer(
          {
            instanceId,
            viewerId,
            capability: "upgrade-instance",
            grantVersion: upgradeHmac(state, `grant:${state.legacy_key}`),
            expiresAt,
          },
          state,
        )
      : null;
    const sessionToken = issueSessionToken(clock(), state);
    return {
      ...fingerprint(),
      cookie: `ap_upgrade_viewer=${signViewer({ instanceId, viewerId, expiresAt }, state)}${grant ? `; ap_upgrade_grant=${grant}` : ""}; ap_session=${encodeURIComponent(sessionToken)}`,
      sessionToken,
      userScope: upgradeHmac(state, `scope:${instanceId}:${viewerId}`),
      legacy,
    };
  }
  function fromRequest(req, plain) {
    const auth = req.headers?.authorization,
      direct = req.headers?.["x-access-passcode"];
    const passcode =
      plain ??
      (typeof auth === "string" && auth.startsWith("Bearer ")
        ? auth.slice(7)
        : typeof direct === "string"
          ? direct
          : typeof req.query?.passcode === "string"
            ? req.query.passcode
            : undefined);
    return {
      remoteAddress: req.socket?.remoteAddress || null,
      clientIp: req.accessClientIp || req.socket?.remoteAddress || "unknown",
      ...(typeof req.headers?.cookie === "string"
        ? { cookie: req.headers.cookie }
        : {}),
      ...(passcode !== undefined ? { passcode } : {}),
    };
  }
  async function authenticate(req, plain) {
    const value = await evaluate(fromRequest(req, plain));
    verifiedRequests.set(req, value);
    return value.authorized;
  }
  function authenticatesRequest(req) {
    const state = row(),
      prior = verifiedRequests.get(req);
    if (prior)
      return prior.authorized && prior.policyRevision === state.revision;
    return (
      !status(state).enabled ||
      loopback(req.socket?.remoteAddress) ||
      verifySessionToken(
        cookie(req.headers?.cookie, "ap_session"),
        clock(),
        state,
      )
    );
  }
  const passcodePort = {
    authenticatesRequest,
    issueSessionToken,
    issueCurrentSessionToken: issueSessionToken,
    verifySessionToken,
    get enabled() {
      return status().enabled;
    },
    get source() {
      return status().source;
    },
    get sessionSecretPinned() {
      return status().sessionSecretPinned;
    },
  };
  return {
    importState,
    status,
    evaluate,
    authenticate,
    authenticatesRequest,
    issueSessionToken,
    verifySessionToken,
    sessionCookie,
    change,
    fingerprint,
    challenge,
    passcodePort,
  };
}

/** Private, fixed RPC only. Cookies/plaintext remain in RAM and are never logged. */
export function createControlAccessHttpHandler({
  authority,
  instanceId,
  key,
  maxRequests = 32,
  bodyTimeoutMs = 2000,
}) {
  invariant(
    authority &&
      ID.test(instanceId) &&
      typeof key === "string" &&
      key.length >= 32,
    "CONTROL_ACCESS_HTTP_CONFIG_REQUIRED",
  );
  invariant(
    Number.isInteger(maxRequests) &&
      maxRequests > 0 &&
      maxRequests <= 128 &&
      Number.isInteger(bodyTimeoutMs) &&
      bodyTimeoutMs > 0 &&
      bodyTimeoutMs <= 2000,
    "CONTROL_ACCESS_HTTP_CONFIG_REQUIRED",
  );
  let activeRequests = 0;
  return async (req, res) => {
    const path = typeof req.url === "string" ? req.url.split("?")[0] : "";
    if (!path.startsWith("/internal/control/access/")) return false;
    const reply = (status, value) => {
      if (res.destroyed || res.writableEnded) return true;
      const bytes = JSON.stringify(value);
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(bytes);
      return true;
    };
    let admitted = false;
    try {
      if (activeRequests >= maxRequests)
        throw error("CONTROL_ACCESS_BUSY", 503);
      activeRequests++;
      admitted = true;
      if (
        req.method !== "POST" ||
        req.url !== path ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket?.remoteAddress,
        ) ||
        typeof req.headers["x-platform-internal-key"] !== "string" ||
        !equal(req.headers["x-platform-internal-key"], key) ||
        req.headers["x-platform-instance-id"] !== instanceId
      )
        throw error("CONTROL_ACCESS_INTERNAL_AUTH", 403);
      const length = Number(req.headers["content-length"]);
      if (Number.isFinite(length) && length > MAX_BODY)
        throw error("CONTROL_ACCESS_BODY_TOO_LARGE", 413);
      let size = 0;
      const chunks = [];
      // The private peer cannot reserve unbounded body buffers or idle readers.
      let timeout;
      try {
        await Promise.race([
          (async () => {
            for await (const chunk of req) {
              size += chunk.length;
              if (size > MAX_BODY)
                throw error("CONTROL_ACCESS_BODY_TOO_LARGE", 413);
              chunks.push(chunk);
            }
          })(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              reject(error("CONTROL_ACCESS_BODY_TIMEOUT", 503));
              req.destroy();
            }, bodyTimeoutMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw error("CONTROL_ACCESS_REQUEST_INVALID", 400);
      }
      const action = path.slice("/internal/control/access/".length);
      let value;
      if (action === "status" || action === "fingerprint") {
        if (!keys(body, [])) throw error("CONTROL_ACCESS_REQUEST_INVALID", 400);
        value = authority[action]();
      } else if (action === "authenticate") {
        if (
          !keys(body, ["request", "mode"]) ||
          !["http", "ws", "read-only"].includes(body.mode)
        )
          throw error("CONTROL_ACCESS_REQUEST_INVALID", 400);
        value = await authority.evaluate(body.request, body.mode);
      } else if (action === "unlock") {
        if (
          !keys(body, ["request"]) ||
          !requestShape(body.request) ||
          typeof body.request.passcode !== "string" ||
          !body.request.passcode.length
        )
          throw error("CONTROL_ACCESS_REQUEST_INVALID", 400);
        value = await authority.evaluate(body.request, "unlock");
      } else if (action === "change") value = await authority.change(body);
      else if (action === "challenge") {
        if (
          !keys(body, ["legacyBaseline"]) ||
          typeof body.legacyBaseline !== "boolean"
        )
          throw error("CONTROL_ACCESS_REQUEST_INVALID", 400);
        value = authority.challenge(body);
      } else throw error("CONTROL_ACCESS_RPC_NOT_FOUND", 404);
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_BODY)
        throw error("CONTROL_ACCESS_RESPONSE_TOO_LARGE", 503);
      return reply(200, value);
    } catch (failure) {
      return reply(
        [400, 401, 403, 404, 409, 413, 503].includes(failure.status)
          ? failure.status
          : 503,
        {
          error: {
            code: /^[A-Z0-9_]{1,100}$/.test(failure.code || "")
              ? failure.code
              : "CONTROL_ACCESS_UNAVAILABLE",
            message:
              failure.status === 409
                ? failure.message
                : "Access authority request rejected",
          },
        },
      );
    } finally {
      if (admitted) activeRequests--;
    }
  };
}
