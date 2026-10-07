import jenkins.model.Jenkins
import hudson.security.HudsonPrivateSecurityRealm
import hudson.security.FullControlOnceLoggedInAuthorizationStrategy
import hudson.security.csrf.DefaultCrumbIssuer
import hudson.slaves.DumbSlave
import hudson.slaves.JNLPLauncher
import hudson.slaves.RetentionStrategy
import hudson.model.Node
import hudson.model.StringParameterDefinition
import hudson.model.ChoiceParameterDefinition
import hudson.model.ParametersDefinitionProperty
import org.jenkinsci.plugins.workflow.job.WorkflowJob
import org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition
import jenkins.security.ApiTokenProperty
import jenkins.install.InstallState
import jenkins.model.JenkinsLocationConfiguration
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

def j = Jenkins.get()
def root = j.rootDir.toPath()
def controllerMode = System.getenv('AGENT_PLATFORM_CONTROLLER_MODE')
def location = System.getenv('AGENT_PLATFORM_JENKINS_URL') ?: JenkinsLocationConfiguration.get().getUrl() ?: 'http://127.0.0.1:8080/'
def allowedLocations = controllerMode == 'lab' ? ['http://127.0.0.1:18080/'] : ['http://127.0.0.1:8080/', 'https://jenkins.douglasdong.com/']
if (!(location in allowedLocations)) throw new IllegalStateException('An exact approved Jenkins URL is required')
def settings = new groovy.json.JsonSlurper().parse(root.resolve('bootstrap-settings.json').toFile())
def secretDir = root.resolve('bootstrap-secrets')
Files.createDirectories(secretDir)
Files.setPosixFilePermissions(secretDir, PosixFilePermissions.fromString('rwx------'))
def writeSecret = { path, content ->
    if (!Files.exists(path)) Files.createFile(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString('rw-------')))
    Files.writeString(path, content)
    Files.setPosixFilePermissions(path, PosixFilePermissions.fromString('rw-------'))
}
if (!Files.exists(secretDir.resolve('admin-api.json'))) {
    def credential = new groovy.json.JsonSlurper().parse(secretDir.resolve('admin-login.json').toFile())
    def realm = new HudsonPrivateSecurityRealm(false)
    def user = realm.createAccount(credential.username, credential.password)
    j.setSecurityRealm(realm)
    def auth = new FullControlOnceLoggedInAuthorizationStrategy()
    auth.setAllowAnonymousRead(false)
    j.setAuthorizationStrategy(auth)
    j.setCrumbIssuer(new DefaultCrumbIssuer(true))
    def token = user.getProperty(ApiTokenProperty.class).tokenStore.generateNewToken('container-bootstrap')
    user.save()
    writeSecret(secretDir.resolve('admin-api.json'), groovy.json.JsonOutput.toJson([username: credential.username, token: token.plainValue]))
}
j.setNumExecutors(0)
j.setSlaveAgentPort(-1)
JenkinsLocationConfiguration.get().setUrl(location)
[
    [name: 'linux-deploy', label: 'agent-platform-linux-deploy', remote: '/home/jenkins/agent'],
    [name: 'linux-ci', label: 'agent-platform-linux-ci', remote: '/home/jenkins/agent'],
    [name: 'linux-web-amd64', label: 'agent-platform-web-build', remote: '/home/jenkins/agent']
].each { spec ->
    if (j.getNode(spec.name) == null) j.addNode(new DumbSlave(spec.name, 'Fixed Mac mini container agent', spec.remote, '1', Node.Mode.EXCLUSIVE, spec.label, new JNLPLauncher(), new RetentionStrategy.Always(), []))
    writeSecret(root.resolve("secrets/${spec.name}.secret"), j.getNode(spec.name).toComputer().getJnlpMac())
}
[
    [name: 'agent-platform-api', file: 'api.groovy'],
    [name: 'agent-platform-native-ci', file: 'native-ci.groovy'],
    [name: 'agent-platform-service-monitor', file: 'monitor.groovy'],
    [name: 'agent-platform-ci-discovery', file: 'discover.groovy'],
    [name: 'agent-platform-release', file: 'release.groovy'],
    [name: 'agent-platform-contract', file: 'contract.groovy'],
    [name: 'agent-platform-web', file: 'web.groovy'],
    [name: 'agent-platform-mutation', file: 'mutation.groovy'],
    [name: 'agent-platform-sandbox-images', file: 'sandbox-images.groovy']
].each { spec ->
    if (!Files.exists(root.resolve("managed-pipelines/${spec.file}"))) return
    def job = j.getItem(spec.name)
    if (job == null) job = j.createProject(WorkflowJob.class, spec.name)
    job.setDefinition(new CpsFlowDefinition(Files.readString(root.resolve("managed-pipelines/${spec.file}")), true))
    job.setDescription('Managed from the cloud-agent-platform-docs deployment configuration. Fixed repositories; isolated Linux CI and trusted container deployment; immutable commit tracking.')
    def parameters = [
        'agent-platform-api': ['SHA', 'ROOT_SHA'],
        'agent-platform-native-ci': ['SHA', 'REF'],
        'agent-platform-web': ['SHA', 'REF', 'ROOT_SHA', 'API_SHA'],
        'agent-platform-contract': ['ROOT_SHA', 'API_SHA', 'WEB_SHA'],
        'agent-platform-release': ['TAG', 'REQUEST_KEY'],
        'agent-platform-mutation': ['SHA', 'REF', 'MODE', 'BASE_SHA', 'BASE_REF'],
        'agent-platform-sandbox-images': ['SHA', 'REF', 'TAG', 'MODE']
    ][spec.name]
    // Job.addProperty appends; remove every legacy group, including duplicates.
    // Use the complete property list so an old SHA-only first group cannot hide ROOT_SHA.
    job.getAllProperties().findAll { it instanceof ParametersDefinitionProperty }.each { property ->
        job.removeProperty(property)
    }
    if (parameters) job.addProperty(new ParametersDefinitionProperty(parameters.collect { name ->
        if (name == 'MODE') return new ChoiceParameterDefinition(name, spec.name == 'agent-platform-mutation' ? 'full\nchanged' : 'check\npublish', 'Managed build mode')
        def value = name == 'REF' ? 'refs/heads/main' : ''
        return new StringParameterDefinition(name, value, 'Managed immutable build input')
    }))
    job.setDisabled(!settings.enabled)
    job.save()
}
j.setInstallState(InstallState.INITIAL_SETUP_COMPLETED)
j.save()
println('Agent Platform Jenkins configuration loaded; authentication required; built-in executors disabled.')
