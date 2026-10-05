pipeline {
  agent { label 'agent-platform-deploy' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 50, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '60', numToKeepStr: '300', artifactNumToKeepStr: '100'))
  }
  parameters { string(name: 'SHA', defaultValue: '', description: 'Optional pinned production SHA from the project release pipeline') }
  environment {
    NODE22 = '@NODE22@'
    DEPLOY_ROOT = '@DEPLOY_ROOT@'
    DEPLOY_CONFIG = '@DEPLOY_CONFIG@'
    DEPLOY_TOOLS = '@DEPLOY_TOOLS@'
    REPORT_TOOL = '@JENKINS_SOURCE@/deploy/jenkins/collect-api-reports.mjs'
    PACKAGE_TOOL = '@JENKINS_SOURCE@/deploy/jenkins/package-api.mjs'
  }
  stages {
    stage('Resolve approved branch') {
      steps {
        sh '"$NODE22" "$DEPLOY_TOOLS/controller.mjs" "$DEPLOY_CONFIG" head > head.json'
        script {
          env.RELEASE_SHA = readJSON(file: 'head.json').sha
          if (params.SHA && params.SHA != env.RELEASE_SHA) { error('Pinned project API commit is no longer the production branch head') }
          currentBuild.description = "${env.RELEASE_SHA.take(12)} · preparing"
        }
      }
    }
    stage('Native CI and immutable release') {
      steps {
        sh '"$NODE22" "$DEPLOY_TOOLS/controller.mjs" "$DEPLOY_CONFIG" build "$RELEASE_SHA" "$BUILD_NUMBER" > ci.json'
        sh '"$NODE22" "$REPORT_TOOL" "$DEPLOY_CONFIG" "$RELEASE_SHA" "$BUILD_NUMBER" "api-reports-$BUILD_NUMBER" > reports.json'
        script {
          def ci = readJSON(file: 'ci.json')
          if (ci.state != 'ci-passed') { error("Native CI is ${ci.state}; no package or service publication") }
          env.API_ARTIFACT_PATH = ci.artifactPath
          currentBuild.description = "${env.RELEASE_SHA.take(12)} · CI passed"
        }
      }
    }
    stage('Portable native package before service activation') {
      steps { sh '"$NODE22" "$PACKAGE_TOOL" "$API_ARTIFACT_PATH" "$WORKSPACE/api-package-$BUILD_NUMBER.tgz" "$RELEASE_SHA" > api-package.json' }
    }
    stage('Idle gate, backup and publish') {
      steps {
        sh '"$NODE22" "$DEPLOY_TOOLS/controller.mjs" "$DEPLOY_CONFIG" deploy "$RELEASE_SHA" "$BUILD_NUMBER" > deployment.json'
        script {
          def result = readJSON(file: 'deployment.json')
          currentBuild.description = "${env.RELEASE_SHA.take(12)} · ${result.state}"
          if (!(result.state in ['current', 'deployed'])) {
            unstable("Release is ${result.state}; it has not been published. Jenkins discovery retries safely.")
          }
        }
      }
    }
  }
  post {
    always {
      script {
        def folder = "runtime-report-${env.BUILD_NUMBER}"
        def code = sh(script: '"$NODE22" "$DEPLOY_TOOLS/jenkins-monitor.mjs" "$DEPLOY_CONFIG" "runtime-report-$BUILD_NUMBER"', returnStatus: true)
        if (code == 2) { unstable('Service snapshot reports an unhealthy runtime') }
        if (code != 0 && code != 2) { error('Runtime snapshot collection failed') }
        archiveArtifacts artifacts: "head.json,ci.json,deployment.json,reports.json,api-package.json,api-package-${env.BUILD_NUMBER}.tgz,api-reports-${env.BUILD_NUMBER}/execution-report.json,api-reports-${env.BUILD_NUMBER}/non-protocol.json,api-reports-${env.BUILD_NUMBER}/protocol.json,${folder}/report.json,${folder}/report.html,${folder}/api.redacted.log,${folder}/tunnel.redacted.log,${folder}/cicd.redacted.log,${folder}/build.redacted.log", allowEmptyArchive: true, fingerprint: true, followSymlinks: false
        publishHTML(target: [allowMissing: false, alwaysLinkToLastBuild: true, keepAll: true, reportDir: folder, reportFiles: 'report.html', reportName: 'Service status and logs'])
      }
    }
  }
}
