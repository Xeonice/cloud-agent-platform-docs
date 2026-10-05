pipeline {
  agent none
  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 90, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '30', numToKeepStr: '100', artifactNumToKeepStr: '50'))
  }
  parameters {
    string(name: 'SHA', defaultValue: '', description: 'Exact commit in Xeonice/agent-platform-web')
    string(name: 'REF', defaultValue: 'refs/heads/main', description: 'Branch or open PR head; PRs run only on the isolated CI account')
    string(name: 'ROOT_SHA', defaultValue: '', description: 'Umbrella project commit for this CI run')
    string(name: 'API_SHA', defaultValue: '', description: 'API commit pinned by the umbrella project')
  }
  environment {
    NODE22 = '@NODE22@'
    PUBLIC_WEB_TOOL = '/Library/Application Support/AgentPlatform/jenkins-tools/jenkins-web.mjs'
    TRUSTED_WEB_TOOL = '@JENKINS_SOURCE@/deploy/jenkins/jenkins-web.mjs'
    CONTRACT_CHILD_NUMBER = ''
    CONTRACT_CHILD_RESULT = 'NOT_RUN'
  }
  stages {
    stage('Prepare public production build settings') {
      when { expression { params.REF == 'refs/heads/feat/design-v2-migration' } }
      agent { label 'agent-platform-deploy' }
      steps {
        // No checkout and no repository code in this credential-bearing stage.
        deleteDir()
        sh '"$NODE22" "$TRUSTED_WEB_TOOL" prepare-env "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"'
        stash name: 'public-vercel-cache', includes: 'public-vercel-cache/project.json,public-vercel-cache/production.env,public-vercel-cache/provenance.json', useDefaultExcludes: false
      }
    }
    stage('Local web CI and packaging') {
      agent { label 'agent-platform-ci' }
      stages {
        stage('Checkout exact commit') {
          steps {
            deleteDir()
            sh '"$NODE22" "$PUBLIC_WEB_TOOL" checkout "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"'
            script { if (params.REF == 'refs/heads/feat/design-v2-migration') unstash 'public-vercel-cache' }
          }
        }
        stage('Install locked dependencies and Chromium') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" install "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('Typecheck') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" typecheck "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('Lint') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" lint "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('Format') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" format "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('Story coverage') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" stories "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('Mock contract anchoring') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" mock-contracts "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('No emoji gate') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" no-emoji "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('OpenAPI drift') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" openapi "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('All acceptance tests') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" acceptance "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('All Storybook interaction tests') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" storybook "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('Portable Storybook build') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" storybook-build "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('Local production build') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" build "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
        stage('Package and fingerprint artifacts') { steps { sh '"$NODE22" "$PUBLIC_WEB_TOOL" package "$SHA" "$REF" "$WORKSPACE" "$ROOT_SHA" "$API_SHA"' } }
      }
      post {
        always {
          // Keep the archive list literal. Never archive source/.vercel, env,
          // node_modules, the trusted account, or authentication command output.
          archiveArtifacts artifacts: 'web-artifacts/web-ci.json,web-artifacts/manifest.json,web-artifacts/acceptance.json,web-artifacts/acceptance.xml,web-artifacts/storybook.json,web-artifacts/storybook.xml,web-artifacts/source.tar.gz,web-artifacts/prebuilt.tar.gz,web-artifacts/storybook.tar.gz', allowEmptyArchive: true, fingerprint: true, followSymlinks: false
          junit testResults: 'web-artifacts/acceptance.xml,web-artifacts/storybook.xml', allowEmptyResults: true
          script { currentBuild.description = "${params.REF} @ ${params.SHA.take(12)} · project ${params.ROOT_SHA.take(12)}" }
        }
      }
    }
    stage('Real cross repository browser acceptance') {
      // This stage inherits agent none. The preceding CI stage (including its
      // archive post) has released mac-ci before the contract child needs it.
      steps {
        script {
          if (![params.ROOT_SHA, params.API_SHA, params.SHA].every { it ==~ /[a-f0-9]{40}/ }) {
            error('Cross repository acceptance requires three exact commits')
          }
          env.CONTRACT_CHILD_RESULT = 'WAITING'
          try {
            def result = build job: 'agent-platform-contract', parameters: [string(name: 'ROOT_SHA', value: params.ROOT_SHA), string(name: 'API_SHA', value: params.API_SHA), string(name: 'WEB_SHA', value: params.SHA)], wait: true, propagate: false
            env.CONTRACT_CHILD_NUMBER = result.number.toString()
            env.CONTRACT_CHILD_RESULT = result.result ?: 'INCOMPLETE'
          } catch (failure) {
            env.CONTRACT_CHILD_RESULT = 'INCOMPLETE'
            throw failure
          }
          if (env.CONTRACT_CHILD_RESULT != 'SUCCESS') {
            error("Real cross repository browser acceptance ${env.CONTRACT_CHILD_RESULT}; Web CI is not successful")
          }
        }
      }
    }
  }
  post {
    always {
      // Allocate an executor only after the child has completed or waiting was
      // interrupted. The report contains no repository output or credentials.
      node('agent-platform-deploy') {
        script {
          def fullSha = { value -> value ==~ /[a-f0-9]{40}/ ? value : null }
          def childNumber = env.CONTRACT_CHILD_NUMBER ==~ /[1-9][0-9]*/ ? env.CONTRACT_CHILD_NUMBER.toInteger() : null
          def childResult = env.CONTRACT_CHILD_RESULT in ['SUCCESS', 'FAILURE', 'UNSTABLE', 'ABORTED', 'NOT_BUILT', 'NOT_RUN', 'WAITING', 'INCOMPLETE'] ? env.CONTRACT_CHILD_RESULT : 'INCOMPLETE'
          def report = [
            schemaVersion: 1,
            job: 'agent-platform-web',
            buildNumber: env.BUILD_NUMBER.toInteger(),
            state: childResult == 'SUCCESS' ? 'passed' : childResult == 'NOT_RUN' ? 'not-run' : 'failed',
            commits: [root: fullSha(params.ROOT_SHA), api: fullSha(params.API_SHA), web: fullSha(params.SHA)],
            child: [job: 'agent-platform-contract', number: childNumber, result: childResult, url: childNumber ? "http://127.0.0.1:8080/job/agent-platform-contract/${childNumber}/" : null],
            parameters: [ROOT_SHA: fullSha(params.ROOT_SHA), API_SHA: fullSha(params.API_SHA), WEB_SHA: fullSha(params.SHA)]
          ]
          dir('web-cross-repository') {
            deleteDir()
            writeJSON file: 'contract.json', json: report, pretty: 2
          }
          archiveArtifacts artifacts: 'web-cross-repository/contract.json', allowEmptyArchive: false, fingerprint: true, followSymlinks: false
        }
      }
    }
  }
  // No trigger or deployment here. The umbrella release job verifies this job's
  // final SUCCESS and all three SHAs, then adopts/uploads/promotes on mac-deploy.
}
