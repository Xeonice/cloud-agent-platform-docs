# Historical Entry source fixture

The five `.mjs` files are byte-for-byte copies from project commit
`208342ea994555c12c3ba42ce3b6aabd0afe9df1`, under `deploy/upgrade/`.
`provenance.json` records each original Git blob, SHA-256 and byte count.

`stable-entry.mjs`, `io.mjs`, `trust.mjs` and `installer-identity.mjs` are the
complete relative-import closure executed by the historical Entry factory.
The original `controller-main.mjs` is included only because that historical
identity function requires this filename while hashing its local source tree.
It is never imported or executed. This directory is not a complete installer
package, and its fixture-tree digest is not the deployed historical engine digest.

The integration test uses the current compiled API's real `UpgradeStore`,
`UpgradeService.claim` and `UpgradeInspector.entryBinding` against a temporary
file SQLite database and real HTTP. The release state and isolated signing key
belong to the local test. No accepted row, lease or successful fence check is
invented by SQL or a boolean stub. The tested binding uses the actual inner
gateway's computed identity; it does not qualify a production API artifact.

The experiment proves only that the original binding protocol can direct new
HTTP/WebSocket connections to a nested gateway while an existing WebSocket
remains attached to the old backend. It does not prove independent-control
adoption, legacy Supervisor revocation, a writer handoff, Guest/PTY continuity,
Web asset migration or Native/production qualification. No migration executor
or ControlAgent is started, and all listeners bind only local temporary ports.

This fixture lives outside `deploy/upgrade`, which the production packager copies
to `installer/`. The test asserts that separation. Do not move historical files
into a production source directory.

After building the API with the repository's Node 22 toolchain, run:

```sh
node --test deploy/testing/legacy-entry-adoption.test.mjs
```
