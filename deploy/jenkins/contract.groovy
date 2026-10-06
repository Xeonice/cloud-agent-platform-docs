pipeline {
  agent none
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
  stages {
    stage('Resolve daily main or pinned project') {
      agent { label 'agent-platform-linux-ci' }
      environment { NODE22 = '/usr/local/bin/node'; PROJECT_CI = '/opt/agent-platform/tools/project-ci.mjs' }
      steps {
        deleteDir()
        script {
          if (!params.ROOT_SHA && !params.API_SHA && !params.WEB_SHA) {
            sh '"$NODE22" "$PROJECT_CI" head > nightly-heads.json'
            def heads = readJSON(file: 'nightly-heads.json')
            env.ROOT_SHA = heads.project
            env.API_SHA = heads.api
            env.WEB_SHA = heads.web
          } else if (!(params.ROOT_SHA && params.API_SHA && params.WEB_SHA)) { error('Every repository commit must be supplied for a pinned check') }
          else {
            env.ROOT_SHA = params.ROOT_SHA
            env.API_SHA = params.API_SHA
            env.WEB_SHA = params.WEB_SHA
          }
          if (![env.ROOT_SHA, env.API_SHA, env.WEB_SHA].every { it ==~ /[a-f0-9]{40}/ }) { error('Every resolved repository commit must be a full SHA') }
        }
      }
      post { always { archiveArtifacts artifacts: 'nightly-heads.json', allowEmptyArchive: true, followSymlinks: false } }
    }
    stage('Linux deployment regression') {
      agent { label 'agent-platform-linux-ci' }
      environment { NODE22 = '/usr/local/bin/node'; PROJECT_CI = '/opt/agent-platform/tools/project-ci.mjs' }
      steps {
        deleteDir()
        sh '"$NODE22" "$PROJECT_CI" checkout "$ROOT_SHA" "$API_SHA" "$WEB_SHA"'
        sh '"$NODE22" "$PROJECT_CI" deployment-tests "$ROOT_SHA" "$API_SHA" "$WEB_SHA"'
      }
    }
    stage('Linux docs and real cross repository browser acceptance') {
      agent { label 'agent-platform-linux-ci' }
      environment { NODE22 = '/usr/local/bin/node'; PROJECT_CI = '/opt/agent-platform/tools/project-ci.mjs' }
      stages {
        stage('Checkout three exact commits') {
          steps {
            deleteDir()
            sh '"$NODE22" "$PROJECT_CI" checkout "$ROOT_SHA" "$API_SHA" "$WEB_SHA"'
          }
        }
        stage('Docs acceptance') { steps { sh '"$NODE22" "$PROJECT_CI" docs "$ROOT_SHA" "$API_SHA" "$WEB_SHA"' } }
        stage('Install Linux test dependencies') { steps { sh '"$NODE22" "$PROJECT_CI" install "$ROOT_SHA" "$API_SHA" "$WEB_SHA"' } }
        stage('Browser to Nest to fresh SQLite') { steps { sh '"$NODE22" "$PROJECT_CI" contract "$ROOT_SHA" "$API_SHA" "$WEB_SHA"' } }
      }
      post {
        always {
          archiveArtifacts artifacts: 'commits.json,source/e2e-contract/artifacts/acceptance-results.json,source/e2e-contract/artifacts/execution-report.json,source/e2e-contract/test-results/**', allowEmptyArchive: true, followSymlinks: false
        }
      }
    }
  }
  post {
    always {
      script { currentBuild.description = "${env.ROOT_SHA?.take(8)} / API ${env.API_SHA?.take(8)} / WEB ${env.WEB_SHA?.take(8)}" }
    }
  }
}
