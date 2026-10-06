pipeline {
  agent { label 'agent-platform-linux-ci' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 45, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '30', numToKeepStr: '100', artifactNumToKeepStr: '50'))
  }
  parameters {
    string(name: 'SHA', defaultValue: '', description: 'Exact 40-character commit from the fixed API repository')
    string(name: 'REF', defaultValue: 'refs/heads/main', description: 'Fixed repository branch or open pull-request head')
  }
  environment {
    NODE22 = '/usr/local/bin/node'
    CI_TOOL = '/opt/agent-platform/tools/jenkins-ci.mjs'
  }
  stages {
    stage('Checkout exact commit') { steps { sh '"$NODE22" "$CI_TOOL" checkout "$SHA" "$REF"' } }
    stage('Install locked dependencies') { steps { sh '"$NODE22" "$CI_TOOL" install "$SHA" "$REF"' } }
    stage('Typecheck') { steps { sh '"$NODE22" "$CI_TOOL" typecheck "$SHA" "$REF"' } }
    stage('Lint') { steps { sh '"$NODE22" "$CI_TOOL" lint "$SHA" "$REF"' } }
    stage('Format') { steps { sh '"$NODE22" "$CI_TOOL" format "$SHA" "$REF"' } }
    stage('Default image consistency') { steps { sh '"$NODE22" "$CI_TOOL" default-image "$SHA" "$REF"' } }
    stage('Acceptance tests') { steps { sh '"$NODE22" "$CI_TOOL" acceptance "$SHA" "$REF"' } }
    stage('Provider fixture capabilities') { steps { sh '"$NODE22" "$CI_TOOL" provider-caps "$SHA" "$REF"' } }
    stage('Build') { steps { sh '"$NODE22" "$CI_TOOL" build "$SHA" "$REF"' } }
    stage('OpenAPI drift') { steps { sh '"$NODE22" "$CI_TOOL" openapi "$SHA" "$REF"' } }
    stage('Native SQLite and BoxLite import') { steps { sh '"$NODE22" "$CI_TOOL" native "$SHA" "$REF"' } }
  }
  post {
    always {
      archiveArtifacts artifacts: 'commit.json,native-import.json,source/reports/acceptance/*.json,source/reports/acceptance/*.xml,source/acceptance/execution-report.json', allowEmptyArchive: true, fingerprint: true, followSymlinks: false
      junit testResults: 'source/reports/acceptance/*.xml', allowEmptyResults: true
      script { currentBuild.description = "${params.REF} @ ${params.SHA.take(12)}" }
    }
  }
}
