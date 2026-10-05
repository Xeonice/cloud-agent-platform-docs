pipeline {
  agent { label 'agent-platform-ci' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 40, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '14', numToKeepStr: '50'))
  }
  triggers { cron('TZ=Asia/Shanghai\n0 3 * * *') }
  parameters {
    string(name: 'ROOT_SHA', defaultValue: '', description: 'Pinned project commit')
    string(name: 'API_SHA', defaultValue: '', description: 'Pinned API commit')
    string(name: 'WEB_SHA', defaultValue: '', description: 'Pinned web commit')
  }
  environment { NODE22 = '@NODE22@'; PROJECT_CI = '/Library/Application Support/AgentPlatform/jenkins-tools/project-ci.mjs' }
  stages {
    stage('Resolve daily main or pinned project') {
      steps {
        script {
          if (!params.ROOT_SHA && !params.API_SHA && !params.WEB_SHA) {
            sh '"$NODE22" "$PROJECT_CI" head > nightly-heads.json'
            def heads = readJSON(file: 'nightly-heads.json')
            env.ROOT_SHA = heads.project
            env.API_SHA = heads.api
            env.WEB_SHA = heads.web
          } else if (!(params.ROOT_SHA && params.API_SHA && params.WEB_SHA)) { error('Every repository commit must be supplied for a pinned check') }
        }
      }
    }
    stage('Checkout three exact commits') { steps { sh '"$NODE22" "$PROJECT_CI" checkout "$ROOT_SHA" "$API_SHA" "$WEB_SHA"' } }
    stage('Docs and deployment acceptance') { steps { sh '"$NODE22" "$PROJECT_CI" docs "$ROOT_SHA" "$API_SHA" "$WEB_SHA"' } }
    stage('Install native test dependencies') { steps { sh '"$NODE22" "$PROJECT_CI" install "$ROOT_SHA" "$API_SHA" "$WEB_SHA"' } }
    stage('Browser to Nest to fresh SQLite') { steps { sh '"$NODE22" "$PROJECT_CI" contract "$ROOT_SHA" "$API_SHA" "$WEB_SHA"' } }
  }
  post {
    always {
      archiveArtifacts artifacts: 'nightly-heads.json,commits.json,source/e2e-contract/artifacts/acceptance-results.json,source/artifacts/migration-audit/cross-execution-report.json,source/e2e-contract/test-results/**', allowEmptyArchive: true, followSymlinks: false
      script { currentBuild.description = "${env.ROOT_SHA?.take(8)} / API ${env.API_SHA?.take(8)} / WEB ${env.WEB_SHA?.take(8)}" }
    }
  }
}
