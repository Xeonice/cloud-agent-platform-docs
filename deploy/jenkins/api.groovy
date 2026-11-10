pipeline {
  agent { label 'agent-platform-linux-api-build' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 90, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '60', numToKeepStr: '300', artifactNumToKeepStr: '10'))
  }
  parameters {
    string(name: 'SHA', defaultValue: '', description: 'Exact approved API build commit')
    string(name: 'ROOT_SHA', defaultValue: '', description: 'Exact approved project commit containing the container definition')
  }
  environment {
    NODE22 = '/usr/local/bin/node'
    API_TOOL = '/opt/agent-platform/tools/deploy/containers/api-build.mjs'
  }
  stages {
    stage('Resolve approved branch') {
      steps {
        deleteDir()
        sh '"$NODE22" "$API_TOOL" head > head.json'
        script {
          def head = readJSON(file: 'head.json')
          env.RELEASE_SHA = head.sha
          env.RELEASE_ROOT_SHA = params.ROOT_SHA ?: head.rootSha
          if (env.RELEASE_ROOT_SHA != head.rootSha) { error('Pinned project commit is no longer the production branch head') }
          if (params.SHA && params.SHA != env.RELEASE_SHA) { error('Pinned API commit is no longer the production branch head') }
          currentBuild.description = "${env.RELEASE_SHA.take(12)} · preparing Linux ARM64 image"
        }
      }
    }
    stage('Complete isolated backend CI') {
      steps {
        script {
          def result = build job: 'agent-platform-native-ci', parameters: [string(name: 'SHA', value: env.RELEASE_SHA), string(name: 'REF', value: 'refs/heads/main')], wait: true, propagate: false
          if (result.result != 'SUCCESS') { error("Backend validation ${result.result}; no image is published") }
          writeJSON file: 'api-validation.json', json: [sha: env.RELEASE_SHA, build: result.number, url: result.absoluteUrl, result: result.result]
        }
      }
    }
    stage('Build immutable API and BoxLite image; package locally') {
      steps {
        sh '"$NODE22" "$API_TOOL" build "$RELEASE_SHA" "$BUILD_NUMBER" "$WORKSPACE" "$RELEASE_ROOT_SHA" > ci.json'
        script {
          def ci = readJSON(file: 'ci.json')
          if (ci.state != 'ci-passed' || ci.sha != env.RELEASE_SHA || ci.nativeProbe != 'passed') { error('Pinned image and native addon validation did not pass') }
          currentBuild.description = "${env.RELEASE_SHA.take(12)} · Linux image packaged"
        }
      }
    }

  }
  post {
    always {
      archiveArtifacts artifacts: 'head.json,api-validation.json,ci.json,api-package.json,api-package-*.tgz', allowEmptyArchive: true, fingerprint: true, followSymlinks: false
    }
  }
}
