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
    RELEASE_TOOL = '/opt/agent-platform/tools/deploy/jenkins/project-release.mjs'
    SIGN_TOOL = '/opt/agent-platform/tools/deploy/upgrade/build-distribution.mjs'
    PUBLISH_TOOL = '/opt/agent-platform/tools/deploy/upgrade/publish-distribution.mjs'
  }
  stages {
    stage('Discover and pin complete project') {
      agent { label 'agent-platform-linux-publisher' }
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
          def result = build job: 'agent-platform-web', parameters: [string(name: 'SHA', value: env.WEB_SHA), string(name: 'REF', value: 'refs/heads/main'), string(name: 'ROOT_SHA', value: env.ROOT_SHA), string(name: 'API_SHA', value: env.API_SHA)], wait: true, propagate: false
          env.WEB_BUILD = result.number.toString()
          if (result.result != 'SUCCESS') { error("Frontend CI ${result.result}; nothing is uploaded") }
        }
      }
    }
    stage('Retain verified frontend build for retry') {
      agent { label 'agent-platform-linux-publisher' }
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
      agent { label 'agent-platform-linux-publisher' }
      when { environment name: 'RELEASE_REQUIRED', value: 'true' }
      steps { sh '"$NODE22" "$RELEASE_TOOL" record-build "$PLAN_PATH" contract "$CONTRACT_BUILD" > verified-contract-build.json' }
    }
    stage('Backend CI and immutable image package only') {
      when { environment name: 'RELEASE_REQUIRED', value: 'true' }
      steps {
        script {
          def result = build job: 'agent-platform-api', parameters: [string(name: 'SHA', value: env.API_SHA), string(name: 'ROOT_SHA', value: env.ROOT_SHA)], wait: true, propagate: false
          env.API_BUILD = result.number.toString()
          if (result.result != 'SUCCESS') { error("API build ${result.result}; distribution stopped") }
        }
      }
    }
    stage('Actual architecture self-hosted instance package') {
      when { environment name: 'RELEASE_REQUIRED', value: 'true' }
      steps {
        script {
          def result = build job: 'agent-platform-instance-package', parameters: [string(name: 'ROOT_SHA',value:env.ROOT_SHA),string(name:'API_SHA',value:env.API_SHA),string(name:'WEB_SHA',value:env.WEB_SHA),string(name:'RELEASE_ID',value:env.RELEASE_TAG),string(name:'PLATFORM',value:'linux'),string(name:'ARCH',value:'arm64')],wait:true,propagate:false
          env.INSTANCE_PACKAGE_BUILD = result.number.toString()
          if (result.result != 'SUCCESS') { error("Actual architecture package ${result.result}; no version published") }
        }
      }
    }
    stage('Full upgrade continuity and recovery evidence') {
      when { environment name: 'RELEASE_REQUIRED', value: 'true' }
      steps {
        script {
          def result = build job:'agent-platform-upgrade-evidence',parameters:[string(name:'ROOT_SHA',value:env.ROOT_SHA),string(name:'API_SHA',value:env.API_SHA),string(name:'WEB_SHA',value:env.WEB_SHA),string(name:'INSTANCE_PACKAGE_BUILD',value:env.INSTANCE_PACKAGE_BUILD)],wait:true,propagate:false
          env.UPGRADE_EVIDENCE_BUILD=result.number.toString()
          if (result.result != 'SUCCESS') { error("Upgrade acceptance ${result.result}; signed release withheld") }
        }
      }
    }
    stage('Package complete downloadable release') {
      agent { label 'agent-platform-linux-publisher' }
      when { allOf { environment name: 'RELEASE_REQUIRED', value: 'true'; environment name: 'RELEASE_READY', value: 'true' } }
      steps { sh '"$NODE22" "$RELEASE_TOOL" package "$PLAN_PATH" "$API_BUILD" "$WEB_BUILD" "$CONTRACT_BUILD" > packaged.json' }
    }
    stage('Sign fixed manifest and architecture package') {
      agent { label 'agent-platform-linux-publisher' }
      when { environment name:'RELEASE_REQUIRED',value:'true' }
      steps {
        sh '"$NODE22" "$RELEASE_TOOL" prepare-distribution "$PLAN_PATH" "$INSTANCE_PACKAGE_BUILD" "$UPGRADE_EVIDENCE_BUILD" > distribution-config.json'
        script { env.DISTRIBUTION_OUTPUT = readJSON(file:'distribution-config.json').outputRoot }
        sh '"$NODE22" "$SIGN_TOOL" sign distribution-config.json > signed-distribution.json'
      }
    }
    stage('Publish immutable signed distribution only') {
      agent { label 'agent-platform-linux-publisher' }
      when { environment name:'RELEASE_REQUIRED',value:'true' }
      steps {
        withCredentials([string(credentialsId:'agent-platform-distribution-publisher',variable:'GITHUB_TOKEN')]) {
          sh '"$NODE22" "$PUBLISH_TOOL" "$DISTRIBUTION_OUTPUT" > github-distribution.json'
        }
        script { currentBuild.description = "${env.RELEASE_TAG} · published; instances unchanged" }
      }
    }

  }
  post {
    always {
      node('agent-platform-linux-publisher') {
        archiveArtifacts artifacts:'project-plan.json,project-pin.json,verified-web-build.json,verified-contract-build.json,packaged.json,distribution-config.json,signed-distribution.json,github-distribution.json',allowEmptyArchive:true,fingerprint:true,followSymlinks:false
      }
    }
  }
}
