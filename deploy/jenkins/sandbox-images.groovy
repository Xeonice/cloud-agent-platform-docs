pipeline {
  agent { label 'agent-platform-deploy' }
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 190, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '60', numToKeepStr: '30'))
  }
  parameters {
    string(name: 'SHA', defaultValue: '', description: 'Pinned API commit; blank resolves the trusted REF before check/publish')
    string(name: 'REF', defaultValue: 'refs/heads/feat/design-v2-migration', description: 'Trusted API branch or refs/tags/sandbox-image-v<version>; never a PR')
    string(name: 'TAG', defaultValue: '', description: 'Immutable OCI version; Git sandbox-image tag must match, blank derives pinned CLI versions + SHA')
    choice(name: 'MODE', choices: ['check', 'publish'], description: 'Check coordinates and native builder, or explicitly publish both provider tiers')
  }
  environment {
    NODE22 = '@NODE22@'
    IMAGE_TOOL = '@JENKINS_SOURCE@/deploy/jenkins/sandbox-images.mjs'
  }
  stages {
    stage('Resolve pinned image source') {
      steps {
        deleteDir()
        script {
          env.IMAGE_SHA = params.SHA
          if (!env.IMAGE_SHA) {
            sh '"$NODE22" "$IMAGE_TOOL" head "$REF" > sandbox-image-head.json'
            env.IMAGE_SHA = readJSON(file: 'sandbox-image-head.json').sha
          }
        }
      }
    }
    stage('Two-tier native build and registry verification') {
      steps {
        sh '"$NODE22" "$IMAGE_TOOL" "$IMAGE_SHA" "$REF" "$TAG" "$MODE" > sandbox-images.json'
        script {
          def result = readJSON(file: 'sandbox-images-result.json')
          currentBuild.description = "${env.IMAGE_SHA.take(12)} · ${params.MODE} · ${result.status}"
          if (params.MODE == 'publish' && result.status != 'published') { error('The two provider images were not both published and verified anonymously') }
          if (params.MODE == 'check' && result.status != 'checked') { error('Image coordinates or dedicated native builder checks failed') }
        }
      }
    }
  }
  post { always { archiveArtifacts artifacts: 'sandbox-image-head.json,sandbox-images.json,sandbox-images-result.json,sandbox-images.log,*-build.json', allowEmptyArchive: true, fingerprint: true, followSymlinks: false } }
}
