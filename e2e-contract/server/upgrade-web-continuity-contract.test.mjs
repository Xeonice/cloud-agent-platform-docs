import test from "node:test";
import assert from "node:assert/strict";
import { n01WebContinuity } from "./upgrade-web-continuity-contract.mjs";

const sourceWeb = {
  artifactDigest: "sha256:" + "a".repeat(64),
  webRevision: "b".repeat(40),
};
const input = (targetWeb = { ...sourceWeb }) => ({
  sourceWeb,
  targetWeb,
  loadedWebRevision: sourceWeb.webRevision,
});

test("same actual Web tuple keeps its mode across different release IDs without mutating inputs", () => {
  const value = input({ ...sourceWeb, releaseId: "another-service-release" });
  const before = structuredClone(value);
  assert.equal(n01WebContinuity(value).sameWeb, true);
  assert.deepEqual(value, before);
});

test("either changed artifact bytes or changed loaded build revision requires the changed-Web path", () => {
  assert.equal(n01WebContinuity(input({
    ...sourceWeb, artifactDigest: "sha256:" + "c".repeat(64),
  })).sameWeb, false);
  assert.equal(n01WebContinuity(input({
    ...sourceWeb, webRevision: "d".repeat(40),
  })).sameWeb, false);
});

test("matching configured components cannot substitute for the actual loaded browser identity", () => {
  for (const loadedWebRevision of [undefined, null, "", "d".repeat(40)])
    assert.throws(() => n01WebContinuity({ ...input(), loadedWebRevision }),
      /N01_LOADED_SOURCE_WEB_IDENTITY_MISMATCH/);
});

test("incomplete or malformed source and target identities never choose a permissive mode", () => {
  for (const web of [null, {}, { ...sourceWeb, artifactDigest: "a".repeat(64) },
    { ...sourceWeb, webRevision: "b".repeat(39) }]) {
    assert.throws(() => n01WebContinuity({ ...input(), sourceWeb: web }),
      /N01_VERIFIED_WEB_COMPONENTS_REQUIRED/);
    assert.throws(() => n01WebContinuity({ ...input(), targetWeb: web }),
      /N01_VERIFIED_WEB_COMPONENTS_REQUIRED/);
  }
});
