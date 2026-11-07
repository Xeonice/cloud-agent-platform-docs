pipeline {
  agent { label 'agent-platform-linux-upgrade-evidence' }
  options { disableConcurrentBuilds();skipDefaultCheckout(true);timestamps();timeout(time:240,unit:'MINUTES') }
  parameters {
    string(name:'ROOT_SHA',defaultValue:'',description:'Pinned project source')
    string(name:'API_SHA',defaultValue:'',description:'Pinned API source')
    string(name:'WEB_SHA',defaultValue:'',description:'Pinned Web source')
    string(name:'INSTANCE_PACKAGE_BUILD',defaultValue:'',description:'Actual architecture package build')
  }
  environment { NODE22='/usr/local/bin/node';RELEASE_TOOL='/opt/agent-platform/tools/deploy/jenkins/project-release.mjs';EVIDENCE_TOOL='/opt/agent-platform/tools/deploy/jenkins/upgrade-evidence.mjs' }
  stages {
    stage('Prepare immutable isolated native inputs') {
      steps {
        sh '"$NODE22" /opt/agent-platform/tools/deploy/containers/qualification-workspace.mjs'
        deleteDir()
        sh '"$NODE22" "$RELEASE_TOOL" prepare-evidence "$ROOT_SHA" "$API_SHA" "$WEB_SHA" "$INSTANCE_PACKAGE_BUILD" "$WORKSPACE" > evidence-input.json'
      }
    }
    stage('Real continuity, combinations and fault matrix') {
      steps { sh '"$NODE22" "$EVIDENCE_TOOL" evidence-input.json' }
    }
  }
  post { always { archiveArtifacts artifacts:'upgrade-evidence/*.json,evidence-input.json',allowEmptyArchive:true,fingerprint:true,followSymlinks:false } }
}
