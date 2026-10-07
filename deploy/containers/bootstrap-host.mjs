// Three fixed host engine entries. Application, Tunnel and Jenkins live in Docker.
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HOME = "/Users/douglasdong";
export const REVIEW = HOME + "/.local/share/agent-platform-jenkins-tools/container-boot";
export const PROFILES = ["agent-platform-jenkins", "agent-platform-build", "agent-platform-runtime"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const escape = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));
function xml(v) {
  if(typeof v === "string")return `<string>${escape(v)}</string>`;
  if(typeof v === "boolean")return v?"<true/>":"<false/>";
  if(typeof v === "number")return `<integer>${v}</integer>`;
  if(Array.isArray(v))return `<array>${v.map(xml).join("")}</array>`;
  return `<dict>${Object.entries(v).map(([k,x])=>`<key>${escape(k)}</key>${xml(x)}`).join("")}</dict>`;
}
export function definitions(system = false) {
  return PROFILES.map(profile=>({
    Label:"com.douglasdong.agent-platform.container-engine."+profile,
    ...(system?{UserName:"douglasdong",GroupName:"staff"}:{}),
    ProgramArguments:["/opt/homebrew/bin/colima","--profile",profile,"start","--foreground","--activate=false","--save-config=false","--ssh-agent=false","--ssh-config=false"],
    WorkingDirectory:HOME,
    EnvironmentVariables:{HOME,PATH:"/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",LANG:"en_US.UTF-8",DOCKER_CONFIG:HOME+"/.local/share/agent-platform-jenkins-tools/container-docker-context"},
    RunAtLoad:true,StartInterval:60,KeepAlive:{SuccessfulExit:false},ThrottleInterval:30,ExitTimeOut:90,Umask:63,
    StandardOutPath:REVIEW+"/logs/"+profile+".log",StandardErrorPath:REVIEW+"/logs/"+profile+".log",
  }));
}
export function render(system = false) {
  return Object.fromEntries(definitions(system).map(s=>[s.Label,'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">'+xml(s)+"</plist>\n"]));
}
async function command(program,args) {
  return new Promise((accept,reject)=>{
    const p=spawn(program,args,{stdio:["ignore","pipe","pipe"]});let out="",err="";
    p.stdout.on("data",c=>out+=c);p.stderr.on("data",c=>err+=c);p.once("error",reject);
    p.once("exit",code=>code===0?accept(out):reject(Error(`${program} failed (${code}): ${err.slice(-1000)}`)));
  });
}
async function regular(path, uid) {
  const stat=await fs.lstat(path);
  if(!stat.isFile()||stat.uid!==uid||stat.mode&0o022||stat.size>2_000_000)throw Error("Boot review file identity changed");
  const bytes=await fs.readFile(path);return bytes;
}
async function prepare() {
  if(process.platform!=="darwin"||process.getuid()!==501||process.versions.node.split(".")[0]!=="22")throw Error("Mac owner Node22 required");
  await fs.mkdir(REVIEW,{recursive:true,mode:0o700});await fs.mkdir(join(REVIEW,"logs"),{recursive:true,mode:0o700});
  const manifest={schemaVersion:1,createdAt:new Date().toISOString(),profileConfigurations:{},files:{},applicationsInDocker:true,systemInstallationRequiresAdministrator:true};
  for(const profile of PROFILES)manifest.profileConfigurations[profile]=digest(await regular(join(HOME,".colima",profile,"colima.yaml"),501));
  for(const system of [false,true]) {
    const folder=join(REVIEW,system?"system":"user");await fs.mkdir(folder,{recursive:true,mode:0o700});
    for(const [label,bytes]of Object.entries(render(system))){const file=join(folder,label+".plist");await fs.writeFile(file,bytes,{mode:0o600});await command("/usr/bin/plutil",["-lint",file]);manifest.files[(system?"system":"user")+"/"+label+".plist"]=digest(bytes);}
  }
  const source=await fs.readFile(new URL(import.meta.url));await fs.writeFile(join(REVIEW,"bootstrap-host.mjs"),source,{mode:0o600});manifest.installerSha256=digest(source);
  await fs.writeFile(join(REVIEW,"review.json"),JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
  return {state:"prepared",review:REVIEW,installerSha256:manifest.installerSha256,profileCount:3,configurationUnchanged:true};
}
async function apply(system) {
  if(process.platform!=="darwin"||process.versions.node.split(".")[0]!=="22"||process.getuid()!==(system?0:501))throw Error(system?"Run reviewed installation with sudo":"Mac owner required");
  if(system && process.env.SUDO_USER!=="douglasdong")throw Error("Expected Mac owner administrator invocation");
  const manifest=JSON.parse(await regular(join(REVIEW,"review.json"),501));
  if(manifest.schemaVersion!==1||digest(await regular(join(REVIEW,"bootstrap-host.mjs"),501))!==manifest.installerSha256)throw Error("Reviewed installer changed");
  for(const profile of PROFILES)if(digest(await regular(join(HOME,".colima",profile,"colima.yaml"),501))!==manifest.profileConfigurations[profile])throw Error("Engine configuration changed; prepare again");
  const directory=system?"/Library/LaunchDaemons":join(HOME,"Library/LaunchAgents");
  if(!system)await fs.mkdir(directory,{recursive:true,mode:0o700});
  const target=await fs.lstat(directory);if(!target.isDirectory()||target.isSymbolicLink()||target.uid!==(system?0:501)||target.mode&0o022)throw Error("Unsafe launchd destination");
  for(const [label,expected]of Object.entries(render(system))) {
    const relative=(system?"system":"user")+"/"+label+".plist";
    const bytes=await regular(join(REVIEW,relative),501);
    if(digest(bytes)!==manifest.files[relative]||bytes.toString()!==expected)throw Error("Reviewed service definition changed");
    const file=join(directory,label+".plist");
    const prior=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(prior && (!prior.isFile()||prior.uid!==(system?0:501)))throw Error("Existing service definition has unexpected owner");
    if(prior && (await fs.readFile(file)).toString()!==expected)throw Error("Existing container engine service differs; review required");
    if(!prior){await fs.writeFile(file,bytes,{flag:"wx",mode:0o644});if(system)await fs.chown(file,0,0);}
    const domain=system?"system":"gui/501";
    if(system){await command("/bin/launchctl",["bootout","gui/501/"+label]).catch(()=>{});}
    await command("/bin/launchctl",["enable",domain+"/"+label]);
    const present=await command("/bin/launchctl",["print",domain+"/"+label]).then(()=>true,()=>false);
    if(!present)await command("/bin/launchctl",["bootstrap",domain,file]);
  }
  return {state:system?"system-engine-services-installed":"login-engine-services-installed",profileCount:3,domain:system?"system":"gui/501",applicationStartup:"Docker restart unless-stopped",productionApiOrTunnelStopped:false};
}
export async function main(action) {if(action==='prepare')return prepare();if(action==='apply-user')return apply(false);if(action==='apply-system')return apply(true);throw Error('Use prepare, apply-user or apply-system');}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv[2]).then(r=>console.log(JSON.stringify(r)),e=>{console.error(e.message);process.exitCode=1;});
