import * as fs from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const tools = "/Users/douglasdong/.local/share/agent-platform-jenkins-tools";
const base = "http://127.0.0.1:8080/";
const allowedJobs = new Set([
  "agent-platform-api",
  "agent-platform-native-ci",
  "agent-platform-service-monitor",
  "agent-platform-ci-discovery",
  "agent-platform-web",
  "agent-platform-release",
  "agent-platform-contract",
  "agent-platform-mutation",
  "agent-platform-sandbox-images",
]);
export function activationScript() {
  return `def j=jenkins.model.Jenkins.get()
if (System.getenv('AGENT_PLATFORM_CONTROLLER_MODE') != 'active') throw new IllegalStateException('Switch the controller to active mode before activating managed jobs and agents')
if (j.numExecutors != 0 || j.slaveAgentPort != -1) throw new IllegalStateException('Controller execution isolation is required')
def specs = [
  [name:'linux-deploy', label:'agent-platform-linux-deploy'],
  [name:'linux-ci', label:'agent-platform-linux-ci'],
  [name:'linux-web-amd64', label:'agent-platform-web-build']
]
specs.each { spec ->
  def node=j.getNode(spec.name)
  if(node != null && (node.labelString != spec.label || node.numExecutors != 1 || node.mode != hudson.model.Node.Mode.EXCLUSIVE)) throw new IllegalStateException('A managed agent differs from its fixed policy')
}
def f=new File(j.rootDir,'bootstrap-settings.json')
def s=new groovy.json.JsonSlurper().parse(f)
s.enabled=true
f.text=groovy.json.JsonOutput.toJson(s)
def jobs=[]
${JSON.stringify([...allowedJobs])}.each { name -> def job=j.getItem(name); if(job != null){job.setDisabled(false);job.save();jobs.add(name)} }
def online=[]; def waiting=[]
specs.each { spec ->
  def computer=j.getNode(spec.name)?.toComputer()
  if(computer != null && computer.getChannel() != null){computer.setTemporarilyOffline(false,null);online.add(spec.name)}
  else waiting.add(spec.name)
}
println(groovy.json.JsonOutput.toJson([state:'activated',controllerMode:'active',jobsActivated:jobs,nodesOnline:online,nodesWaitingForConnection:waiting]))`;
}

