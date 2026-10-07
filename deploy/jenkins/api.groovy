pipeline {
  agent { label 'agent-platform-linux-deploy' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 90, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '60', numToKeepStr: '300', artifactNumToKeepStr: '100'))
  }
  parameters {
    string(name: 'SHA', defaultValue: '', description: 'Exact approved production API commit')
    string(name: 'ROOT_SHA', defaultValue: '', description: 'Exact approved project commit containing the container definition')
  }
  environment {
    NODE22 = '/usr/local/bin/node'
    API_TOOL = '/opt/agent-platform/tools/api-container.mjs'
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
    stage('Drain, consistent backup and Docker service publication') {
      steps {
        sh '"$NODE22" "$API_TOOL" deploy "$RELEASE_SHA" "$BUILD_NUMBER" > deployment.json'
        script {
          def result = readJSON(file: 'deployment.json')
          currentBuild.description = "${env.RELEASE_SHA.take(12)} · ${result.state}"
          if (!(result.state in ['current', 'deployed'])) { unstable("Release is ${result.state}; Jenkins discovery will retry") }
        }
      }
    }
  }
  post {
    always {
      script {
        def folder = "runtime-report-${env.BUILD_NUMBER}"
        def code = sh(script: '"$NODE22" "$API_TOOL" monitor "runtime-report-$BUILD_NUMBER"', returnStatus: true)
        if (code == 2) { unstable('Runtime snapshot reports an unhealthy container') }
        if (code != 0 && code != 2) { error('Runtime snapshot collection failed') }
        archiveArtifacts artifacts: "head.json,api-validation.json,ci.json,deployment.json,api-package.json,api-package-${env.BUILD_NUMBER}.tgz,${folder}/report.json,${folder}/report.html,${folder}/*.redacted.log", allowEmptyArchive: true, fingerprint: true, followSymlinks: false
        publishHTML(target: [allowMissing: false, alwaysLinkToLastBuild: true, keepAll: true, reportDir: folder, reportFiles: 'report.html', reportName: 'Service status and logs'])
      }
    }
  }
}
