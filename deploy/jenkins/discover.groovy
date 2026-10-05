pipeline {
  agent { label 'agent-platform-deploy' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 3, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '14', numToKeepStr: '11000'))
  }
  triggers { cron('H/2 * * * *') }
  environment {
    NODE22 = '@NODE22@'
    DISCOVERY_TOOL = '@JENKINS_SOURCE@/deploy/jenkins/jenkins-discover.mjs'
  }
  stages {
    stage('Discover branch and open PR updates') {
      steps { sh '"$NODE22" "$DISCOVERY_TOOL" > discovery.json' }
    }
  }
  post { always { archiveArtifacts artifacts: 'discovery.json', allowEmptyArchive: true } }
}
