# Formal Jenkins CI cutover

This tool prepares a reviewable plan before changing GitHub. It does not start,
enable, queue, or deploy any Jenkins job. The fixed three repositories, six old
workflow IDs, Jenkins job URLs, and GitHub App ID `5204009` are in
`ci-cutover.mjs`.

First switch the reviewed controller to `active` mode and explicitly enable only
`agent-platform-native-ci`, `agent-platform-web`, and `agent-platform-contract`.
Keep discovery, release, API deployment, mutation, image publishing, and service
monitoring disabled. The existing `manage.mjs activate` command enables all
managed jobs; it is not the limited validation step. Connect the intended agents
under the active guard, then run the real jobs on the exact source commits. The
Web job must complete its actual contract child, and that child is the project
build used below. Local/manual reports and synthetic Jenkins identities cannot
authorize a cutover.

Prepare an owner-only JSON file (`UID501`, mode `0600`) with this shape, filling
the full commits and actual completed Jenkins build numbers:

```json
{
  "version": 1,
  "commits": {
    "api": "<40-hex-sha>",
    "web": "<40-hex-sha>",
    "project": "<40-hex-sha>"
  },
  "refs": {
    "api": "refs/heads/feat/design-v2-migration",
    "web": "refs/heads/feat/design-v2-migration",
    "project": "refs/heads/Xeonice/初始化一下项目开发"
  },
  "builds": { "api": 17, "web": 21, "project": 24 }
}
```

The numbers above illustrate the schema; they are not execution evidence. Each
repository also permits its own `main` ref or an exact currently open PR head.
The tool checks the remote ref, final Jenkins `SUCCESS`, every source parameter,
native checkout artifact, packaged Web provenance and nonempty test counts, the
actual successful contract child, and its three-repository checkout artifact.
It requires the active controller to have only the three validation jobs enabled.

Use native Node22 as UID501, without `sudo`:

```sh
node deploy/jenkins/ci-cutover.mjs preview /absolute/private/request.json
```

`preview` makes only read requests and writes a private immutable plan under
`~/.local/share/agent-platform-jenkins-tools/ci-cutover/<uuid>/plan.json`.
Review its complete original protection snapshots, narrow proposed patches,
exact commits/builds, workflow identities, and returned SHA before the separate
application step:

```sh
node deploy/jenkins/ci-cutover.mjs apply /absolute/private/plan.json <reviewed-plan-sha256>
```

Application revalidates the sources and builds. It publishes success through the
verified App's short-lived token restricted to the three repositories, then
reads each returned status ID back. An OAuth or another bot's same-named status
does not satisfy this gate. Tokens and private operands never enter the plan,
checkpoint, or stdout.

The tool PATCHes only the dedicated required-status-check endpoint, preserving
the original `strict` value and comparing every other protection field before
and after. All new checks explicitly require the verified App ID; there is no
`app_id: -1` or unrestricted-source fallback. Only after all three protections
are confirmed does it disable the six fixed old workflow IDs. GitHub documents
these narrow interfaces in [status-check protection](https://docs.github.com/en/rest/branches/branch-protection#update-status-check-protection)
and [workflow disablement](https://docs.github.com/en/rest/actions/workflows#disable-a-workflow).

GitHub does not offer one transaction across these operations. A private
checkpoint records each verified result, and the same reviewed plan can resume
after a provider failure without republishing an already verified status or
weakening another rule. Source movement, a missing real build, changed
protection constraints, or changed workflow identity blocks the retry for
operator review. The tool does not automatically roll back policies. Discovery
remains disabled throughout; its later activation is a separate decision.

Run the isolated tests with:

```sh
node --test deploy/jenkins/ci-cutover.test.mjs
```

The packaged-manifest fixture comes from the actual Linux prebuilt proof. Its
`manualProof` field and synthetic build number are deliberately retained so
tests reject it as formal CI evidence; it only anchors the actual JSON shape.
All external mutations in these tests use injected providers.
