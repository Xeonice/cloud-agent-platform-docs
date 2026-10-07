pipeline {
  agent { label 'agent-platform-linux-deploy' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 3, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '14', numToKeepStr: '11000'))
  }
  triggers { cron('H/2 * * * *') }
  environment {
    NODE22 = '/usr/local/bin/node'
    DISCOVERY_TOOL = '/opt/agent-platform/tools/jenkins-discover.mjs'
  }
  stages {
    stage('Discover branch and open PR updates') {
      steps { sh '"$NODE22" "$DISCOVERY_TOOL" > discovery.json' }
    }
  }
  post { always { archiveArtifacts artifacts: 'discovery.json', allowEmptyArchive: true } }
}
