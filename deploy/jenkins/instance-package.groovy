pipeline {
  agent { label "agent-platform-${params.PLATFORM}-${params.ARCH}-package" }
  options { disableConcurrentBuilds(); skipDefaultCheckout(true); timestamps(); timeout(time: 120, unit: 'MINUTES') }
  parameters {
    string(name: 'ROOT_SHA', defaultValue: '', description: 'Pinned project source')
    string(name: 'API_SHA', defaultValue: '', description: 'Pinned API source')
    string(name: 'WEB_SHA', defaultValue: '', description: 'Pinned Web source')
    string(name: 'RELEASE_ID', defaultValue: '', description: 'Immutable release identifier')
    choice(name: 'PLATFORM', choices: ['linux', 'darwin'], description: 'Actual package worker OS')
    choice(name: 'ARCH', choices: ['arm64', 'x64'], description: 'Actual package worker architecture')
  }
  environment { NODE22 = '/usr/local/bin/node'; PACKAGE_TOOL = '/opt/agent-platform/tools/deploy/jenkins/instance-package.mjs' }
  stages {
    stage('Build actual architecture self-hosted package') {
      steps {
        deleteDir()
        script {
          if (!['linux','darwin'].contains(params.PLATFORM) || !['arm64','x64'].contains(params.ARCH)) { error('Unsupported package worker') }
          def reusePath = "/srv/agent-platform/component-reuse/${params.PLATFORM}-${params.ARCH}/current.json"
          def previousBundle = fileExists(reusePath) ? readJSON(file:reusePath) : null
          def migrationPath = '/run/agent-platform/jenkins-tools/upgrade-migration.json'
          def migrationPlan = fileExists(migrationPath) ? readJSON(file:migrationPath) : null
          writeJSON file: 'package-input.json', json: [workspace: "${env.WORKSPACE}/instance-package", commits: [project:params.ROOT_SHA,api:params.API_SHA,web:params.WEB_SHA],releaseId:params.RELEASE_ID,channel:'stable',distributionOrigin:env.PLATFORM_DISTRIBUTION_ORIGIN,previousBundle:previousBundle,migrationPlan:migrationPlan,protocols:[api:[min:1,max:1],web:[min:1,max:1],installer:[min:1,max:1]]]
        }
        sh '"$NODE22" "$PACKAGE_TOOL" package-input.json > bundle-result.json'
        script {
          def proof = readJSON(file:'bundle-result.json')
          if (proof.builtOn.platform != params.PLATFORM || proof.builtOn.arch != params.ARCH) { error('Package was not built on its named architecture') }
        }
      }
    }
  }
  post { always { archiveArtifacts artifacts:'bundle-result.json,instance-package/distribution/*',allowEmptyArchive:true,fingerprint:true,followSymlinks:false } }
}
