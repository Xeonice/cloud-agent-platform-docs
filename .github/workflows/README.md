# Jenkins CI migration

Project checks and deployment are managed by the Mac mini Jenkins pipelines in `deploy/jenkins`.

The former workflows are preserved unchanged as `docs-check.yml.disabled` and `contract-e2e.yml.disabled`. GitHub Actions does not execute these archive files. The Jenkins contract job performs the documentation and real browser/Nest/SQLite checks, including the daily main check at 03:00 Asia/Shanghai. Jenkins discovery handles branch and pull request changes; the umbrella release job builds, packages and uploads the three-repository release locally.

The existing main branch protection currently pins its required check to the GitHub Actions app. Its source must be migrated to the dedicated Jenkins GitHub App after that app's real status results are verified; archiving a workflow does not update this protection rule.

See [Mac mini maintenance](../../docs/macmini-deployment.md) for setup state, service ownership, artifacts, logs and recovery.
