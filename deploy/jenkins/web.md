# Web CI and cross repository acceptance

`agent-platform-web` accepts the fixed Web repository's full `SHA` and `REF`, plus
the umbrella project's `ROOT_SHA` and `API_SHA`. Production builds use
`refs/heads/feat/design-v2-migration`; main and PR runs use the same CI gates.

The job runs all local static gates, acceptance tests, Storybook tests, the static
Storybook build, production build and package phases on `agent-platform-web-build`.
This is the fixed Linux AMD64 CI image, running as `jenkins`/UID1000 with
`HOME=/home/jenkins`. Its Node22 and public tools live at `/usr/local/bin/node`
and `/opt/agent-platform/tools`. Dependencies and Chromium are installed inside
the image; host Mac `node_modules`, browser caches and binaries are not mounted.
Production public Vercel settings are prepared separately on the trusted agent;
repository code receives no deployment credentials or production runtime env.

The image uses Node22.23.3, pnpm9.15.0 (Web/cross browser) and9.12.0 (API),
Playwright1.62.1 and Vercel CLI62.2.0.
Only the fixed public tools and committed npm tool lock are placed in its build
context. The generic ARM64 node is `linux-ci` with label
`agent-platform-linux-ci`; the production prebuilt node is `linux-web-amd64`
with label `agent-platform-web-build`. Each has its own home/cache volume.
The only connection secret is the node-specific read-only file
`/run/secrets/jenkins_agent_secret`; the entrypoint passes its path to Java with
`-secret @file`, never the value in an environment variable or command argument.
No production directory, Vercel auth cache or Docker daemon socket belongs in
these agents.

The pinned pnpm archive is stored in the root-owned, readable
`/opt/agent-platform/corepack` cache. CI children use this fixed `COREPACK_HOME`
and disable latest-version lookup; the isolated account does not depend on a
root home cache. The image smoke verifies pnpm with container networking disabled.
Linux install stages verify the project's exact Playwright version and existing
Chromium executable in the immutable image cache. They do not run Playwright's
installer, which writes cache locks and registration metadata. A missing revision
fails installation; Mac stages retain their writable per-account installation.

On this Apple Silicon host the AMD64 builder uses VZ with Rosetta enabled.
QEMU user emulation failed actual Chromium startup; installing the image alone
did not prove it was usable. [Lima documents the two emulation modes](https://lima-vm.io/docs/config/multi-arch/).
After building both tags in the dedicated `agent-platform-build` daemon, run:

```sh
node deploy/containers/ci-smoke.mjs arm64 /tmp/agent-platform-ci-arm64-smoke.json
node deploy/containers/ci-smoke.mjs x64 /tmp/agent-platform-ci-amd64-smoke.json
```

The smoke uses no host mount, network or credential. It checks the fixed tool
versions, 30 Node subprocesses, a compiled and loaded N-API ELF module, target
mismatch refusal and three default-argument Chromium interaction/screenshot
runs. It does not run a Jenkins agent or substitute for the full project gates.

Prebuilt output validation reads native ELF headers and compares each executable
to its containing function's `.vc-config.json` architecture, defaulting to
`x86_64`. It refuses Mach-O, unknown ELF formats and mismatched targets before
packaging or adoption. ARM64 builds containing only portable JS are allowed;
ARM64 native output is allowed only for functions explicitly configured `arm64`.
The fixed production job uses AMD64 to match Vercel's default target.

After the CI stage and its artifact archive finish, the job releases its CI
executor. An outer stage under `agent none` calls `agent-platform-contract` with
exact `ROOT_SHA`, `API_SHA` and `WEB_SHA=SHA` parameters and waits without holding
either the CI or deployment executor. The contract job checks out those three
commits. The Linux ARM64 node runs the documentation gates, current portable
deployment regressions and browser against the real compiled Nest API and fresh
SQLite. The browser's protocol resource fixture does not exercise real BoxLite
VMs. Backend validation separately loads the actual Linux SQLite and BoxLite
native modules; the API image's real VM smoke remains distinct evidence.
Its actual final `SUCCESS` is required for the whole Web job to succeed.

The archived `web-cross-repository/contract.json` records the Web build number,
three commits, contract child build number, result, approved public or local build URL and
exact requested parameters. It records failures and `not-run` explicitly; local
unit/Storybook success cannot substitute for this child. The artifact manifest is
created before this final gate, so consumers must still verify the enclosing
Web Jenkins build's completed `SUCCESS` and exact parameters before adopting it.

The umbrella release job reuses this child only after verifying the archived
report, the child's actual completed `SUCCESS` and all three parameters. Missing
or pruned child evidence requires another real contract build.

Trusted preparation, adoption, upload and promotion run on
`agent-platform-linux-deploy`. This separate ARM64 deployment container has
owner-only volumes at `/srv/agent-platform/deploy` and
`/run/agent-platform/jenkins-tools`; ordinary CI has neither mount. Vercel OAuth
is read only by the fixed authenticated CLI and is never inherited by repository
builds. API packages bind both `ROOT_SHA` and `API_SHA`, using immutable release
folders named `<ROOT_SHA>-<API_SHA>`. Docker-save validation checks the OCI index
digest separately from its Linux ARM64 config digest.

The `jenkins/web-ci` required status is bound to the dedicated Jenkins GitHub App.
It includes the real cross repository journey in the Web job's overall result;
local frontend gates alone cannot produce a successful aggregate status.

After changing this template, synchronize the managed pipelines and refresh the
bootstrap definitions. Validate the actual Declarative Pipeline with the local
Jenkins linter, then verify a child failure prevents whole-job success and a
successful child produces the provenance artifact. Source review or local tool
unit tests do not establish successful Jenkins execution.
