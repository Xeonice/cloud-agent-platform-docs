pipeline {
  agent { label 'agent-platform-linux-deploy' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 3, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '14', numToKeepStr: '5000', artifactNumToKeepStr: '5000'))
  }
  triggers { cron('H/5 * * * *') }
  environment {
    NODE22 = '/usr/local/bin/node'
    MONITOR_TOOL = '/opt/agent-platform/tools/api-container.mjs'
  }
  stages {
    stage('Collect runtime state and redacted logs') {
      steps {
        script {
          def folder = "runtime-report-${env.BUILD_NUMBER}"
          def code = sh(script: '"$NODE22" "$MONITOR_TOOL" monitor "runtime-report-$BUILD_NUMBER"', returnStatus: true)
          if (code == 2) { unstable('Service snapshot reports an unhealthy runtime') }
          if (code != 0 && code != 2) { error('Runtime snapshot collection failed') }
          def report = readJSON(file: "${folder}/report.json")
          currentBuild.description = "Runtime snapshot ${env.BUILD_NUMBER} · ${code == 0 ? 'healthy' : 'unhealthy'}"
        }
      }
    }
  }
  post {
    always {
      script {
        def folder = "runtime-report-${env.BUILD_NUMBER}"
        archiveArtifacts artifacts: "${folder}/report.json,${folder}/report.html,${folder}/api.redacted.log,${folder}/tunnel.redacted.log,${folder}/dns.redacted.log,${folder}/cicd.redacted.log,${folder}/build.redacted.log", allowEmptyArchive: true, fingerprint: true, followSymlinks: false
        publishHTML(target: [allowMissing: false, alwaysLinkToLastBuild: true, keepAll: true, reportDir: folder, reportFiles: 'report.html', reportName: 'Service status and logs'])
      }
    }
  }
}
