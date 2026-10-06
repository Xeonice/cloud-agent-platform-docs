import jenkins.model.Jenkins
import jenkins.model.JenkinsLocationConfiguration
import jenkins.install.InstallState
import hudson.security.SecurityRealm
import hudson.security.AuthorizationStrategy
import hudson.security.HudsonPrivateSecurityRealm
import hudson.security.FullControlOnceLoggedInAuthorizationStrategy
import hudson.security.csrf.DefaultCrumbIssuer
import hudson.slaves.OfflineCause
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.security.SecureRandom

def j = Jenkins.get()
def root = j.rootDir.toPath()
def mode = System.getenv('AGENT_PLATFORM_CONTROLLER_MODE')
if (!(mode in ['lab', 'migration', 'active'])) throw new IllegalStateException('Invalid controller mode')

// This policy applies to fresh and imported Home volumes; it never resets imported keys or users.
j.setNumExecutors(0)
j.setSlaveAgentPort(-1)
j.save()
if (mode == 'lab' && (!j.getAllItems().isEmpty() || !j.getNodes().isEmpty()))
    throw new IllegalStateException('The lab requires an empty dedicated Home; imported jobs and agents are refused')

def lock = new groovy.json.JsonSlurper().parse(new File('/opt/agent-platform/plugins.lock.json'))
if (Jenkins.VERSION != lock.jenkins || Runtime.version().feature() != lock.javaMajor)
    throw new IllegalStateException('Controller core or Java differs from the reviewed lock')
def actual = j.getPluginManager().getPlugins().collectEntries { [(it.shortName): it] }
if (actual.keySet() != (lock.plugins.collect { it.name } as Set))
    throw new IllegalStateException('The controller plugin set differs from the reviewed lock')
lock.plugins.each { plugin ->
    if (actual[plugin.name].version != plugin.version || !actual[plugin.name].isActive())
        throw new IllegalStateException("Pinned controller plugin is unavailable: ${plugin.name}")
}

def state = root.resolve('container-state')
Files.createDirectories(state)
Files.setPosixFilePermissions(state, PosixFilePermissions.fromString('rwx------'))
def admin = state.resolve('lab-admin.json')
if (mode == 'lab' && !Files.exists(admin)) {
    if (j.getSecurityRealm() != SecurityRealm.NO_AUTHENTICATION)
        throw new IllegalStateException('Existing authentication cannot be replaced by lab bootstrap')
    byte[] bytes = new byte[36]
    new SecureRandom().nextBytes(bytes)
    def password = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    def realm = new HudsonPrivateSecurityRealm(false)
    realm.createAccount('douglasdong', password)
    j.setSecurityRealm(realm)
    def auth = new FullControlOnceLoggedInAuthorizationStrategy()
    auth.setAllowAnonymousRead(false)
    j.setAuthorizationStrategy(auth)
    j.setCrumbIssuer(new DefaultCrumbIssuer(true))
    j.save()
    Files.createFile(admin, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString('rw-------')))
    Files.writeString(admin, groovy.json.JsonOutput.toJson([username: 'douglasdong', password: password]))
}
if (j.getSecurityRealm() == SecurityRealm.NO_AUTHENTICATION ||
    j.getAuthorizationStrategy() == AuthorizationStrategy.UNSECURED)
    throw new IllegalStateException('Controller authentication is required')

if (mode == 'migration') {
    j.getAllItems().each { item ->
        if (item.metaClass.respondsTo(item, 'setDisabled', Boolean.TYPE)) {
            item.setDisabled(true)
            item.save()
        }
    }
    j.getNodes().each { node ->
        def computer = node.toComputer()
        if (computer != null) computer.setTemporarilyOffline(true, new OfflineCause.ByCLI('Container migration requires explicit agent activation'))
    }
}
def location = System.getenv('AGENT_PLATFORM_JENKINS_URL')
if (!location || !(location ==~ /^http:\/\/127\.0\.0\.1:(18080|8080)\/$/))
    throw new IllegalStateException('A fixed loopback Jenkins URL is required')
JenkinsLocationConfiguration.get().setUrl(location)
j.setInstallState(InstallState.INITIAL_SETUP_COMPLETED)
j.save()
def ready = state.resolve('ready.json')
Files.createFile(ready, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString('rw-------')))
Files.writeString(ready, groovy.json.JsonOutput.toJson([jenkins: lock.jenkins, javaMajor: lock.javaMajor, mode: mode, plugins: lock.plugins.size(), executors: 0]))
println('Container controller policy verified; authentication required; built-in executors disabled.')
