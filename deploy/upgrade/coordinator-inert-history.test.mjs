import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { canonical, digest, verifySignedManifest } from "./trust.mjs";
import {
  projectLegacyCoordinatorInertHistory,
  verifyLegacyCoordinatorInertHistory,
  verifyLegacyCoordinatorInertHistoryWire,
  hasReadOnlyLegacyArtifactCoverage,
} from "./coordinator-inert-history.mjs";
import { createCoordinatorInventory } from "./supervisor-inventory.mjs";
import { validateCoordinatorExitReceipt } from "./coordinator-exit-receipt.mjs";
import { createControlStabilization } from "./control-stabilization.mjs";
import { createProductionRoleAdapter } from "./production-role-adapter.mjs";

// Public historical signatures and observed identities only. No environment,
// cookie, Owner secret, SDK state or business DB is copied into this fixture.
// Docker transport below is local synthetic data; these are not Native proofs.
const INSTANCE = "agent-platform-iflytek-20261017-r1";
const NOW = Date.parse("2026-10-21T06:00:00.000Z");
const ROOTS = {
  channel: "experiment-iflytek-online-20261017-r1",
  distributionOrigins: [
    "https://github.com",
    "https://release-assets.githubusercontent.com",
  ],
  keys: [
    {
      id: "qualification-iflytek-baseline-production-20261017-r2",
      notAfter: "2027-01-15T07:28:34.514Z",
      notBefore: "2026-10-17T07:23:34.511Z",
      publicKey:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA+uSF9QcfPUI7beD5rf6Mx6A+k/piRiY1VYnCgeBWOnE=\n-----END PUBLIC KEY-----\n",
    },
    {
      id: "qualification-iflytek-20261017-r1-publisher",
      notAfter: "2027-10-17T07:48:59.390Z",
      notBefore: "2026-10-17T07:43:59.390Z",
      publicKey:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAKvmckXXotOqjZAimNfpPJYKiDHdqXT1/kl2Y/GGS/kA=\n-----END PUBLIC KEY-----\n",
    },
  ],
  purpose: "qualification",
  qualificationInstanceId: "agent-platform-iflytek-20261017-r1",
  schemaVersion: 1,
};
const SIGNED_PACKAGES = [
  {
    packageDigest:
      "sha256:e5d6960cd1323a184deb9d894ac5ca3c94c50c72b9cda3c188d39af6e923171b",
    manifestDigest:
      "sha256:cefc04fccd90d783404c52e083285e946a30bd3fc182d851d8bc94f45a304173",
    envelope: {
      manifest: {
        channel: "experiment-iflytek-online-20261017-r1",
        commits: {
          api: "e624a4ce89bea8d28ae48db20fcc15b9c04001ce",
          project: "2cfa551d17e1e9b9821d0f29724a0b2318e81821",
          web: "11ca18c9b14a12f99087a462661be3749f8f1d2f",
        },
        components: {
          api: {
            artifactDigest:
              "sha256:859637eac6a1f7245b64a5dda9e8ab1c86f5326e3f0c496e0a135c35896d6337",
            inputFingerprint:
              "sha256:edc4aba8530fc13b38aeeeb929bbfc9abb256b8e15464864b56582cbe721803b",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "e624a4ce89bea8d28ae48db20fcc15b9c04001ce",
          },
          coordinator: {
            artifactDigest:
              "sha256:859637eac6a1f7245b64a5dda9e8ab1c86f5326e3f0c496e0a135c35896d6337",
            dataFormats: ["project-name-v2-authority"],
            inputFingerprint:
              "sha256:edc4aba8530fc13b38aeeeb929bbfc9abb256b8e15464864b56582cbe721803b",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "e624a4ce89bea8d28ae48db20fcc15b9c04001ce",
          },
          installer: {
            artifactDigest:
              "sha256:08880c5d8dae4d2c9e2d8f45aa0556bc308f3c5d9b98b480bd63b004b1ff7645",
            inputFingerprint:
              "sha256:08880c5d8dae4d2c9e2d8f45aa0556bc308f3c5d9b98b480bd63b004b1ff7645",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "2cfa551d17e1e9b9821d0f29724a0b2318e81821",
          },
          owner: {
            artifactDigest:
              "sha256:859637eac6a1f7245b64a5dda9e8ab1c86f5326e3f0c496e0a135c35896d6337",
            inputFingerprint:
              "sha256:edc4aba8530fc13b38aeeeb929bbfc9abb256b8e15464864b56582cbe721803b",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "e624a4ce89bea8d28ae48db20fcc15b9c04001ce",
          },
          web: {
            artifactDigest:
              "sha256:4f4c48ca6705f04bb69ef3b3d23a120eb5f96a3501de0a5dac0d643b7e465fdf",
            inputFingerprint:
              "sha256:2d39b53dec019a6436daaabf25abffe3b26704a35ce47aa2c6ce380aec5e1c40",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "11ca18c9b14a12f99087a462661be3749f8f1d2f",
            webRevision: "2d39b53dec019a6436daaabf25abffe3b26704a3",
          },
        },
        evidence: [
          {
            inputFingerprint:
              "sha256:9cea38e5e1e9417ff3b4121b2ee3710f9efe6ca1f013a79b34540a49c030c652",
            kind: "build",
            reason:
              "This exact R3 baseline has not executed its isolated qualification gate.",
            recordedAt: "2026-10-17T08:02:57.946Z",
            reportDigest:
              "sha256:2439c83b2946d34dee8a260bbcccb0ef18d021784d8410277a8fe182e3b563e9",
            result: "not-run",
            runId: "iflytek-baseline-production-20261017-r3",
          },
          {
            inputFingerprint:
              "sha256:9cea38e5e1e9417ff3b4121b2ee3710f9efe6ca1f013a79b34540a49c030c652",
            kind: "contracts",
            reason:
              "This exact R3 baseline has not executed its isolated qualification gate.",
            recordedAt: "2026-10-17T08:02:57.946Z",
            reportDigest:
              "sha256:b423a93efe56333e1f85f40925ae7c99542b42dc418db0a58add870e8e31d91e",
            result: "not-run",
            runId: "iflytek-baseline-production-20261017-r3",
          },
          {
            inputFingerprint:
              "sha256:9cea38e5e1e9417ff3b4121b2ee3710f9efe6ca1f013a79b34540a49c030c652",
            kind: "four-combinations",
            reason:
              "This exact R3 baseline has not executed its isolated qualification gate.",
            recordedAt: "2026-10-17T08:02:57.946Z",
            reportDigest:
              "sha256:e8e1d4bc064912a657ad87a8ead51c1ea4a266bde9e81d1a8e85d4484e91b705",
            result: "not-run",
            runId: "iflytek-baseline-production-20261017-r3",
          },
          {
            inputFingerprint:
              "sha256:9cea38e5e1e9417ff3b4121b2ee3710f9efe6ca1f013a79b34540a49c030c652",
            kind: "native-continuity",
            reason:
              "This exact R3 baseline has not executed its isolated qualification gate.",
            recordedAt: "2026-10-17T08:02:57.946Z",
            reportDigest:
              "sha256:5d2f2b2d087ae6897127364ff7933006c0d0137dda598892cc95b28671077c15",
            result: "not-run",
            runId: "iflytek-baseline-production-20261017-r3",
          },
          {
            inputFingerprint:
              "sha256:9cea38e5e1e9417ff3b4121b2ee3710f9efe6ca1f013a79b34540a49c030c652",
            kind: "fault-recovery",
            reason:
              "This exact R3 baseline has not executed its isolated qualification gate.",
            recordedAt: "2026-10-17T08:02:57.946Z",
            reportDigest:
              "sha256:5bb7c4c9d207a87e0fab31c5f7d685b8b58d1661e759483a5a79d43ae3d1d5a9",
            result: "not-run",
            runId: "iflytek-baseline-production-20261017-r3",
          },
        ],
        packages: [
          {
            arch: "arm64",
            bytes: 94248324,
            digest:
              "sha256:e5d6960cd1323a184deb9d894ac5ca3c94c50c72b9cda3c188d39af6e923171b",
            format: "native-tar",
            name: "agent-platform-v0.3.11-iflytek.20261017.3-linux-arm64.tgz",
            platform: "linux",
            unpackedBytes: 290422005,
            url: "https://github.com/Xeonice/cloud-agent-platform-docs/releases/download/v0.3.11-iflytek.20261017.3/agent-platform-v0.3.11-iflytek.20261017.3-linux-arm64.tgz",
          },
        ],
        policy: {
          attachDeadlineMs: 5000,
          consecutiveEvaluations: 2,
          contractInUpgrade: false,
          evaluationIntervalMs: 10000,
          fallbacks: [
            {
              apiDigest:
                "sha256:859637eac6a1f7245b64a5dda9e8ab1c86f5326e3f0c496e0a135c35896d6337",
              rehearsed: false,
              releaseId: "v0.3.11-iflytek.20261017.3",
              webDigest:
                "sha256:4f4c48ca6705f04bb69ef3b3d23a120eb5f96a3501de0a5dac0d643b7e465fdf",
            },
          ],
          id: "experiment-iflytek-online-20261017-r1",
          maxWalBytes: 100000000,
          migrationBatchMs: 500,
          minFreeBytes: 500000000,
          minRequests: 100,
          observationFreshnessMs: 5000,
          p95FloorMs: 1000,
          p95Ratio: 2,
          probeHz: 10,
          requestDeadlineMs: 2000,
          restoreLiveVolume: false,
          retentionMs: 600000,
          softErrorDelta: 0.01,
          stageDurationMs: 60000,
          stopUserResources: false,
          weights: [1, 5, 25, 100],
        },
        publishedAt: "2026-10-17T08:02:57.946Z",
        purpose: "qualification",
        qualification: {
          inputFingerprint:
            "sha256:9cea38e5e1e9417ff3b4121b2ee3710f9efe6ca1f013a79b34540a49c030c652",
          instanceId: "agent-platform-iflytek-20261017-r1",
        },
        releaseId: "v0.3.11-iflytek.20261017.3",
        runInputFingerprint:
          "sha256:9cea38e5e1e9417ff3b4121b2ee3710f9efe6ca1f013a79b34540a49c030c652",
        schemaVersion: 2,
        upgradePaths: [
          {
            bridgeReleases: [],
            fromRelease: "v0.3.11-iflytek.20261017.3",
            maxSchema: 28,
            migrationPlanDigest: null,
            minSchema: 28,
            targetSchema: 28,
          },
        ],
      },
      manifestDigest:
        "sha256:cefc04fccd90d783404c52e083285e946a30bd3fc182d851d8bc94f45a304173",
      signature: {
        algorithm: "Ed25519",
        keyId: "qualification-iflytek-20261017-r1-publisher",
        value:
          "PE7Xasd49atVTqHJ/bTWO17aKc6qrDlMoJvZ6URLNnMA4BKw4PecjI+VBn3bMqtLMgn3YjH3MQyiH71uI1EDCQ==",
      },
    },
  },
  {
    packageDigest:
      "sha256:00ef2fcf69aa226c4c5d4ad9b19938bab55dfc3999452081f4c9707126246d15",
    manifestDigest:
      "sha256:5d5cda3db8347e03c1ba9ca1b96eef8dde1b4c02bbc8807ed8f86fb07ad5e5a2",
    envelope: {
      manifest: {
        channel: "experiment-iflytek-online-20261017-r1",
        commits: {
          api: "39cd9da0cf48395584a8525f1206ace5471bd5da",
          project: "ae17c1d5475aafd0eabcd0109970bfa4e017966d",
          web: "30c58400761729d7a56575cfc0052cbb3bef5923",
        },
        components: {
          api: {
            artifactDigest:
              "sha256:d009218239e389a4d78d02cef503a97fcbcb7d9a9e887485829432fe03e07de4",
            inputFingerprint:
              "sha256:b6b5dece345a564e9b0f3d70de975b92ed9de93f690f0bc2dc043948a5520fe7",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "39cd9da0cf48395584a8525f1206ace5471bd5da",
          },
          coordinator: {
            artifactDigest:
              "sha256:d009218239e389a4d78d02cef503a97fcbcb7d9a9e887485829432fe03e07de4",
            dataFormats: ["project-name-v2-authority"],
            inputFingerprint:
              "sha256:b6b5dece345a564e9b0f3d70de975b92ed9de93f690f0bc2dc043948a5520fe7",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "39cd9da0cf48395584a8525f1206ace5471bd5da",
          },
          installer: {
            artifactDigest:
              "sha256:1b32dd42606582859ca8a493d387f7556bf36856c8ce71dd6bb68cddf73f53e8",
            inputFingerprint:
              "sha256:1b32dd42606582859ca8a493d387f7556bf36856c8ce71dd6bb68cddf73f53e8",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "ae17c1d5475aafd0eabcd0109970bfa4e017966d",
          },
          owner: {
            artifactDigest:
              "sha256:d009218239e389a4d78d02cef503a97fcbcb7d9a9e887485829432fe03e07de4",
            inputFingerprint:
              "sha256:b6b5dece345a564e9b0f3d70de975b92ed9de93f690f0bc2dc043948a5520fe7",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "39cd9da0cf48395584a8525f1206ace5471bd5da",
          },
          web: {
            artifactDigest:
              "sha256:577ddac5dadb1249c086438b48982f769a08f2efbe849eae2c7fd36f932083c1",
            inputFingerprint:
              "sha256:071ee315ccb2a05867d0ce4d7adf76e9beb4672cd9fca179a0a0466ec06e451b",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "30c58400761729d7a56575cfc0052cbb3bef5923",
            webRevision: "071ee315ccb2a05867d0ce4d7adf76e9beb4672c",
          },
        },
        evidence: [
          {
            inputFingerprint:
              "sha256:8f051d114f9ec2a38228f983361dc7fd7cb19102c10762f968ad6b0186bd56cb",
            kind: "build",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:24:11.326Z",
            reportDigest:
              "sha256:8eef2e3350876207a10525c91411799f3be51c57365ddc53c52c757878e14348",
            result: "not-run",
            runId: "cli-iflytek-bridge-20261017-r7",
          },
          {
            inputFingerprint:
              "sha256:8f051d114f9ec2a38228f983361dc7fd7cb19102c10762f968ad6b0186bd56cb",
            kind: "contracts",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:24:11.336Z",
            reportDigest:
              "sha256:9790188e139515ff2ac87115cf0c58f516eb87524a479f0223942a73409ae28a",
            result: "not-run",
            runId: "cli-iflytek-bridge-20261017-r7",
          },
          {
            inputFingerprint:
              "sha256:8f051d114f9ec2a38228f983361dc7fd7cb19102c10762f968ad6b0186bd56cb",
            kind: "four-combinations",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:24:11.345Z",
            reportDigest:
              "sha256:d9d7037c76b4f79dffa0930b5b2f0bac057ccdedaf30b9924bd5da4aab28f8a6",
            result: "not-run",
            runId: "cli-iflytek-bridge-20261017-r7",
          },
          {
            inputFingerprint:
              "sha256:8f051d114f9ec2a38228f983361dc7fd7cb19102c10762f968ad6b0186bd56cb",
            kind: "native-continuity",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:24:11.352Z",
            reportDigest:
              "sha256:53a82d28cfd39870d3929dc93c0b478fce80c1b3e71540130407cda49e36395c",
            result: "not-run",
            runId: "cli-iflytek-bridge-20261017-r7",
          },
          {
            inputFingerprint:
              "sha256:8f051d114f9ec2a38228f983361dc7fd7cb19102c10762f968ad6b0186bd56cb",
            kind: "fault-recovery",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:24:11.357Z",
            reportDigest:
              "sha256:205f691904b0b1ffe1b9ccadaedac4f945bb536696cd219c0dd404f1a7b9446f",
            result: "not-run",
            runId: "cli-iflytek-bridge-20261017-r7",
          },
        ],
        packages: [
          {
            arch: "arm64",
            bytes: 94278954,
            digest:
              "sha256:00ef2fcf69aa226c4c5d4ad9b19938bab55dfc3999452081f4c9707126246d15",
            format: "native-tar",
            name: "agent-platform-v0.3.12-experiment.iflytek-bridge.20261017.7-linux-arm64.tgz",
            platform: "linux",
            unpackedBytes: 290561575,
            url: "https://github.com/Xeonice/cloud-agent-platform-docs/releases/download/v0.3.12-experiment.iflytek-bridge.20261017.7/agent-platform-v0.3.12-experiment.iflytek-bridge.20261017.7-linux-arm64.tgz",
          },
        ],
        policy: {
          attachDeadlineMs: 5000,
          consecutiveEvaluations: 2,
          contractInUpgrade: false,
          evaluationIntervalMs: 10000,
          fallbacks: [
            {
              apiDigest:
                "sha256:859637eac6a1f7245b64a5dda9e8ab1c86f5326e3f0c496e0a135c35896d6337",
              rehearsed: false,
              releaseId: "v0.3.11-iflytek.20261017.3",
              webDigest:
                "sha256:4f4c48ca6705f04bb69ef3b3d23a120eb5f96a3501de0a5dac0d643b7e465fdf",
            },
          ],
          id: "experiment-iflytek-online-20261017-r1",
          maxWalBytes: 100000000,
          migrationBatchMs: 500,
          minFreeBytes: 500000000,
          minRequests: 100,
          observationFreshnessMs: 5000,
          p95FloorMs: 1000,
          p95Ratio: 2,
          probeHz: 10,
          requestDeadlineMs: 2000,
          restoreLiveVolume: false,
          retentionMs: 600000,
          softErrorDelta: 0.01,
          stageDurationMs: 60000,
          stopUserResources: false,
          weights: [1, 5, 25, 100],
        },
        publishedAt: "2026-10-17T17:24:11.325Z",
        purpose: "qualification",
        qualification: {
          inputFingerprint:
            "sha256:8f051d114f9ec2a38228f983361dc7fd7cb19102c10762f968ad6b0186bd56cb",
          instanceId: "agent-platform-iflytek-20261017-r1",
        },
        releaseId: "v0.3.12-experiment.iflytek-bridge.20261017.7",
        runInputFingerprint:
          "sha256:8f051d114f9ec2a38228f983361dc7fd7cb19102c10762f968ad6b0186bd56cb",
        schemaVersion: 2,
        upgradePaths: [
          {
            bridgeReleases: [],
            fromRelease: "v0.3.11-iflytek.20261017.3",
            maxSchema: 28,
            migrationPlanDigest: null,
            minSchema: 28,
            targetSchema: 28,
          },
        ],
      },
      manifestDigest:
        "sha256:5d5cda3db8347e03c1ba9ca1b96eef8dde1b4c02bbc8807ed8f86fb07ad5e5a2",
      signature: {
        algorithm: "Ed25519",
        keyId: "qualification-iflytek-20261017-r1-publisher",
        value:
          "jUVPz0uzPi+0L0HdEu4K43qyyixXqwQVHKUXK5fY6Dpxw5nqB6WAbqsAExLZyBxXEb1HC7E+2QGWnNYRMzydDQ==",
      },
    },
  },
  {
    packageDigest:
      "sha256:0e35c1047dbdf7bea75a2753a61568cd04dd9245de3afce2dd7795176d293816",
    manifestDigest:
      "sha256:135d657706f118506c24e7919fcf94b89ba28fa36c1abfac9c3a2919eb63abce",
    envelope: {
      manifest: {
        channel: "experiment-iflytek-online-20261017-r1",
        commits: {
          api: "da3f99f113248a5eb60632f025e15c7b387633b1",
          project: "5c7db2f44aa2d42fd187b9534b262e0a6444b6ee",
          web: "30c58400761729d7a56575cfc0052cbb3bef5923",
        },
        components: {
          api: {
            artifactDigest:
              "sha256:c9006d95758784ca6db98b7f9a1faefb350e664ae4bec01073b9dc01f906dd42",
            inputFingerprint:
              "sha256:2f9ee3474e5a794e7a59c146d8270a17433c67f0c9692b94cd7ee29555f5ba2f",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "da3f99f113248a5eb60632f025e15c7b387633b1",
          },
          coordinator: {
            artifactDigest:
              "sha256:c9006d95758784ca6db98b7f9a1faefb350e664ae4bec01073b9dc01f906dd42",
            dataFormats: ["project-name-v2-authority"],
            inputFingerprint:
              "sha256:2f9ee3474e5a794e7a59c146d8270a17433c67f0c9692b94cd7ee29555f5ba2f",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "da3f99f113248a5eb60632f025e15c7b387633b1",
          },
          installer: {
            artifactDigest:
              "sha256:1b32dd42606582859ca8a493d387f7556bf36856c8ce71dd6bb68cddf73f53e8",
            inputFingerprint:
              "sha256:1b32dd42606582859ca8a493d387f7556bf36856c8ce71dd6bb68cddf73f53e8",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "5c7db2f44aa2d42fd187b9534b262e0a6444b6ee",
          },
          owner: {
            artifactDigest:
              "sha256:c9006d95758784ca6db98b7f9a1faefb350e664ae4bec01073b9dc01f906dd42",
            inputFingerprint:
              "sha256:2f9ee3474e5a794e7a59c146d8270a17433c67f0c9692b94cd7ee29555f5ba2f",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "da3f99f113248a5eb60632f025e15c7b387633b1",
          },
          web: {
            artifactDigest:
              "sha256:577ddac5dadb1249c086438b48982f769a08f2efbe849eae2c7fd36f932083c1",
            inputFingerprint:
              "sha256:071ee315ccb2a05867d0ce4d7adf76e9beb4672cd9fca179a0a0466ec06e451b",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "30c58400761729d7a56575cfc0052cbb3bef5923",
            webRevision: "071ee315ccb2a05867d0ce4d7adf76e9beb4672c",
          },
        },
        evidence: [
          {
            inputFingerprint:
              "sha256:132563c0b2831bff4eac6057b62ab97b6f39c0b9adfe0313bf20a51e1eea17f0",
            kind: "build",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:29:29.299Z",
            reportDigest:
              "sha256:3a9533c2102dfef42f7d0020fbd2b3158f847b108398db4a13d624a79e8979e7",
            result: "not-run",
            runId: "cli-iflytek-final-20261017-r7",
          },
          {
            inputFingerprint:
              "sha256:132563c0b2831bff4eac6057b62ab97b6f39c0b9adfe0313bf20a51e1eea17f0",
            kind: "contracts",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:29:29.309Z",
            reportDigest:
              "sha256:c92e400e8b0ce782ed1bc5f8a5d12a261b2c3bf36eda2e0995b648d0e7b1fc4e",
            result: "not-run",
            runId: "cli-iflytek-final-20261017-r7",
          },
          {
            inputFingerprint:
              "sha256:132563c0b2831bff4eac6057b62ab97b6f39c0b9adfe0313bf20a51e1eea17f0",
            kind: "four-combinations",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:29:29.316Z",
            reportDigest:
              "sha256:dbcf0b03902da5c8f36c80fb36e86b5c8faf0de1c85266b8e04b369e221ea1b5",
            result: "not-run",
            runId: "cli-iflytek-final-20261017-r7",
          },
          {
            inputFingerprint:
              "sha256:132563c0b2831bff4eac6057b62ab97b6f39c0b9adfe0313bf20a51e1eea17f0",
            kind: "native-continuity",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:29:29.322Z",
            reportDigest:
              "sha256:55f5959e7c7bfe42ff867d064239bdf2310fa89b7b0c2b891a6c2a2c8f33b682",
            result: "not-run",
            runId: "cli-iflytek-final-20261017-r7",
          },
          {
            inputFingerprint:
              "sha256:132563c0b2831bff4eac6057b62ab97b6f39c0b9adfe0313bf20a51e1eea17f0",
            kind: "fault-recovery",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-17T17:29:29.328Z",
            reportDigest:
              "sha256:cf4c692a4541d016f23f2a8a309d0da67a0c3e2fe457269d79dfdd3ad160f7ad",
            result: "not-run",
            runId: "cli-iflytek-final-20261017-r7",
          },
        ],
        packages: [
          {
            arch: "arm64",
            bytes: 94310190,
            digest:
              "sha256:0e35c1047dbdf7bea75a2753a61568cd04dd9245de3afce2dd7795176d293816",
            format: "native-tar",
            name: "agent-platform-v0.3.13-experiment.iflytek.20261017.7-linux-arm64.tgz",
            platform: "linux",
            unpackedBytes: 290718874,
            url: "https://github.com/Xeonice/cloud-agent-platform-docs/releases/download/v0.3.13-experiment.iflytek.20261017.7/agent-platform-v0.3.13-experiment.iflytek.20261017.7-linux-arm64.tgz",
          },
        ],
        policy: {
          attachDeadlineMs: 5000,
          consecutiveEvaluations: 2,
          contractInUpgrade: false,
          evaluationIntervalMs: 10000,
          fallbacks: [
            {
              apiDigest:
                "sha256:d009218239e389a4d78d02cef503a97fcbcb7d9a9e887485829432fe03e07de4",
              rehearsed: false,
              releaseId: "v0.3.12-experiment.iflytek-bridge.20261017.7",
              webDigest:
                "sha256:577ddac5dadb1249c086438b48982f769a08f2efbe849eae2c7fd36f932083c1",
            },
          ],
          id: "experiment-iflytek-online-20261017-r1",
          maxWalBytes: 100000000,
          migrationBatchMs: 500,
          minFreeBytes: 500000000,
          minRequests: 100,
          observationFreshnessMs: 5000,
          p95FloorMs: 1000,
          p95Ratio: 2,
          probeHz: 10,
          requestDeadlineMs: 2000,
          restoreLiveVolume: false,
          retentionMs: 600000,
          softErrorDelta: 0.01,
          stageDurationMs: 60000,
          stopUserResources: false,
          weights: [1, 5, 25, 100],
        },
        publishedAt: "2026-10-17T17:29:29.298Z",
        purpose: "qualification",
        qualification: {
          inputFingerprint:
            "sha256:132563c0b2831bff4eac6057b62ab97b6f39c0b9adfe0313bf20a51e1eea17f0",
          instanceId: "agent-platform-iflytek-20261017-r1",
        },
        releaseId: "v0.3.13-experiment.iflytek.20261017.7",
        runInputFingerprint:
          "sha256:132563c0b2831bff4eac6057b62ab97b6f39c0b9adfe0313bf20a51e1eea17f0",
        schemaVersion: 2,
        upgradePaths: [
          {
            bridgeReleases: [],
            fromRelease: "v0.3.12-experiment.iflytek-bridge.20261017.7",
            maxSchema: 29,
            migrationPlanDigest:
              "sha256:3e0d9d65f6974c2ce27a9acfee2795d603a6124bd951f3c53cbe02ef37543354",
            minSchema: 28,
            targetSchema: 29,
          },
        ],
      },
      manifestDigest:
        "sha256:135d657706f118506c24e7919fcf94b89ba28fa36c1abfac9c3a2919eb63abce",
      signature: {
        algorithm: "Ed25519",
        keyId: "qualification-iflytek-20261017-r1-publisher",
        value:
          "4fJur6Hq8BSCeLuC9IYfcO6EKGi+1f42SBmO0w0BLXESNr6x1Xim5i8pEuHgCLve5vutQo+yPYsD7qWcccWTCw==",
      },
    },
  },
  {
    packageDigest:
      "sha256:eca395c48609fc7e8328c3116f6ccdc05dd3d3eac8412a5badd0921e01548bd1",
    manifestDigest:
      "sha256:d7d56dc0dcbe478beb209a2b54e8626a965cde0f6883c54948969eb090da3802",
    envelope: {
      manifest: {
        channel: "experiment-iflytek-online-20261017-r1",
        commits: {
          api: "61ff5e9415b2ebed6790e9ab84c5b07aff253349",
          project: "ee5e43df55f9d41879efedf206c88584db71ae23",
          web: "17e676972ec207bac7f8da13461f3ed4b3b70216",
        },
        components: {
          api: {
            artifactDigest:
              "sha256:134cb845b92a2f0ac620ccffd4ba047e23f9c2a08722d3c0567fed511ffd5b49",
            inputFingerprint:
              "sha256:a22a6cd130f594040b443d387caf50734be789dd5493ce1c3e91941af8085346",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "61ff5e9415b2ebed6790e9ab84c5b07aff253349",
          },
          coordinator: {
            artifactDigest:
              "sha256:134cb845b92a2f0ac620ccffd4ba047e23f9c2a08722d3c0567fed511ffd5b49",
            dataFormats: ["project-name-v2-authority"],
            inputFingerprint:
              "sha256:a22a6cd130f594040b443d387caf50734be789dd5493ce1c3e91941af8085346",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "61ff5e9415b2ebed6790e9ab84c5b07aff253349",
            upgradeOperationFormats: ["upgrade-plan-v1"],
          },
          installer: {
            artifactDigest:
              "sha256:626b657fe864ef94783c349d7046f9e970c7107386505f1ab4d4dc548e998cf7",
            inputFingerprint:
              "sha256:626b657fe864ef94783c349d7046f9e970c7107386505f1ab4d4dc548e998cf7",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "ee5e43df55f9d41879efedf206c88584db71ae23",
          },
          owner: {
            artifactDigest:
              "sha256:134cb845b92a2f0ac620ccffd4ba047e23f9c2a08722d3c0567fed511ffd5b49",
            inputFingerprint:
              "sha256:a22a6cd130f594040b443d387caf50734be789dd5493ce1c3e91941af8085346",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "61ff5e9415b2ebed6790e9ab84c5b07aff253349",
          },
          web: {
            artifactDigest:
              "sha256:db04770052a89227e49f580be7ff3c8583670f7210c640771d9775d39ab2e4db",
            inputFingerprint:
              "sha256:6623f388ffc321d3f1df8c95e37438090297c45e12340d9518141c67cbdc541c",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "17e676972ec207bac7f8da13461f3ed4b3b70216",
            webRevision: "6623f388ffc321d3f1df8c95e37438090297c45e",
          },
        },
        evidence: [
          {
            inputFingerprint:
              "sha256:d9d16fe223731033af16d424442b8331155c885279dace6fd9d5798bc2811ff2",
            kind: "build",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T07:41:52.781Z",
            reportDigest:
              "sha256:26a0133a7fd9d97d14da539e5ae796001ed21d25917a3a0ae7dbfdebe5d3ac58",
            result: "not-run",
            runId: "optimization-iflytek-20261018-r2",
          },
          {
            inputFingerprint:
              "sha256:d9d16fe223731033af16d424442b8331155c885279dace6fd9d5798bc2811ff2",
            kind: "contracts",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T07:41:52.791Z",
            reportDigest:
              "sha256:391fb0438b2432c8328fd47b1140797838c8e8d066b5397a387a17d3706fabc9",
            result: "not-run",
            runId: "optimization-iflytek-20261018-r2",
          },
          {
            inputFingerprint:
              "sha256:d9d16fe223731033af16d424442b8331155c885279dace6fd9d5798bc2811ff2",
            kind: "four-combinations",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T07:41:52.797Z",
            reportDigest:
              "sha256:946e666bce44e66a94994f50507db502d4a5b11974e7083c26ae88f2a3cdf59f",
            result: "not-run",
            runId: "optimization-iflytek-20261018-r2",
          },
          {
            inputFingerprint:
              "sha256:d9d16fe223731033af16d424442b8331155c885279dace6fd9d5798bc2811ff2",
            kind: "native-continuity",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T07:41:52.805Z",
            reportDigest:
              "sha256:442bce65b6e5d6c87dab9056791a570ccbd47ffcaabc0b617f3509f999a01dc5",
            result: "not-run",
            runId: "optimization-iflytek-20261018-r2",
          },
          {
            inputFingerprint:
              "sha256:d9d16fe223731033af16d424442b8331155c885279dace6fd9d5798bc2811ff2",
            kind: "fault-recovery",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T07:41:52.812Z",
            reportDigest:
              "sha256:0d7ba9d88c6bc4ec950f353468ca9a9ee0c440734415cab698373782da8d166b",
            result: "not-run",
            runId: "optimization-iflytek-20261018-r2",
          },
        ],
        packages: [
          {
            arch: "arm64",
            bytes: 94390766,
            digest:
              "sha256:eca395c48609fc7e8328c3116f6ccdc05dd3d3eac8412a5badd0921e01548bd1",
            format: "native-tar",
            name: "agent-platform-v0.3.14-experiment.iflytek.20261018.2-linux-arm64.tgz",
            platform: "linux",
            unpackedBytes: 291144409,
            url: "https://github.com/Xeonice/cloud-agent-platform-docs/releases/download/v0.3.14-experiment.iflytek.20261018.2/agent-platform-v0.3.14-experiment.iflytek.20261018.2-linux-arm64.tgz",
          },
        ],
        policy: {
          attachDeadlineMs: 5000,
          consecutiveEvaluations: 2,
          contractInUpgrade: false,
          evaluationIntervalMs: 10000,
          fallbacks: [
            {
              apiDigest:
                "sha256:c9006d95758784ca6db98b7f9a1faefb350e664ae4bec01073b9dc01f906dd42",
              rehearsed: false,
              releaseId: "v0.3.13-experiment.iflytek.20261017.7",
              webDigest:
                "sha256:577ddac5dadb1249c086438b48982f769a08f2efbe849eae2c7fd36f932083c1",
            },
          ],
          id: "experiment-iflytek-online-20261017-r1",
          maxWalBytes: 100000000,
          migrationBatchMs: 500,
          minFreeBytes: 500000000,
          minRequests: 100,
          observationFreshnessMs: 5000,
          p95FloorMs: 1000,
          p95Ratio: 2,
          probeHz: 10,
          requestDeadlineMs: 2000,
          restoreLiveVolume: false,
          retentionMs: 600000,
          softErrorDelta: 0.01,
          stageDurationMs: 60000,
          stopUserResources: false,
          weights: [1, 5, 25, 100],
        },
        publishedAt: "2026-10-18T07:41:52.780Z",
        purpose: "qualification",
        qualification: {
          inputFingerprint:
            "sha256:d9d16fe223731033af16d424442b8331155c885279dace6fd9d5798bc2811ff2",
          instanceId: "agent-platform-iflytek-20261017-r1",
        },
        releaseId: "v0.3.14-experiment.iflytek.20261018.2",
        runInputFingerprint:
          "sha256:d9d16fe223731033af16d424442b8331155c885279dace6fd9d5798bc2811ff2",
        schemaVersion: 2,
        upgradePaths: [
          {
            bridgeReleases: [],
            fromRelease: "v0.3.13-experiment.iflytek.20261017.7",
            maxSchema: 29,
            migrationPlanDigest: null,
            minSchema: 29,
            targetSchema: 29,
          },
        ],
      },
      manifestDigest:
        "sha256:d7d56dc0dcbe478beb209a2b54e8626a965cde0f6883c54948969eb090da3802",
      signature: {
        algorithm: "Ed25519",
        keyId: "qualification-iflytek-20261017-r1-publisher",
        value:
          "+sQ8onQqERp3+kPIQdZEMWl8xd1ton0vULwHgNT+JRlK4Lznkccq1GdRp0ETJqHZQz7wFT8k1fJpjpzCfWjqBQ==",
      },
    },
  },
  {
    packageDigest:
      "sha256:d39cb24a99f8104530caa01f13e90c50038409ed93abcdf328c89709f44af7b9",
    manifestDigest:
      "sha256:0213625ba97a5b21346593e44adf916f84c89224263b7d797175cb7bdd64788c",
    envelope: {
      manifest: {
        channel: "experiment-iflytek-online-20261017-r1",
        commits: {
          api: "412b101344a7931dd4a8b823c5b08d250f2fd260",
          project: "7c6845d1f7f5f9c90915dc81ab5e6e9aa729a84e",
          web: "1593f5edf0429cb36f00e87eda26214bd84cd5da",
        },
        components: {
          api: {
            artifactDigest:
              "sha256:8e3a5205e69b4f8784feabe7036bfa09fc5bb971a23a982ab71d3f99ba311b9b",
            inputFingerprint:
              "sha256:95736844d851955a995485f8164f601c73e218dc2435b73efd8c55024c3cc03a",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "412b101344a7931dd4a8b823c5b08d250f2fd260",
          },
          coordinator: {
            artifactDigest:
              "sha256:8e3a5205e69b4f8784feabe7036bfa09fc5bb971a23a982ab71d3f99ba311b9b",
            dataFormats: ["project-name-v2-authority"],
            inputFingerprint:
              "sha256:95736844d851955a995485f8164f601c73e218dc2435b73efd8c55024c3cc03a",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "412b101344a7931dd4a8b823c5b08d250f2fd260",
            upgradeOperationFormats: ["upgrade-plan-v1"],
          },
          installer: {
            artifactDigest:
              "sha256:3ef2b626e5fc52dcaad5cb4f01bfdd73a1ece77e9d8804b2a60d87faa934c890",
            inputFingerprint:
              "sha256:3ef2b626e5fc52dcaad5cb4f01bfdd73a1ece77e9d8804b2a60d87faa934c890",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "7c6845d1f7f5f9c90915dc81ab5e6e9aa729a84e",
          },
          owner: {
            artifactDigest:
              "sha256:8e3a5205e69b4f8784feabe7036bfa09fc5bb971a23a982ab71d3f99ba311b9b",
            inputFingerprint:
              "sha256:95736844d851955a995485f8164f601c73e218dc2435b73efd8c55024c3cc03a",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "412b101344a7931dd4a8b823c5b08d250f2fd260",
          },
          web: {
            artifactDigest:
              "sha256:2fd73c39697c9581ff640350d6dec031c9ecd1248715cf94ff19e93609f79b3c",
            inputFingerprint:
              "sha256:dd3d233bad91dd304b4e8d56634baed545c60af4a2a5fc0c19d4fa843811e082",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "1593f5edf0429cb36f00e87eda26214bd84cd5da",
            webRevision: "dd3d233bad91dd304b4e8d56634baed545c60af4",
          },
        },
        evidence: [
          {
            inputFingerprint:
              "sha256:5939cfa922f3ca665b2ecb10c6525248da64a5ddcb460bdb6a79e83bf30abf65",
            kind: "build",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T16:12:18.935Z",
            reportDigest:
              "sha256:3c24568b9b1e595959f3b4509ff8b0d0883a0f28c637edffb2fd29a66ccdaf6d",
            result: "not-run",
            runId: "architecture-iflytek-20261018-r3",
          },
          {
            inputFingerprint:
              "sha256:5939cfa922f3ca665b2ecb10c6525248da64a5ddcb460bdb6a79e83bf30abf65",
            kind: "contracts",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T16:12:18.942Z",
            reportDigest:
              "sha256:238d9d853e083f354a36c7d07b615486bd6b255ffbd95453fe9b32f8035f9d30",
            result: "not-run",
            runId: "architecture-iflytek-20261018-r3",
          },
          {
            inputFingerprint:
              "sha256:5939cfa922f3ca665b2ecb10c6525248da64a5ddcb460bdb6a79e83bf30abf65",
            kind: "four-combinations",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T16:12:18.949Z",
            reportDigest:
              "sha256:6ad9d2f5e874eb33e63af5093e5409831e842b6d39b7e66c853912e31e3edfa8",
            result: "not-run",
            runId: "architecture-iflytek-20261018-r3",
          },
          {
            inputFingerprint:
              "sha256:5939cfa922f3ca665b2ecb10c6525248da64a5ddcb460bdb6a79e83bf30abf65",
            kind: "native-continuity",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T16:12:18.955Z",
            reportDigest:
              "sha256:b1b85b127f3fa883bd0ec5bb98631781984c04752e036a0e86ae288d25096a7f",
            result: "not-run",
            runId: "architecture-iflytek-20261018-r3",
          },
          {
            inputFingerprint:
              "sha256:5939cfa922f3ca665b2ecb10c6525248da64a5ddcb460bdb6a79e83bf30abf65",
            kind: "fault-recovery",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-18T16:12:18.962Z",
            reportDigest:
              "sha256:3e3fba199dabed5dc7850dc3c27049e231dd010ac4d12431d9a0155732fb0d40",
            result: "not-run",
            runId: "architecture-iflytek-20261018-r3",
          },
        ],
        packages: [
          {
            arch: "arm64",
            bytes: 94475985,
            digest:
              "sha256:d39cb24a99f8104530caa01f13e90c50038409ed93abcdf328c89709f44af7b9",
            format: "native-tar",
            name: "agent-platform-v0.3.18-experiment.iflytek.20261018.1-linux-arm64.tgz",
            platform: "linux",
            unpackedBytes: 291525256,
            url: "https://github.com/Xeonice/cloud-agent-platform-docs/releases/download/v0.3.18-experiment.iflytek.20261018.1/agent-platform-v0.3.18-experiment.iflytek.20261018.1-linux-arm64.tgz",
          },
        ],
        policy: {
          attachDeadlineMs: 5000,
          consecutiveEvaluations: 2,
          contractInUpgrade: false,
          evaluationIntervalMs: 10000,
          fallbacks: [
            {
              apiDigest:
                "sha256:134cb845b92a2f0ac620ccffd4ba047e23f9c2a08722d3c0567fed511ffd5b49",
              rehearsed: false,
              releaseId: "v0.3.15-experiment.iflytek.20261018.2",
              webDigest:
                "sha256:db04770052a89227e49f580be7ff3c8583670f7210c640771d9775d39ab2e4db",
            },
          ],
          id: "experiment-iflytek-online-20261017-r1",
          maxWalBytes: 100000000,
          migrationBatchMs: 500,
          minFreeBytes: 500000000,
          minRequests: 100,
          observationFreshnessMs: 5000,
          p95FloorMs: 1000,
          p95Ratio: 2,
          probeHz: 10,
          requestDeadlineMs: 2000,
          restoreLiveVolume: false,
          retentionMs: 600000,
          softErrorDelta: 0.01,
          stageDurationMs: 60000,
          stopUserResources: false,
          weights: [1, 5, 25, 100],
        },
        publishedAt: "2026-10-18T16:12:18.934Z",
        purpose: "qualification",
        qualification: {
          inputFingerprint:
            "sha256:5939cfa922f3ca665b2ecb10c6525248da64a5ddcb460bdb6a79e83bf30abf65",
          instanceId: "agent-platform-iflytek-20261017-r1",
        },
        releaseId: "v0.3.18-experiment.iflytek.20261018.1",
        runInputFingerprint:
          "sha256:5939cfa922f3ca665b2ecb10c6525248da64a5ddcb460bdb6a79e83bf30abf65",
        schemaVersion: 2,
        upgradePaths: [
          {
            bridgeReleases: [],
            fromRelease: "v0.3.15-experiment.iflytek.20261018.2",
            maxSchema: 29,
            migrationPlanDigest: null,
            minSchema: 29,
            targetSchema: 29,
          },
        ],
      },
      manifestDigest:
        "sha256:0213625ba97a5b21346593e44adf916f84c89224263b7d797175cb7bdd64788c",
      signature: {
        algorithm: "Ed25519",
        keyId: "qualification-iflytek-20261017-r1-publisher",
        value:
          "LEbbyhfPGwpVe9PYtxMuV86wnmBxXT39DPHCv+c7RQvQkQwOntZ0b5zIkeWQ3+50put6shuuKuWJglmqG283DQ==",
      },
    },
  },
  {
    packageDigest:
      "sha256:cf93f254fc921ba0d59d79d30fec81e8bff1a073975f2e592bff8cc5b4161c7b",
    manifestDigest:
      "sha256:29b903b819bdeacd218895e807694e8f568a8dad605a02bcceb286676dcb9737",
    envelope: {
      manifest: {
        channel: "experiment-iflytek-online-20261017-r1",
        commits: {
          api: "e36d5f47960625fc6dc24e6c4da4b91bce6facd0",
          project: "cf166cbf5570d177e1b2e40156114694de8e3909",
          web: "1593f5edf0429cb36f00e87eda26214bd84cd5da",
        },
        components: {
          api: {
            artifactDigest:
              "sha256:5f33d31d4fc6b208e343ea20a8f71c56069173d24c9590c806d0dab82972a22a",
            inputFingerprint:
              "sha256:5924159e99b20f9e1d1a9bbc38c0d4eb285e8696d2ae2810e4fe9bf84d430f05",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "e36d5f47960625fc6dc24e6c4da4b91bce6facd0",
          },
          coordinator: {
            artifactDigest:
              "sha256:5f33d31d4fc6b208e343ea20a8f71c56069173d24c9590c806d0dab82972a22a",
            dataFormats: ["project-name-v2-authority"],
            inputFingerprint:
              "sha256:5924159e99b20f9e1d1a9bbc38c0d4eb285e8696d2ae2810e4fe9bf84d430f05",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "e36d5f47960625fc6dc24e6c4da4b91bce6facd0",
            upgradeOperationFormats: ["upgrade-plan-v1"],
          },
          installer: {
            artifactDigest:
              "sha256:3ef2b626e5fc52dcaad5cb4f01bfdd73a1ece77e9d8804b2a60d87faa934c890",
            inputFingerprint:
              "sha256:3ef2b626e5fc52dcaad5cb4f01bfdd73a1ece77e9d8804b2a60d87faa934c890",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "cf166cbf5570d177e1b2e40156114694de8e3909",
          },
          owner: {
            artifactDigest:
              "sha256:5f33d31d4fc6b208e343ea20a8f71c56069173d24c9590c806d0dab82972a22a",
            inputFingerprint:
              "sha256:5924159e99b20f9e1d1a9bbc38c0d4eb285e8696d2ae2810e4fe9bf84d430f05",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "e36d5f47960625fc6dc24e6c4da4b91bce6facd0",
          },
          web: {
            artifactDigest:
              "sha256:2fd73c39697c9581ff640350d6dec031c9ecd1248715cf94ff19e93609f79b3c",
            inputFingerprint:
              "sha256:dd3d233bad91dd304b4e8d56634baed545c60af4a2a5fc0c19d4fa843811e082",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "1593f5edf0429cb36f00e87eda26214bd84cd5da",
            webRevision: "dd3d233bad91dd304b4e8d56634baed545c60af4",
          },
        },
        evidence: [
          {
            inputFingerprint:
              "sha256:3d742d7ef591eedd7efa517ab213a66e7aea6f7e6e2aa66600eea6b26d23c79b",
            kind: "build",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T11:24:24.947Z",
            reportDigest:
              "sha256:a1344def5403d1078f26cd738b1a0801d458ea79bb0ba31e015409c957cc6be8",
            result: "not-run",
            runId: "fd-limit-iflytek-20261019-r1",
          },
          {
            inputFingerprint:
              "sha256:3d742d7ef591eedd7efa517ab213a66e7aea6f7e6e2aa66600eea6b26d23c79b",
            kind: "contracts",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T11:24:24.959Z",
            reportDigest:
              "sha256:b5c9cb0ce5d0c729d83f8510ff9f83b769f001fb5ac93464ce9f237a4f580b28",
            result: "not-run",
            runId: "fd-limit-iflytek-20261019-r1",
          },
          {
            inputFingerprint:
              "sha256:3d742d7ef591eedd7efa517ab213a66e7aea6f7e6e2aa66600eea6b26d23c79b",
            kind: "four-combinations",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T11:24:24.967Z",
            reportDigest:
              "sha256:709bb6ee5170b31439405483fcbdb4a3f00b149aea45d225cc37377cc81d19f7",
            result: "not-run",
            runId: "fd-limit-iflytek-20261019-r1",
          },
          {
            inputFingerprint:
              "sha256:3d742d7ef591eedd7efa517ab213a66e7aea6f7e6e2aa66600eea6b26d23c79b",
            kind: "native-continuity",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T11:24:24.975Z",
            reportDigest:
              "sha256:d67ceffc9468fff6fc36c24d6567985f3fd2b30aa577868669e54def82696bbb",
            result: "not-run",
            runId: "fd-limit-iflytek-20261019-r1",
          },
          {
            inputFingerprint:
              "sha256:3d742d7ef591eedd7efa517ab213a66e7aea6f7e6e2aa66600eea6b26d23c79b",
            kind: "fault-recovery",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T11:24:24.983Z",
            reportDigest:
              "sha256:bc379d76e0c90a338d5c69fa3cf54757ba24bcc5d0b8504ed4fdeb1749569e65",
            result: "not-run",
            runId: "fd-limit-iflytek-20261019-r1",
          },
        ],
        packages: [
          {
            arch: "arm64",
            bytes: 94473068,
            digest:
              "sha256:cf93f254fc921ba0d59d79d30fec81e8bff1a073975f2e592bff8cc5b4161c7b",
            format: "native-tar",
            name: "agent-platform-v0.3.19-experiment.iflytek.20261019.1-linux-arm64.tgz",
            platform: "linux",
            unpackedBytes: 291524326,
            url: "https://github.com/Xeonice/cloud-agent-platform-docs/releases/download/v0.3.19-experiment.iflytek.20261019.1/agent-platform-v0.3.19-experiment.iflytek.20261019.1-linux-arm64.tgz",
          },
        ],
        policy: {
          attachDeadlineMs: 5000,
          consecutiveEvaluations: 2,
          contractInUpgrade: false,
          evaluationIntervalMs: 10000,
          fallbacks: [
            {
              apiDigest:
                "sha256:8e3a5205e69b4f8784feabe7036bfa09fc5bb971a23a982ab71d3f99ba311b9b",
              rehearsed: false,
              releaseId: "v0.3.18-experiment.iflytek.20261018.1",
              webDigest:
                "sha256:2fd73c39697c9581ff640350d6dec031c9ecd1248715cf94ff19e93609f79b3c",
            },
          ],
          id: "experiment-iflytek-online-20261017-r1",
          maxWalBytes: 100000000,
          migrationBatchMs: 500,
          minFreeBytes: 500000000,
          minRequests: 100,
          observationFreshnessMs: 5000,
          p95FloorMs: 1000,
          p95Ratio: 2,
          probeHz: 10,
          requestDeadlineMs: 2000,
          restoreLiveVolume: false,
          retentionMs: 600000,
          softErrorDelta: 0.01,
          stageDurationMs: 60000,
          stopUserResources: false,
          weights: [1, 5, 25, 100],
        },
        publishedAt: "2026-10-19T11:24:24.946Z",
        purpose: "qualification",
        qualification: {
          inputFingerprint:
            "sha256:3d742d7ef591eedd7efa517ab213a66e7aea6f7e6e2aa66600eea6b26d23c79b",
          instanceId: "agent-platform-iflytek-20261017-r1",
        },
        releaseId: "v0.3.19-experiment.iflytek.20261019.1",
        runInputFingerprint:
          "sha256:3d742d7ef591eedd7efa517ab213a66e7aea6f7e6e2aa66600eea6b26d23c79b",
        schemaVersion: 2,
        upgradePaths: [
          {
            bridgeReleases: [],
            fromRelease: "v0.3.18-experiment.iflytek.20261018.1",
            maxSchema: 29,
            migrationPlanDigest: null,
            minSchema: 29,
            targetSchema: 29,
          },
        ],
      },
      manifestDigest:
        "sha256:29b903b819bdeacd218895e807694e8f568a8dad605a02bcceb286676dcb9737",
      signature: {
        algorithm: "Ed25519",
        keyId: "qualification-iflytek-20261017-r1-publisher",
        value:
          "j+UZuee7/OfDO8er9odKHJRxKSJ/QFnViR3bCDlGYgNU2mH4e9ueqVctTcLWd90B+10LYPS21X348aHg0cMwAA==",
      },
    },
  },
  {
    packageDigest:
      "sha256:5a793879f466c32ddafd291c9d3388fa1bb7bfcc38594b8330828f4222cea786",
    manifestDigest:
      "sha256:52480cc20321925e30013b2d0144800b446dcc8316e0fbb7bdc51d790c259da3",
    envelope: {
      manifest: {
        channel: "experiment-iflytek-online-20261017-r1",
        commits: {
          api: "90f969b4fa5e7f86ba68270af740bdad3d8103b5",
          project: "eb0a597bc29382a6c8e52891e8bcb40afafd0b48",
          web: "1593f5edf0429cb36f00e87eda26214bd84cd5da",
        },
        components: {
          api: {
            artifactDigest:
              "sha256:325b28c7daeca56fb30ac9e17037ef8e92eb9d484bb93912ebc0e285111700cb",
            inputFingerprint:
              "sha256:945a02ddb4c7126a04cc7ae0dca2d82e4c968a346e8115570395eb537a47551d",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "90f969b4fa5e7f86ba68270af740bdad3d8103b5",
          },
          coordinator: {
            artifactDigest:
              "sha256:325b28c7daeca56fb30ac9e17037ef8e92eb9d484bb93912ebc0e285111700cb",
            dataFormats: ["project-name-v2-authority"],
            inputFingerprint:
              "sha256:945a02ddb4c7126a04cc7ae0dca2d82e4c968a346e8115570395eb537a47551d",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "90f969b4fa5e7f86ba68270af740bdad3d8103b5",
            upgradeOperationFormats: ["upgrade-plan-v1"],
          },
          installer: {
            artifactDigest:
              "sha256:859e0b3b275f5afe19663e762e8e3bf234982c556c09bcc6b6bdcde39df7c6b8",
            inputFingerprint:
              "sha256:859e0b3b275f5afe19663e762e8e3bf234982c556c09bcc6b6bdcde39df7c6b8",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "eb0a597bc29382a6c8e52891e8bcb40afafd0b48",
          },
          owner: {
            artifactDigest:
              "sha256:325b28c7daeca56fb30ac9e17037ef8e92eb9d484bb93912ebc0e285111700cb",
            inputFingerprint:
              "sha256:945a02ddb4c7126a04cc7ae0dca2d82e4c968a346e8115570395eb537a47551d",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "90f969b4fa5e7f86ba68270af740bdad3d8103b5",
          },
          web: {
            artifactDigest:
              "sha256:2fd73c39697c9581ff640350d6dec031c9ecd1248715cf94ff19e93609f79b3c",
            inputFingerprint:
              "sha256:dd3d233bad91dd304b4e8d56634baed545c60af4a2a5fc0c19d4fa843811e082",
            protocol: {
              max: 1,
              min: 1,
            },
            sourceRevision: "1593f5edf0429cb36f00e87eda26214bd84cd5da",
            webRevision: "dd3d233bad91dd304b4e8d56634baed545c60af4",
          },
        },
        evidence: [
          {
            inputFingerprint:
              "sha256:8ef946122baa37af9ff24af51316adc80d2f2b56de4a133213633f202d5274d4",
            kind: "build",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T13:31:22.929Z",
            reportDigest:
              "sha256:0b89d150fec30b84587fc8d5010a6c8cde5e9d2788c0b9acb652d09d4428b95b",
            result: "not-run",
            runId: "upgrade-proof-fix-iflytek-20261019-r1",
          },
          {
            inputFingerprint:
              "sha256:8ef946122baa37af9ff24af51316adc80d2f2b56de4a133213633f202d5274d4",
            kind: "contracts",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T13:31:22.938Z",
            reportDigest:
              "sha256:e3368f3a42c3813331e470a50a0e6d46c374d0d52e457bc54a281ddee321a241",
            result: "not-run",
            runId: "upgrade-proof-fix-iflytek-20261019-r1",
          },
          {
            inputFingerprint:
              "sha256:8ef946122baa37af9ff24af51316adc80d2f2b56de4a133213633f202d5274d4",
            kind: "four-combinations",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T13:31:22.956Z",
            reportDigest:
              "sha256:ef100d914ddb8510525684aca69b79716a8963e4a2c6b5c44edf0b7f10728f3f",
            result: "not-run",
            runId: "upgrade-proof-fix-iflytek-20261019-r1",
          },
          {
            inputFingerprint:
              "sha256:8ef946122baa37af9ff24af51316adc80d2f2b56de4a133213633f202d5274d4",
            kind: "native-continuity",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T13:31:22.969Z",
            reportDigest:
              "sha256:65f415519ac86a3f9a9bf8eae80ffd1ad2fc40afee739a3fce5268ee56f9e2ed",
            result: "not-run",
            runId: "upgrade-proof-fix-iflytek-20261019-r1",
          },
          {
            inputFingerprint:
              "sha256:8ef946122baa37af9ff24af51316adc80d2f2b56de4a133213633f202d5274d4",
            kind: "fault-recovery",
            reason:
              "The complete formal qualification gate for these exact inputs has not run. Actual native build, dependency probes and limited rehearsal are recorded separately without claiming the full gate.",
            recordedAt: "2026-10-19T13:31:22.976Z",
            reportDigest:
              "sha256:539f6e96a5d31b1d68670f14b3b4bdc7fa2a1a431d6a12e1cbfe76edc17bdbaf",
            result: "not-run",
            runId: "upgrade-proof-fix-iflytek-20261019-r1",
          },
        ],
        packages: [
          {
            arch: "arm64",
            bytes: 94477057,
            digest:
              "sha256:5a793879f466c32ddafd291c9d3388fa1bb7bfcc38594b8330828f4222cea786",
            format: "native-tar",
            name: "agent-platform-v0.3.20-experiment.iflytek.20261019.2-linux-arm64.tgz",
            platform: "linux",
            unpackedBytes: 291530082,
            url: "https://github.com/Xeonice/cloud-agent-platform-docs/releases/download/v0.3.20-experiment.iflytek.20261019.2/agent-platform-v0.3.20-experiment.iflytek.20261019.2-linux-arm64.tgz",
          },
        ],
        policy: {
          attachDeadlineMs: 5000,
          consecutiveEvaluations: 2,
          contractInUpgrade: false,
          evaluationIntervalMs: 10000,
          fallbacks: [
            {
              apiDigest:
                "sha256:8e3a5205e69b4f8784feabe7036bfa09fc5bb971a23a982ab71d3f99ba311b9b",
              rehearsed: false,
              releaseId: "v0.3.18-experiment.iflytek.20261018.1",
              webDigest:
                "sha256:2fd73c39697c9581ff640350d6dec031c9ecd1248715cf94ff19e93609f79b3c",
            },
          ],
          id: "experiment-iflytek-online-20261017-r1",
          maxWalBytes: 100000000,
          migrationBatchMs: 500,
          minFreeBytes: 500000000,
          minRequests: 100,
          observationFreshnessMs: 5000,
          p95FloorMs: 1000,
          p95Ratio: 2,
          probeHz: 10,
          requestDeadlineMs: 2000,
          restoreLiveVolume: false,
          retentionMs: 600000,
          softErrorDelta: 0.01,
          stageDurationMs: 60000,
          stopUserResources: false,
          weights: [1, 5, 25, 100],
        },
        publishedAt: "2026-10-19T13:31:22.928Z",
        purpose: "qualification",
        qualification: {
          inputFingerprint:
            "sha256:8ef946122baa37af9ff24af51316adc80d2f2b56de4a133213633f202d5274d4",
          instanceId: "agent-platform-iflytek-20261017-r1",
        },
        releaseId: "v0.3.20-experiment.iflytek.20261019.2",
        runInputFingerprint:
          "sha256:8ef946122baa37af9ff24af51316adc80d2f2b56de4a133213633f202d5274d4",
        schemaVersion: 2,
        upgradePaths: [
          {
            bridgeReleases: [],
            fromRelease: "v0.3.18-experiment.iflytek.20261018.1",
            maxSchema: 29,
            migrationPlanDigest: null,
            minSchema: 29,
            targetSchema: 29,
          },
        ],
      },
      manifestDigest:
        "sha256:52480cc20321925e30013b2d0144800b446dcc8316e0fbb7bdc51d790c259da3",
      signature: {
        algorithm: "Ed25519",
        keyId: "qualification-iflytek-20261017-r1-publisher",
        value:
          "NYF6ka+YtdYMu0dZSJs0s3AgUSAqi2Ep5qvEWrtTgAXPrm2Cy31Phx9/VCCxYkilNki6PT1kDr8BMtNia+6vAw==",
      },
    },
  },
];
const HISTORICAL_IDENTITIES = [
  {
    containerId:
      "ba2d5d0e3f91ab7eb6b2dcc6f30fae4c687bae490b028843e14311c05d26f96a",
    startIdentity: "47b76368-8ef7-440f-b4cc-6115f18299e6",
    artifactDigest:
      "sha256:859637eac6a1f7245b64a5dda9e8ab1c86f5326e3f0c496e0a135c35896d6337",
    packageDigest:
      "sha256:e5d6960cd1323a184deb9d894ac5ca3c94c50c72b9cda3c188d39af6e923171b",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 1,
      FinishedAt: "2026-10-17T18:23:15.20181918Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-17T08:21:05.788668134Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
  {
    containerId:
      "e749a5fe3cb577c7f0419e3f3454017714579a1acd7839f3724a9c44462cee15",
    startIdentity: "c44f0568-725d-43f7-9235-6307e79979ef",
    artifactDigest:
      "sha256:134cb845b92a2f0ac620ccffd4ba047e23f9c2a08722d3c0567fed511ffd5b49",
    packageDigest:
      "sha256:eca395c48609fc7e8328c3116f6ccdc05dd3d3eac8412a5badd0921e01548bd1",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 0,
      FinishedAt: "2026-10-20T18:26:16.101035502Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-18T09:22:49.986939146Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
  {
    containerId:
      "8625b37a09c18e4fb098f47651c5b63c7a4de78c8fcd159ff2c59a2d6a77f063",
    startIdentity: "351fa832-2c45-423f-94e0-e90ebe925683",
    artifactDigest:
      "sha256:c9006d95758784ca6db98b7f9a1faefb350e664ae4bec01073b9dc01f906dd42",
    packageDigest:
      "sha256:0e35c1047dbdf7bea75a2753a61568cd04dd9245de3afce2dd7795176d293816",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 0,
      FinishedAt: "2026-10-19T12:42:07.345666986Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-17T18:33:12.486802035Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
  {
    containerId:
      "2b1911b429f02ab15c7feef42f99484d1c7fc1fd5ccc4f4dda095ade17669bae",
    startIdentity: "944fdc69-309f-4ee8-b4b9-42dabe08d38d",
    artifactDigest:
      "sha256:5f33d31d4fc6b208e343ea20a8f71c56069173d24c9590c806d0dab82972a22a",
    packageDigest:
      "sha256:cf93f254fc921ba0d59d79d30fec81e8bff1a073975f2e592bff8cc5b4161c7b",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 0,
      FinishedAt: "2026-10-20T18:04:50.092013068Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-19T12:14:54.651267777Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
  {
    containerId:
      "2d6197e7f9c0b48965f5023b2919f32732552b73bbdac9ff8283045d9bad6dff",
    startIdentity: "9a4da027-810c-41bb-9c78-2bb92ddf41e4",
    artifactDigest:
      "sha256:5f33d31d4fc6b208e343ea20a8f71c56069173d24c9590c806d0dab82972a22a",
    packageDigest:
      "sha256:cf93f254fc921ba0d59d79d30fec81e8bff1a073975f2e592bff8cc5b4161c7b",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 0,
      FinishedAt: "2026-10-19T11:49:48.056049762Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-19T11:32:43.973041406Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
  {
    containerId:
      "db8cca1ee371689fa60987f8bcbaf31bda2b800c9b86dca3f27c454c12c144e9",
    startIdentity: "81a1d243-04f8-4908-b608-670771d960df",
    artifactDigest:
      "sha256:325b28c7daeca56fb30ac9e17037ef8e92eb9d484bb93912ebc0e285111700cb",
    packageDigest:
      "sha256:5a793879f466c32ddafd291c9d3388fa1bb7bfcc38594b8330828f4222cea786",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 0,
      FinishedAt: "2026-10-20T18:26:26.377147749Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-19T15:22:17.908610864Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
  {
    containerId:
      "ebbb6aa03f037b6ed6c66194ab59880507070b30e63f718569e9097a196a4b8d",
    startIdentity: "cd718c04-87c2-4a04-a55f-4462e8dbf54b",
    artifactDigest:
      "sha256:8e3a5205e69b4f8784feabe7036bfa09fc5bb971a23a982ab71d3f99ba311b9b",
    packageDigest:
      "sha256:d39cb24a99f8104530caa01f13e90c50038409ed93abcdf328c89709f44af7b9",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 0,
      FinishedAt: "2026-10-20T18:26:05.850454559Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-18T16:42:55.458805278Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
  {
    containerId:
      "157218962c313ed37231b80f5dd454ca518e76d5dfc39540f43ea439e22dfad3",
    startIdentity: "40a4339c-661e-4a02-a99c-2be4b51e62e6",
    artifactDigest:
      "sha256:5f33d31d4fc6b208e343ea20a8f71c56069173d24c9590c806d0dab82972a22a",
    packageDigest:
      "sha256:cf93f254fc921ba0d59d79d30fec81e8bff1a073975f2e592bff8cc5b4161c7b",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 0,
      FinishedAt: "2026-10-19T12:10:44.112738928Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-19T11:55:40.023149823Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
  {
    containerId:
      "921c85e370737ec6dfd18cf31faf0a1046df693da520e8b80eddd60fa297bf23",
    startIdentity: "291a9cef-13d8-45b9-8f1d-f3a37aedb58b",
    artifactDigest:
      "sha256:134cb845b92a2f0ac620ccffd4ba047e23f9c2a08722d3c0567fed511ffd5b49",
    packageDigest:
      "sha256:eca395c48609fc7e8328c3116f6ccdc05dd3d3eac8412a5badd0921e01548bd1",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 0,
      FinishedAt: "2026-10-18T09:22:21.317513504Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-18T08:11:27.967167411Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
  {
    containerId:
      "95649905b33ebefccdaf2e806def70bda112ff9264ce4c7cf60b25bed14f9187",
    startIdentity: "11a605dc-72b6-4211-b0ae-35b4f700a691",
    artifactDigest:
      "sha256:d009218239e389a4d78d02cef503a97fcbcb7d9a9e887485829432fe03e07de4",
    packageDigest:
      "sha256:00ef2fcf69aa226c4c5d4ad9b19938bab55dfc3999452081f4c9707126246d15",
    State: {
      Dead: false,
      Error: "",
      ExitCode: 0,
      FinishedAt: "2026-10-19T12:45:28.564668839Z",
      OOMKilled: false,
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-10-17T18:21:54.941725969Z",
      Status: "exited",
    },
    restartCount: 0,
    restartPolicy: {
      MaximumRetryCount: 0,
      Name: "no",
    },
  },
];

const rawDigest = (value) =>
  "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");
function expectedProjection(row) {
  return {
    instanceId: row.Config.Labels["agent-platform.instance"],
    declaredEnvArtifactDigest: row.Config.Env.find((x) =>
      x.startsWith("PLATFORM_ARTIFACT_DIGEST="),
    )
      .split("=")
      .slice(1)
      .join("="),
    environmentDigest: rawDigest(row.Config.Env),
    commandDigest: rawDigest({
      entrypoint: row.Config.Entrypoint,
      command: row.Config.Cmd,
      cwd: row.Config.WorkingDir,
    }),
    mountDigest: rawDigest(
      row.Mounts.map((m) => ({
        source: m.Source,
        destination: m.Destination,
        rw: m.RW,
      })).sort((a, b) => a.destination.localeCompare(b.destination)),
    ),
    dead: row.State.Dead,
    restarting: row.State.Restarting,
    stateErrorEmpty: row.State.Error === "",
  };
}
function reseal(receipt) {
  const { receiptDigest, ...facts } = receipt;
  return { ...facts, receiptDigest: rawDigest(facts) };
}
function fixture(index = 0) {
  const h = structuredClone(HISTORICAL_IDENTITIES[index]),
    signed = SIGNED_PACKAGES.find((p) => p.packageDigest === h.packageDigest);
  const artifactRoot = "/test-artifacts/" + h.packageDigest.slice(7),
    imageDigest =
      "sha256:646f487a009967c0f2c29cb304ab1c58d775416d40ce7cfbd91e6f5b4af744f7";
  const row = {
    Id: h.containerId,
    Image: imageDigest,
    Config: {
      Labels: {
        "agent-platform.instance": INSTANCE,
        "agent-platform.role": "coordinator",
        "agent-platform.start": h.startIdentity,
      },
      Env: [
        "PLATFORM_PROCESS_ROLE=coordinator",
        "PLATFORM_PROCESS_START_IDENTITY=" + h.startIdentity,
        "PLATFORM_ARTIFACT_DIGEST=" + h.artifactDigest,
        "TEST_SECRET=must-not-leave-projection",
      ],
      Entrypoint: ["node"],
      Cmd: [artifactRoot + "/api/apps/api/dist/roles/coordinator-main.js"],
      WorkingDir: artifactRoot,
    },
    Mounts: [
      {
        Type: "bind",
        Source: artifactRoot,
        Destination: artifactRoot,
        RW: false,
        Mode: "ro",
        Propagation: "rprivate",
      },
      {
        Type: "bind",
        Source: "/test-data",
        Destination: "/data",
        RW: true,
        Mode: "rw",
        Propagation: "rprivate",
      },
    ],
    State: h.State,
    RestartCount: h.restartCount,
    HostConfig: { RestartPolicy: h.restartPolicy },
  };
  const proof = expectedProjection(row),
    record = {
      instanceId: INSTANCE,
      kind: "coordinator",
      containerId: h.containerId,
      startIdentity: h.startIdentity,
      artifactDigest: h.artifactDigest,
    };
  const physical = {
    instanceId: INSTANCE,
    role: "coordinator",
    containerId: h.containerId,
    startIdentity: h.startIdentity,
    artifactDigest: null,
    imageDigest,
    startedAt: h.State.StartedAt,
    finishedAt: h.State.FinishedAt,
    running: h.State.Running,
    hostPid: h.State.Pid,
    paused: h.State.Paused,
    restartPolicy: h.restartPolicy.Name,
    restartCount: h.restartCount,
    oomKilled: h.State.OOMKilled,
    exitCode: h.State.ExitCode,
    mounts: row.Mounts.map((m) => ({
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      rw: m.RW,
    })),
    legacyInertProof: proof,
  };
  const receipt = reseal({
    schemaVersion: 1,
    kind: "legacy-coordinator-inert-history",
    instanceId: INSTANCE,
    recordedAt: new Date(NOW - 1000).toISOString(),
    target: {
      containerId: h.containerId,
      startIdentity: h.startIdentity,
      artifactDigest: h.artifactDigest,
      artifactRoot,
      imageDigest,
      startedAt: h.State.StartedAt,
      finishedAt: h.State.FinishedAt,
      restartCount: h.restartCount,
      exitCode: h.State.ExitCode,
    },
    proof,
    signedManifest: structuredClone(signed.envelope),
    manifestDigest: signed.manifestDigest,
    packageDigest: h.packageDigest,
  });
  return { row, record, physical, receipt, roots: structuredClone(ROOTS) };
}
function verify(f) {
  return verifyLegacyCoordinatorInertHistory(f.receipt, {
    instanceId: INSTANCE,
    record: f.record,
    physical: f.physical,
    roots: f.roots,
    now: NOW,
  });
}

test("seven original old envelopes verify under the actual current instance public trust root", () => {
  assert.equal(
    rawDigest(ROOTS),
    "sha256:6827a3be8d19449c8060d3035f5e319094e5fb84702b16df7ec33a75482ef6fe",
  );
  assert.equal(SIGNED_PACKAGES.length, 7);
  for (const p of SIGNED_PACKAGES) {
    const v = verifySignedManifest(p.envelope, ROOTS, NOW);
    assert.equal(v.manifestDigest, p.manifestDigest);
    assert.equal(
      v.manifest.components.api.artifactDigest,
      v.manifest.components.coordinator.artifactDigest,
    );
    assert.ok(v.manifest.packages.some((x) => x.digest === p.packageDigest));
  }
});

test("ten observed old Coordinator identities including exit 1 are inert history, never invented normal exits or authenticated Docker artifact labels", () => {
  assert.equal(HISTORICAL_IDENTITIES.length, 10);
  assert.ok(HISTORICAL_IDENTITIES.some((h) => h.State.ExitCode === 1));
  for (let i = 0; i < 10; i++) {
    const f = fixture(i),
      proof = verify(f);
    assert.equal(proof.kind, "legacy-coordinator-inert-history");
    assert.equal(
      proof.target.exitCode,
      HISTORICAL_IDENTITIES[i].State.ExitCode,
    );
    assert.equal(proof.recordedAt, f.receipt.recordedAt);
    assert.equal(proof.observedAt, new Date(NOW).toISOString());
    assert.equal(f.physical.artifactDigest, null);
    assert.equal(
      validateCoordinatorExitReceipt(f.receipt, {
        instanceId: INSTANCE,
        target: f.physical,
        now: NOW,
      }),
      false,
    );
    assert.equal(Object.hasOwn(proof, "normalExit"), false);
    assert.equal(Object.hasOwn(proof, "writerFenceValid"), false);
  }
});

test("Docker projection hashes full actual Env, command and mount tuple without returning raw environment values", () => {
  const f = fixture(),
    actual = projectLegacyCoordinatorInertHistory(f.row);
  assert.deepEqual(actual, expectedProjection(f.row));
  assert.equal(
    JSON.stringify(actual).includes("must-not-leave-projection"),
    false,
  );
  for (const change of [
    (r) => r.Config.Env.push("SOME_FLAG=changed"),
    (r) => r.Config.Cmd.push("--changed"),
    (r) => (r.Config.Entrypoint = ["sh"]),
    (r) => (r.Config.WorkingDir = "/elsewhere"),
    (r) => (r.Mounts[1].RW = false),
    (r) => (r.Mounts[1].Source = "/other-data"),
  ]) {
    const next = structuredClone(f.row);
    change(next);
    assert.notDeepEqual(projectLegacyCoordinatorInertHistory(next), actual);
  }
  const reordered = structuredClone(f.row);
  reordered.Mounts.reverse();
  assert.deepEqual(projectLegacyCoordinatorInertHistory(reordered), actual);
});

test("current artifact labels, wrong roles, live processes and duplicate artifact declarations cannot opt into legacy projection", () => {
  for (const change of [
    (r) =>
      (r.Config.Labels["agent-platform.artifact"] = r.Config.Env[2].slice(
        "PLATFORM_ARTIFACT_DIGEST=".length,
      )),
    (r) => (r.Config.Labels["agent-platform.artifact"] = ""),
    (r) => (r.Config.Labels["agent-platform.role"] = "owner"),
    (r) => (r.State.Running = true),
    (r) => r.Config.Env.push(r.Config.Env[2]),
    (r) =>
      (r.Config.Env = r.Config.Env.filter(
        (x) => !x.startsWith("PLATFORM_ARTIFACT_DIGEST="),
      )),
  ]) {
    const f = fixture();
    change(f.row);
    assert.equal(projectLegacyCoordinatorInertHistory(f.row), null);
  }
});

test("running, PID, pause, restart, OOM, exit, birth, image and identity drift are rejected despite a valid signed receipt", () => {
  const attacks = {
    running: (p) => (p.running = true),
    pid: (p) => (p.hostPid = 10),
    paused: (p) => (p.paused = true),
    restartPolicy: (p) => (p.restartPolicy = "always"),
    restartCount: (p) => (p.restartCount = 1),
    oom: (p) => (p.oomKilled = true),
    exit: (p) => (p.exitCode = 255),
    finished: (p) => (p.finishedAt = new Date(NOW - 10).toISOString()),
    birth: (p) => (p.startedAt = new Date(NOW - 2000).toISOString()),
    image: (p) => (p.imageDigest = digest("other-image")),
    cid: (p) => (p.containerId = "f".repeat(64)),
    start: (p) => (p.startIdentity = "other-start-identity"),
    role: (p) => (p.role = "owner"),
    label: (p) =>
      (p.artifactDigest = p.legacyInertProof.declaredEnvArtifactDigest),
  };
  for (const [name, change] of Object.entries(attacks)) {
    const f = fixture();
    change(f.physical);
    assert.throws(() => verify(f), undefined, name);
  }
});

test("actual immutable tuple drift and missing or writable code mount cannot be hidden by a retained record", () => {
  for (const field of [
    "environmentDigest",
    "commandDigest",
    "mountDigest",
    "declaredEnvArtifactDigest",
    "instanceId",
  ]) {
    const f = fixture();
    f.physical.legacyInertProof = {
      ...f.physical.legacyInertProof,
      [field]: field === "instanceId" ? "other-instance" : digest("changed"),
    };
    assert.throws(() => verify(f), undefined, field);
  }
  for (const field of ["dead", "restarting", "stateErrorEmpty"]) {
    const f = fixture();
    f.physical.legacyInertProof = {
      ...f.physical.legacyInertProof,
      [field]: !f.physical.legacyInertProof[field],
    };
    assert.throws(() => verify(f), undefined, field);
  }
  for (const change of [
    (p) => (p.mounts = []),
    (p) => (p.mounts[0].rw = true),
    (p) => (p.mounts[0].destination = "/wrong"),
    (p) => (p.mounts[0].type = "volume"),
  ]) {
    const f = fixture();
    change(f.physical);
    assert.throws(() => verify(f));
  }
});

test("receipt semantics remain binding after an attacker recomputes its unsigned checksum", () => {
  const attacks = {
    kind: (r) => (r.kind = "coordinator-normal-exit"),
    instance: (r) => (r.instanceId = "other"),
    future: (r) => (r.recordedAt = new Date(NOW + 1).toISOString()),
    exitBeforeStart: (r) => (r.target.finishedAt = r.target.startedAt),
    invalidExit: (r) => (r.target.exitCode = 256),
    relativeRoot: (r) => (r.target.artifactRoot = "relative"),
    wrongPackageRoot: (r) =>
      (r.target.artifactRoot = "/test-artifacts/" + "f".repeat(64)),
    declaredRoleHash: (r) => (r.target.artifactDigest = digest("other-api")),
    unknownTopField: (r) => (r.normalExit = true),
    unknownTargetField: (r) => (r.target.normalExit = true),
    unknownProofField: (r) => (r.proof.qualified = true),
  };
  for (const [name, change] of Object.entries(attacks)) {
    const f = fixture();
    change(f.receipt);
    f.receipt = reseal(f.receipt);
    assert.throws(() => verify(f), undefined, name);
  }
  const f = fixture();
  f.record.artifactDigest = digest("unrelated-record");
  assert.throws(() => verify(f));
});

test("signature, signed manifest digest, trust and qualification scope tampering is rejected after resealing history checksum", () => {
  const attacks = [
    (f) =>
      (f.receipt.signedManifest.manifest.components.coordinator.artifactDigest =
        digest("changed")),
    (f) => (f.receipt.signedManifest.signature.value = "A".repeat(86) + "=="),
    (f) => (f.receipt.manifestDigest = digest("wrong-manifest")),
    (f) => (f.receipt.packageDigest = digest("wrong-package")),
    (f) =>
      (f.roots.keys = f.roots.keys.filter(
        (k) => k.id !== f.receipt.signedManifest.signature.keyId,
      )),
    (f) =>
      (f.roots.keys.find(
        (k) => k.id === f.receipt.signedManifest.signature.keyId,
      ).revoked = true),
    (f) => (f.roots.channel = "other"),
    (f) => (f.roots.qualificationInstanceId = "other"),
  ];
  for (const change of attacks) {
    const f = fixture();
    change(f);
    f.receipt = reseal(f.receipt);
    assert.throws(() => verify(f));
  }
});

async function inventoryFixture(t, { count = 1 } = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "legacy-inert-history-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const processRoot = join(root, "processes"),
    retiredRoot = join(root, "retired"),
    registryPath = join(root, "installed-roles.json"),
    legacyTrustRootPath = join(root, "trust.json");
  await fs.mkdir(processRoot);
  await fs.mkdir(retiredRoot);
  const fixtures = Array.from({ length: count }, (_, i) => fixture(i));
  await fs.writeFile(
    registryPath,
    JSON.stringify(fixtures.map((f) => f.record)),
    { mode: 0o600 },
  );
  await fs.writeFile(legacyTrustRootPath, JSON.stringify(ROOTS), {
    mode: 0o600,
  });
  const receiptPath = (f) =>
    join(retiredRoot, f.record.containerId + ".legacy-inert-history.json");
  for (const f of fixtures)
    await fs.writeFile(receiptPath(f), JSON.stringify(f.receipt), {
      mode: 0o600,
    });
  const calls = { inspect: 0, identity: 0 };
  let inspectAlter = async (p) => p;
  const inspect = async (id) => {
    calls.inspect++;
    const f = fixtures.find((f) => f.record.containerId === id);
    return inspectAlter(structuredClone(f.physical), calls.inspect);
  };
  const readIdentity = async () => {
    calls.identity++;
    throw Error(
      "Legacy stopped history must never invoke application or Owner work",
    );
  };
  const options = {
    instanceId: INSTANCE,
    processRoot,
    registryPath,
    retiredRoot,
    legacyTrustRootPath,
    inspect,
    readIdentity,
    clock: () => NOW,
  };
  return {
    root,
    fixtures,
    calls,
    receiptPath,
    options,
    collect: () => createCoordinatorInventory(options)(),
    setInspect: (fn) => (inspectAlter = fn),
    legacyTrustRootPath,
    registryPath,
  };
}

test("real filesystem inventory validates all ten distinct histories twice without identity RPC or normal-exit fabrication", async (t) => {
  const f = await inventoryFixture(t, { count: 10 }),
    started = performance.now(),
    result = await f.collect();
  const elapsedMs = performance.now() - started;
  assert.equal(result.complete, true);
  assert.ok(elapsedMs < 2000);
  t.diagnostic(
    JSON.stringify({
      kind: "local-synthetic-Docker-transport-real-file-and-crypto",
      histories: 10,
      elapsedMs,
      wireBytes: Buffer.byteLength(JSON.stringify(result)),
      nativeQualified: false,
    }),
  );
  assert.equal(result.coordinators.length, 10);
  assert.equal(f.calls.inspect, 20);
  assert.equal(f.calls.identity, 0);
  assert.equal(result.missing.length, 0);
  assert.ok(
    result.coordinators.every(
      (r) =>
        r.actualIdentity === undefined &&
        r.physical.artifactDigest === null &&
        r.retiredPhysical.kind === "legacy-coordinator-inert-history",
    ),
  );
  assert.ok(result.coordinators.some((r) => r.physical.exitCode === 1));
});

test("symlinked or non-private history receipt and changed current public trust root fail closed", async (t) => {
  const f = await inventoryFixture(t),
    path = f.receiptPath(f.fixtures[0]),
    copy = join(f.root, "real-receipt.json");
  await fs.rename(path, copy);
  await fs.symlink(copy, path);
  assert.equal((await f.collect()).complete, false);
  await fs.unlink(path);
  await fs.rename(copy, path);
  for (const mode of [0o644, 0o620, 0o602]) {
    await fs.chmod(path, mode);
    assert.equal((await f.collect()).complete, false);
  }
  await fs.chmod(path, 0o600);
  assert.equal((await f.collect()).complete, true);
  const trustCopy = join(f.root, "actual-public-root.json");
  await fs.rename(f.legacyTrustRootPath, trustCopy);
  await fs.symlink(trustCopy, f.legacyTrustRootPath);
  assert.equal((await f.collect()).complete, false);
  await fs.unlink(f.legacyTrustRootPath);
  await fs.rename(trustCopy, f.legacyTrustRootPath);
  await fs.chmod(f.legacyTrustRootPath, 0o622);
  assert.equal((await f.collect()).complete, false);
  await fs.chmod(f.legacyTrustRootPath, 0o600);
  const untrusted = structuredClone(ROOTS);
  untrusted.keys = [];
  await fs.writeFile(f.legacyTrustRootPath, JSON.stringify(untrusted));
  assert.equal((await f.collect()).complete, false);
});

test("missing receipt, excessive bytes and absent opt-in trust path never become known inert", async (t) => {
  const f = await inventoryFixture(t),
    path = f.receiptPath(f.fixtures[0]);
  assert.equal(
    (
      await createCoordinatorInventory({
        ...f.options,
        legacyTrustRootPath: null,
      })()
    ).complete,
    false,
  );
  await fs.unlink(path);
  assert.equal((await f.collect()).complete, false);
  await fs.writeFile(
    path,
    JSON.stringify({ ...f.fixtures[0].receipt, extra: "x".repeat(65536) }),
    { mode: 0o600 },
  );
  assert.equal((await f.collect()).complete, false);
});

test("a restart, changed physical tuple or live host PID on the second inspect cannot qualify an old history", async (t) => {
  const f = await inventoryFixture(t);
  for (const change of [
    (p) => (p.hostPid = 100),
    (p) => (p.running = true),
    (p) => (p.startedAt = new Date(NOW - 1).toISOString()),
    (p) => (p.legacyInertProof.commandDigest = digest("changed-command")),
  ]) {
    let n = 0;
    f.setInspect(async (p) => {
      if (++n === 2) change(p);
      return p;
    });
    assert.equal((await f.collect()).complete, false);
  }
});

test("bounded inventory timeout and late Docker completion never return complete or refresh an unknown proof", async (t) => {
  const f = await inventoryFixture(t);
  let enter, release;
  const entered = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r));
  f.setInspect(async (p) => {
    enter();
    await gate;
    return p;
  });
  const collect = createCoordinatorInventory({ ...f.options, timeoutMs: 25 }),
    pending = collect();
  await entered;
  const result = await pending;
  assert.equal(result.complete, false);
  assert.ok(result.missing.includes("COORDINATOR_INVENTORY_TIMEOUT"));
  assert.deepEqual(result.coordinators, []);
  const busy = await collect();
  assert.equal(busy.complete, false);
  assert.ok(busy.missing.includes("COORDINATOR_INVENTORY_BUSY"));
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(result.complete, false);
  assert.deepEqual(result.coordinators, []);
});

test("a current labelled Coordinator still requires live identity; a legacy receipt cannot authorize its stopped state", async (t) => {
  const f = await inventoryFixture(t);
  f.setInspect(async (p) => ({
    ...p,
    artifactDigest: f.fixtures[0].record.artifactDigest,
  }));
  assert.equal((await f.collect()).complete, false);
  assert.equal(f.calls.identity, 0);
  const physical = {
    ...f.fixtures[0].physical,
    artifactDigest: f.fixtures[0].record.artifactDigest,
    running: true,
    hostPid: 1234,
    pid: 1,
  };
  let identityReads = 0;
  const collect = createCoordinatorInventory({
    ...f.options,
    inspect: async () => structuredClone(physical),
    readIdentity: async (r) => {
      identityReads++;
      return {
        instanceId: INSTANCE,
        startIdentity: r.startIdentity,
        artifactDigest: r.artifactDigest,
        generation: 8,
        pid: 1,
        writerFenceValid: true,
        observedAt: new Date(NOW).toISOString(),
      };
    },
  });
  const result = await collect();
  assert.equal(result.complete, true);
  assert.equal(identityReads, 1);
  assert.equal(result.coordinators[0].retiredPhysical, undefined);
  assert.equal(result.coordinators[0].actualIdentity.writerFenceValid, true);
});

test("production Docker inspect actually attaches the inert tuple and leaves the missing artifact label null, with no lifecycle command", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "inert-production-adapter-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture();
  f.row.Config.Labels["agent-platform.installation"] = digest(root);
  const commands = [];
  const adapter = await createProductionRoleAdapter(
    {
      root,
      instanceId: INSTANCE,
      runtimeImage: f.row.Image,
      docker: { cli: "test-docker-never-executed", args: [] },
    },
    {
      run: async (_cmd, args) => {
        commands.push(args);
        if (args[0] === "image" && args[1] === "inspect")
          return JSON.stringify([
            {
              Id: f.row.Image,
              Os: "linux",
              Architecture: "arm64",
              Config: { Env: [] },
            },
          ]);
        assert.deepEqual(args, ["inspect", f.row.Id]);
        return JSON.stringify([f.row]);
      },
    },
  );
  const observed = await adapter.inspect(f.row.Id);
  assert.deepEqual(observed.legacyInertProof, expectedProjection(f.row));
  assert.equal(observed.artifactDigest, null);
  assert.equal(observed.role, "coordinator");
  assert.equal(observed.hostPid, 0);
  assert.equal(observed.exitCode, 1);
  assert.deepEqual(
    commands.map((c) => c[0]),
    ["image", "inspect"],
  );
  assert.equal(
    JSON.stringify(observed).includes("must-not-leave-projection"),
    false,
  );
});

test("private Supervisor wire proof keeps original exit and null label, enforces 5s freshness and independently checks current signing authority", async (t) => {
  const f = await inventoryFixture(t),
    inventory = await f.collect(),
    record = inventory.coordinators[0];
  assert.equal(inventory.complete, true);
  const proof = verifyLegacyCoordinatorInertHistoryWire(record, {
    instanceId: INSTANCE,
    roots: ROOTS,
    now: NOW + 5000,
  });
  assert.equal(proof.target.exitCode, 1);
  assert.equal(proof.observedAt, new Date(NOW).toISOString());
  assert.throws(
    () =>
      verifyLegacyCoordinatorInertHistoryWire(record, {
        instanceId: INSTANCE,
        roots: ROOTS,
        now: NOW + 5001,
      }),
    /WIRE_STALE/,
  );
  assert.throws(
    () =>
      verifyLegacyCoordinatorInertHistoryWire(record, {
        instanceId: INSTANCE,
        roots: ROOTS,
        now: NOW - 1,
      }),
    /WIRE_STALE/,
  );
  for (const change of [
    (r) => (r.physical.artifactDigest = r.artifactDigest),
    (r) => (r.physical.hostPid = 1),
    (r) => (r.physical.legacyInertProof.environmentDigest = digest("changed")),
    (r) => (r.physical.DockerStartedAt = new Date(NOW - 1).toISOString()),
    (r) => (r.artifactDigest = digest("changed")),
  ]) {
    const bad = structuredClone(record);
    change(bad);
    assert.throws(() =>
      verifyLegacyCoordinatorInertHistoryWire(bad, {
        instanceId: INSTANCE,
        roots: ROOTS,
        now: NOW,
      }),
    );
  }
  const roots = structuredClone(ROOTS);
  roots.keys = [];
  assert.throws(() =>
    verifyLegacyCoordinatorInertHistoryWire(record, {
      instanceId: INSTANCE,
      roots,
      now: NOW,
    }),
  );
});

test("real private HTTP inventory plus current trust and SQLite witness treats typed history as a non-writer, without refreshing original exit time", async (t) => {
  const f = await inventoryFixture(t, { count: 10 }),
    inventory = await f.collect();
  assert.equal(inventory.complete, true);
  const Database = createRequire(
      new URL("../../api/package.json", import.meta.url),
    )("better-sqlite3"),
    db = new Database(":memory:");
  t.after(() => db.close());
  const peer = {
    instanceId: INSTANCE,
    startIdentity: "current-independent-coordinator-start",
    artifactDigest: digest("current-independent-coordinator"),
    generation: 9,
    writerFenceValid: true,
    observedAt: new Date(NOW - 1000).toISOString(),
  };
  const writer = {
    ...peer,
    accepting: false,
    observedAt: new Date(NOW - 500).toISOString(),
    lease: {
      instanceId: INSTANCE,
      generation: 9,
      fence: 9,
      holderId: "actual-writer-holder",
      expiresAt: NOW + 30000,
    },
  };
  const supKey = "s".repeat(32),
    businessKey = "b".repeat(32),
    calls = [];
  const server = createServer(async (req, res) => {
    calls.push(req.url);
    const supervise = req.url === "/coordinator-inventory";
    if (
      req.headers["x-platform-internal-key"] !==
        (supervise ? supKey : businessKey) ||
      req.headers["x-platform-instance-id"] !== INSTANCE
    ) {
      res.writeHead(403);
      res.end("{}");
      return;
    }
    res.setHeader("content-type", "application/json");
    if (supervise) {
      assert.equal(req.method, "GET");
      res.end(JSON.stringify(inventory));
      return;
    }
    assert.equal(req.url, "/internal/upgrades/inspection");
    assert.equal(req.method, "POST");
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).action, "writerIdentity");
    res.end(
      JSON.stringify({
        instanceId: INSTANCE,
        action: "writerIdentity",
        result: writer,
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = "http://127.0.0.1:" + server.address().port;
  inventory.coordinators.push({
    containerId: "e".repeat(64),
    startIdentity: peer.startIdentity,
    artifactDigest: peer.artifactDigest,
    origin,
    physical: {
      running: true,
      paused: false,
      startIdentity: peer.startIdentity,
    },
    actualIdentity: peer,
  });
  const wireBytes = Buffer.byteLength(JSON.stringify(inventory));
  assert.equal(inventory.coordinators.length, 11);
  assert.ok(wireBytes <= 262144);
  t.diagnostic(
    JSON.stringify({
      kind: "local-eleven-coordinator-private-HTTP-wire",
      wireBytes,
      limit: 262144,
      nativeQualified: false,
    }),
  );
  const client = createControlStabilization({
    sqlite: db,
    instanceId: INSTANCE,
    supervisorOrigin: origin,
    supervisorKey: supKey,
    controllerKey: businessKey,
    trustRootPath: f.legacyTrustRootPath,
    clock: () => NOW,
  });
  const captured = await client.capture({ recoveryId: "real-control-witness" });
  assert.equal(captured.writer.generation, 9);
  const saved = JSON.parse(
      db
        .prepare(
          "SELECT proof FROM control_stabilization_witnesses WHERE recovery_id=?",
        )
        .get("real-control-witness").proof,
    ),
    old = saved.coordinators.find(
      (c) => c.containerId === f.fixtures[0].record.containerId,
    );
  assert.equal(old.kind, "legacy-inert");
  assert.equal(old.receiptKind, "legacy-coordinator-inert-history");
  assert.equal(old.exitCode, 1);
  assert.equal(old.recordedAt, f.fixtures[0].receipt.recordedAt);
  assert.equal(old.artifactLabel, null);
  assert.equal(old.writerFenceValid, false);
  assert.equal(old.generation, null);
  assert.equal(old.exitedAt, f.fixtures[0].receipt.target.finishedAt);
  assert.equal(old.observedAt, new Date(NOW).toISOString());
  assert.equal(saved.observedAt, peer.observedAt);
  assert.equal(old.receiptDigest, f.fixtures[0].receipt.receiptDigest);
  assert.deepEqual(
    calls.sort(),
    ["/coordinator-inventory", "/internal/upgrades/inspection"].sort(),
  );
  const missingTrust = createControlStabilization({
    sqlite: db,
    instanceId: INSTANCE,
    supervisorOrigin: origin,
    supervisorKey: supKey,
    controllerKey: businessKey,
    clock: () => NOW,
  });
  await assert.rejects(
    missingTrust.capture({ recoveryId: "no-current-trust" }),
    /INERT_TRUST_REQUIRED/,
  );
  const revoked = structuredClone(ROOTS);
  revoked.keys.find(
    (k) => k.id === f.fixtures[0].receipt.signedManifest.signature.keyId,
  ).revoked = true;
  await fs.writeFile(f.legacyTrustRootPath, JSON.stringify(revoked));
  await assert.rejects(client.capture({ recoveryId: "revoked-current-root" }));
  assert.equal(
    db.prepare("SELECT count(*) n FROM control_stabilization_witnesses").get()
      .n,
    1,
  );
});

test("only exact read-only artifact mounts qualify; parent-only mappings and any deeper overlay are rejected", () => {
  const root = "/test-artifacts/" + "a".repeat(64),
    exact = { type: "bind", source: root, destination: root, rw: false },
    parent = {
      type: "bind",
      source: "/test-artifacts",
      destination: "/test-artifacts",
      rw: false,
    },
    nested = {
      type: "bind",
      source: root + "/api",
      destination: root + "/api",
      rw: false,
    };
  assert.equal(hasReadOnlyLegacyArtifactCoverage([exact], root), true);
  for (const mounts of [
    [parent],
    [parent, nested],
    [exact, nested],
    [{ ...exact, rw: true }],
    [exact, { ...nested, rw: true }],
    [exact, { ...nested, source: "/other-code" }],
    [{ ...exact, source: "/substituted-artifacts" }],
    [{ ...exact, destination: root + "/../" + "a".repeat(64) }],
    [{ ...exact, source: root + "/../" + "a".repeat(64) }],
    [{ ...exact, type: "volume" }],
    [],
  ])
    assert.equal(hasReadOnlyLegacyArtifactCoverage(mounts, root), false);
  assert.equal(
    hasReadOnlyLegacyArtifactCoverage([exact], root + "/../" + "a".repeat(64)),
    false,
  );
});
