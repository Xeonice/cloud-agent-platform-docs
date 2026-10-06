pipeline {
  agent none
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 4, unit: 'HOURS')
    buildDiscarder(logRotator(daysToKeepStr: '90', numToKeepStr: '100', artifactNumToKeepStr: '30'))
  }
  parameters {
    string(name: 'TAG', defaultValue: '', description: 'Optional fresh immutable release tag; automatic v0.3 patch version otherwise')
    string(name: 'REQUEST_KEY', defaultValue: '', description: 'Pinned project key from Jenkins discovery; empty for manual publication')
  }
  environment {
    NODE22 = '/usr/local/bin/node'
    RELEASE_TOOL = '/opt/agent-platform/tools/project-release.mjs'
    WEB_TOOL = '/opt/agent-platform/tools/jenkins-web.mjs'
    MONITOR_TOOL = '/opt/agent-platform/tools/api-container.mjs'
  }
  stages {
    stage('Discover and pin complete project') {
      agent { label 'agent-platform-linux-deploy' }
      steps {
        script {
          env.RELEASE_REQUIRED = 'false'
          env.RELEASE_READY = 'true'
        }
        sh '"$NODE22" "$RELEASE_TOOL" plan "$TAG" > project-plan.json'
        script {
          def plan = readJSON(file: 'project-plan.json')
          if (params.REQUEST_KEY && params.REQUEST_KEY != plan.key) { error('Discovery request was superseded by a different project commit set') }
          env.PLAN_PATH = plan.planPath
          env.ROOT_SHA = plan.commits.project
          env.API_SHA = plan.commits.api
          env.WEB_SHA = plan.commits.web
          env.RELEASE_TAG = plan.tag
          env.RELEASE_REQUIRED = plan.unchanged ? 'false' : 'true'
          env.WEB_BUILD = plan.savedBuilds?.web?.toString() ?: ''
          env.CONTRACT_BUILD = plan.savedBuilds?.contract?.toString() ?: ''
          currentBuild.description = "${plan.tag} · ${plan.unchanged ? 'current' : 'preparing'}"
        }
        sh '"$NODE22" "$RELEASE_TOOL" pin-web "$PLAN_PATH" > project-pin.json'
      }
    }
    stage('Complete frontend CI and local prebuilt package') {
      when { allOf { environment name: 'RELEASE_REQUIRED', value: 'true'; expression { !env.WEB_BUILD } } }
      steps {
        script {
          def result = build job: 'agent-platform-web', parameters: [string(name: 'SHA', value: env.WEB_SHA), string(name: 'REF', value: 'refs/heads/feat/design-v2-migration'), string(name: 'ROOT_SHA', value: env.ROOT_SHA), string(name: 'API_SHA', value: env.API_SHA)], wait: true, propagate: false
          env.WEB_BUILD = result.number.toString()
          if (result.result != 'SUCCESS') { error("Frontend CI ${result.result}; nothing is uploaded") }
        }
      }
    }
    stage('Retain verified frontend build for retry') {
      agent { label 'agent-platform-linux-deploy' }
      when { environment name: 'RELEASE_REQUIRED', value: 'true' }
      steps {
        sh '"$NODE22" "$RELEASE_TOOL" record-build "$PLAN_PATH" web "$WEB_BUILD" > verified-web-build.json'
        script {
          def verified = readJSON(file: 'verified-web-build.json')
          if (verified.savedBuilds?.contract) { env.CONTRACT_BUILD = verified.savedBuilds.contract.toString() }
        }
      }
    }
    stage('Documentation and cross repository acceptance') {
      when { allOf { environment name: 'RELEASE_REQUIRED', value: 'true'; expression { !env.CONTRACT_BUILD } } }
      steps {
        script {
          def result = build job: 'agent-platform-contract', parameters: [string(name: 'ROOT_SHA', value: env.ROOT_SHA), string(name: 'API_SHA', value: env.API_SHA), string(name: 'WEB_SHA', value: env.WEB_SHA)], wait: true, propagate: false
          env.CONTRACT_BUILD = result.number.toString()
          if (result.result != 'SUCCESS') { error("Complete project acceptance ${result.result}; nothing is uploaded") }
        }
      }
    }
    stage('Retain verified acceptance build for retry') {
      agent { label 'agent-platform-linux-deploy' }
      when { environment name: 'RELEASE_REQUIRED', value: 'true' }
      steps { sh '"$NODE22" "$RELEASE_TOOL" record-build "$PLAN_PATH" contract "$CONTRACT_BUILD" > verified-contract-build.json' }
    }
    stage('Docker backend CI and safe service publication') {
      when { environment name: 'RELEASE_REQUIRED', value: 'true' }
      steps {
        script {
          def result = build job: 'agent-platform-api', parameters: [string(name: 'SHA', value: env.API_SHA), string(name: 'ROOT_SHA', value: env.ROOT_SHA)], wait: true, propagate: false
          env.API_BUILD = result.number.toString()
          if (result.result == 'UNSTABLE') {
            env.RELEASE_READY = 'false'
            currentBuild.description = "${env.RELEASE_TAG} · waiting for safe API publication"
            unstable('Production is busy or the release needs review. Jenkins discovery retries safely; no frontend or GitHub release is published.')
          } else if (result.result != 'SUCCESS') { error("API publication ${result.result}; frontend and GitHub publication stopped") }
        }
      }
    }
    stage('Adopt and upload frontend bits to Vercel') {
      agent { label 'agent-platform-linux-deploy' }
      when { allOf { environment name: 'RELEASE_REQUIRED', value: 'true'; environment name: 'RELEASE_READY', value: 'true' } }
      steps {
        sh 'mkdir -m 700 "$WORKSPACE/web-upload-$BUILD_NUMBER"'
        sh '"$NODE22" "$RELEASE_TOOL" fetch-web "$PLAN_PATH" "$WEB_BUILD" "$WORKSPACE/web-upload-$BUILD_NUMBER" > web-adoption.json'
        sh '"$NODE22" "$WEB_TOOL" adopt "$WEB_SHA" refs/heads/feat/design-v2-migration "$WORKSPACE/web-upload-$BUILD_NUMBER" "$ROOT_SHA" "$API_SHA" > web-adopted.json'
        sh '"$NODE22" "$WEB_TOOL" upload "$WEB_SHA" refs/heads/feat/design-v2-migration "$WORKSPACE/web-upload-$BUILD_NUMBER" "$ROOT_SHA" "$API_SHA" > vercel-upload.json'
        sh '"$NODE22" "$WEB_TOOL" promote "$WEB_SHA" refs/heads/feat/design-v2-migration "$WORKSPACE/web-upload-$BUILD_NUMBER" "$ROOT_SHA" "$API_SHA" > vercel-promoted.json'
      }
    }
    stage('Package complete downloadable release') {
      agent { label 'agent-platform-linux-deploy' }
      when { allOf { environment name: 'RELEASE_REQUIRED', value: 'true'; environment name: 'RELEASE_READY', value: 'true' } }
      steps { sh '"$NODE22" "$RELEASE_TOOL" package "$PLAN_PATH" "$API_BUILD" "$WEB_BUILD" "$CONTRACT_BUILD" > packaged.json' }
    }
    stage('Upload and verify GitHub Release') {
      agent { label 'agent-platform-linux-deploy' }
      when { allOf { environment name: 'RELEASE_REQUIRED', value: 'true'; environment name: 'RELEASE_READY', value: 'true' } }
      steps {
        sh '"$NODE22" "$RELEASE_TOOL" upload "$PLAN_PATH" > github-release.json'
        script { currentBuild.description = "${env.RELEASE_TAG} · published to GitHub and production" }
      }
    }
  }
  post {
    always {
      node('agent-platform-linux-deploy') {
        script {
          def folder = "runtime-report-${env.BUILD_NUMBER}"
          def code = sh(script: '"$NODE22" "$MONITOR_TOOL" monitor "runtime-report-$BUILD_NUMBER"', returnStatus: true)
          if (code == 2) { unstable('Service snapshot reports an unhealthy runtime') }
          if (code != 0 && code != 2) { error('Runtime report collection failed') }
          archiveArtifacts artifacts: "project-plan.json,project-pin.json,verified-web-build.json,verified-contract-build.json,web-adoption.json,web-adopted.json,vercel-upload.json,vercel-promoted.json,packaged.json,github-release.json,${folder}/report.json,${folder}/report.html,${folder}/api.redacted.log,${folder}/tunnel.redacted.log,${folder}/cicd.redacted.log,${folder}/build.redacted.log", allowEmptyArchive: true, fingerprint: true, followSymlinks: false
          publishHTML(target: [allowMissing: false, alwaysLinkToLastBuild: true, keepAll: true, reportDir: folder, reportFiles: 'report.html', reportName: 'Service status and logs'])
        }
      }
    }
  }
}
