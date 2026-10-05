# Web CI and cross repository acceptance

`agent-platform-web` accepts the fixed Web repository's full `SHA` and `REF`, plus
the umbrella project's `ROOT_SHA` and `API_SHA`. Production builds use
`refs/heads/feat/design-v2-migration`; main and PR runs use the same CI gates.

The job runs all local static gates, acceptance tests, Storybook tests, the static
Storybook build, production build and package phases on `agent-platform-ci`.
Production public Vercel settings are prepared separately on the trusted agent;
repository code receives no deployment credentials or production runtime env.

After the CI stage and its artifact archive finish, the job releases its CI
executor. An outer stage under `agent none` calls `agent-platform-contract` with
exact `ROOT_SHA`, `API_SHA` and `WEB_SHA=SHA` parameters and waits without holding
either the CI or deployment executor. The contract job checks out those three
commits and runs the browser against the real compiled Nest API and fresh SQLite.
Its actual final `SUCCESS` is required for the whole Web job to succeed.

The archived `web-cross-repository/contract.json` records the Web build number,
three commits, contract child build number, result, fixed local build URL and
exact requested parameters. It records failures and `not-run` explicitly; local
unit/Storybook success cannot substitute for this child. The artifact manifest is
created before this final gate, so consumers must still verify the enclosing
Web Jenkins build's completed `SUCCESS` and exact parameters before adopting it.

The umbrella release job currently keeps its additional contract check. This is
redundant coverage, not an omission. A future reuse must verify the archived
child's actual completed build and all three parameters before skipping a run.

The old Web GitHub Actions workflow contained four local jobs and delegated the
real journey to the umbrella `contract-e2e` workflow. The old main branch check
configuration also named a Playwright check. Jenkins therefore includes this real
journey in the Web job's overall result rather than reducing the required scope.

After changing this template, synchronize the managed pipelines and refresh the
bootstrap definitions. Validate the actual Declarative Pipeline with the local
Jenkins linter, then verify a child failure prevents whole-job success and a
successful child produces the provenance artifact. Source review or local tool
unit tests do not establish successful Jenkins execution.