export async function runManagement(args = process.argv.slice(2)) {
  const [action, name, file] = args;

  if (
    ![
      "status",
      "sync-pipelines",
      "refresh",
      "enable",
      "disable",
      "build",
      "activate",
      "download-agent",
      "build-status",
      "pipeline-lint",
    ].includes(action)
  )
    throw new Error(
      "Use status|sync-pipelines|refresh|enable|disable|build|activate|download-agent|build-status|pipeline-lint",
    );
  const privatePath = join(tools, "admin-api.json");
  const stat = await fs.lstat(privatePath);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error("Unsafe private API credential");
  const credential = JSON.parse(await fs.readFile(privatePath, "utf8"));
  const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString("base64")}`;
  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { authorization, ...options.headers },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Jenkins HTTP ${response.status}`);
    return response;
  }
  async function script(text) {
    const result = await (
      await request("scriptText", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ script: text }),
      })
    ).text();
    if (/Exception|ERROR|groovy\.lang\./.test(result))
      throw new Error(
        "Jenkins configuration failed; server script output is withheld",
      );
    return result.trim();
  }
  if (action === "status") {
    const controller = await (
      await request(
        "api/json?tree=numExecutors,quietingDown,jobs[name,color,buildable,lastBuild[number,result,url,building]]",
      )
    ).json();
    const computers = await (
      await request(
        "computer/api/json?tree=computer[displayName,offline,temporarilyOffline,numExecutors]",
      )
    ).json();
    console.log(JSON.stringify({ controller, computers }, null, 2));
  } else if (action === "sync-pipelines") {
    const directory = dirname(fileURLToPath(import.meta.url));
    const replacements = {
      NODE22:
        "/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node",
      DEPLOY_ROOT: "/Users/douglasdong/.local/share/agent-platform-deploy",
      DEPLOY_CONFIG:
        "/Users/douglasdong/.local/share/agent-platform-deploy/config.json",
      DEPLOY_TOOLS:
        "/Users/douglasdong/.local/share/agent-platform-deploy/tools",
      JENKINS_TOOLS: tools,
      JENKINS_SOURCE: join(tools, "source"),
      COREPACK:
        "/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/lib/node_modules/corepack/dist/corepack.js",
    };
    const files = {};
    for (const name of [
      "api.groovy",
      "native-ci.groovy",
      "monitor.groovy",
      "discover.groovy",
      "release.groovy",
      "contract.groovy",
      "web.groovy",
      "mutation.groovy",
      "sandbox-images.groovy",
    ]) {
      const text = await fs.readFile(join(directory, name), "utf8");
      const rendered = text.replace(/@([A-Z_0-9]+)@/g, (_, key) => {
        if (!replacements[key])
          throw new Error("Unknown pipeline template key");
        return replacements[key].replace(/'/g, "\\'");
      });
      files[name] = Buffer.from(rendered).toString("base64");
    }
    const encoded = Buffer.from(JSON.stringify(files)).toString("base64");
    console.log(
      await script(
        `def j=jenkins.model.Jenkins.get(); def files=new groovy.json.JsonSlurper().parseText(new String('${encoded}'.decodeBase64(),'UTF-8')); files.each { name,value -> def f=new File(j.rootDir,'managed-pipelines/'+name); f.bytes=value.decodeBase64(); java.nio.file.Files.setPosixFilePermissions(f.toPath(),java.nio.file.attribute.PosixFilePermissions.fromString('rw-------')) }; println('Reviewed managed pipeline templates synchronized')`,
      ),
    );
  } else if (action === "refresh") {
    const code = await fs.readFile(
      join(dirname(fileURLToPath(import.meta.url)), "bootstrap.groovy"),
      "utf8",
    );
    console.log(await script(code));
  } else if (["enable", "disable", "build"].includes(action)) {
    if (!allowedJobs.has(name)) throw new Error("Unknown managed job");
    if (action === "build") {
      const params = file ? JSON.parse(await fs.readFile(file, "utf8")) : {};
      const response = await request(
        `job/${name}/${Object.keys(params).length ? "buildWithParameters" : "build"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params),
        },
      );
      console.log(
        JSON.stringify({
          state: "queued",
          job: name,
          queue: response.headers.get("location"),
        }),
      );
    } else {
      console.log(
        await script(
          `def job=jenkins.model.Jenkins.get().getItem('${name}'); job.setDisabled(${action === "disable"}); job.save(); println('${action}: ${name}')`,
        ),
      );
    }
  } else if (action === "activate") {
    console.log(await script(activationScript()));
  } else if (action === "download-agent") {
    const bytes = new Uint8Array(
      await (await request("jnlpJars/agent.jar")).arrayBuffer(),
    );
    await fs.writeFile(join(tools, "agent.jar"), bytes, { mode: 0o600 });
    await fs.writeFile(
      join(tools, "agent.jar.sha256"),
      `${createHash("sha256").update(bytes).digest("hex")}  agent.jar\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        state: "downloaded",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
  } else if (action === "build-status") {
    if (!allowedJobs.has(name) || !/^[1-9]\d*$/.test(file ?? ""))
      throw new Error("Invalid job/build");
    console.log(
      JSON.stringify(
        await (
          await request(
            `job/${name}/${file}/api/json?tree=number,result,building,url,duration,description,artifacts[fileName,relativePath]`,
          )
        ).json(),
        null,
        2,
      ),
    );
  } else if (action === "pipeline-lint") {
    const text = await fs.readFile(name, "utf8");
    console.log(
      await (
        await request("pipeline-model-converter/validate", {
          method: "POST",
          body: new URLSearchParams({ jenkinsfile: text }),
        })
      ).text(),
    );
  } else
    throw new Error(
      "Use status|sync-pipelines|refresh|enable|disable|build|activate|download-agent|build-status|pipeline-lint",
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await runManagement();
