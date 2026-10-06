pipeline {
  agent { label 'agent-platform-linux-ci' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 130, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '30', numToKeepStr: '60'))
  }
  triggers { cron('TZ=Asia/Shanghai\n0 2 * * *') }
  parameters {
    string(name: 'SHA', defaultValue: '', description: 'Exact API commit; blank resolves the fixed branch for nightly full mode only')
    string(name: 'REF', defaultValue: 'refs/heads/feat/design-v2-migration', description: 'API branch or pull-request head')
    choice(name: 'MODE', choices: ['full', 'changed'], description: 'Nightly full trend or nonblocking PR changed-source report')
    string(name: 'BASE_SHA', defaultValue: '', description: 'Discovered PR base commit for changed mode')
    string(name: 'BASE_REF', defaultValue: '', description: 'Discovered refs/heads/base branch for changed mode')
  }
  environment {
    NODE22 = '/usr/local/bin/node'
    CI_TOOL = '/opt/agent-platform/tools/jenkins-ci.mjs'
    MUTATION_TOOL = '/opt/agent-platform/tools/mutation.mjs'
  }
  stages {
    stage('Resolve pinned source') {
      steps {
        script {
          env.CHECKOUT_READY = 'false'
          env.MUTATION_READY = 'false'
        }
        catchError(buildResult: 'UNSTABLE', stageResult: 'UNSTABLE', catchInterruptions: false) {
          deleteDir()
          script {
            env.MUTATION_SHA = params.SHA
            if (!env.MUTATION_SHA) {
              if (params.MODE != 'full') { error('PR changed mode requires a discovered full SHA') }
              sh '"$NODE22" "$MUTATION_TOOL" head "$REF" > mutation-head.json'
              env.MUTATION_SHA = readJSON(file: 'mutation-head.json').sha
            }
            env.CHECKOUT_READY = 'true'
          }
        }
      }
    }
    stage('Prepare pinned checkout and dependencies') {
      when { expression { env.CHECKOUT_READY == 'true' } }
      steps {
        catchError(buildResult: 'UNSTABLE', stageResult: 'UNSTABLE', catchInterruptions: false) {
          sh '"$NODE22" "$CI_TOOL" checkout "$MUTATION_SHA" "$REF"'
          sh '"$NODE22" "$CI_TOOL" install "$MUTATION_SHA" "$REF"'
          script { env.MUTATION_READY = 'true' }
        }
      }
    }
    stage('Nonblocking mutation report') {
      when { expression { env.MUTATION_READY == 'true' } }
      steps {
        catchError(buildResult: 'UNSTABLE', stageResult: 'UNSTABLE', catchInterruptions: false) {
          sh '"$NODE22" "$MUTATION_TOOL" "$MUTATION_SHA" "$REF" "$MODE" "$BASE_SHA" "$BASE_REF" > mutation.json'
          script {
            def result = readJSON(file: 'mutation-result.json')
            currentBuild.description = "${env.MUTATION_SHA.take(12)} · ${params.MODE} · ${result.status}"
            if (result.status in ['failed', 'no-unit-tests']) { unstable("Mutation result: ${result.status}; this report does not block API CI or release") }
          }
        }
      }
    }
  }
  post { always { archiveArtifacts artifacts: 'commit.json,mutation-head.json,mutation.json,mutation-result.json,source/reports/mutation/**', allowEmptyArchive: true, fingerprint: true, followSymlinks: false } }
}
