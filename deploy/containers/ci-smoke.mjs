import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { HostLayoutError, loadHostLayout } from "./host-layout.mjs";

// No host mounts, network, agent credential, repository or production access.
// Run this after image assembly; do not use a green build as browser evidence.
export function smokeProgram(architecture) {
  if (!["arm64", "x64"].includes(architecture))
    throw new Error("Use arm64 or x64");
  return `
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chromium } from '/opt/agent-platform/vercel/node_modules/playwright/index.mjs';
import { ciContext, ciChildEnvironment, browserVerificationScript } from '/opt/agent-platform/tools/ci-platform.mjs';
import { treeEvidence } from '/opt/agent-platform/tools/jenkins-web.mjs';
assert.equal(process.arch, ${JSON.stringify(architecture)});
assert.equal(process.versions.node, '22.23.3');
assert.equal(process.getuid(), 1000);
assert.equal(userInfo().username, 'jenkins');
const context=ciContext();
const env=ciChildEnvironment(process.execPath,context);
assert.equal(env.COREPACK_HOME,'/opt/agent-platform/corepack');
const root=await fs.mkdtemp('/tmp/ci-image-smoke-');
const results={arch:process.arch,node:process.versions.node,uid:process.getuid(),nodeChecks:0,browserRuns:[],native:null};
const maps=await fs.readFile('/proc/self/maps','utf8');
results.executionEngine=maps.includes('/mnt/lima-rosetta/rosetta')?'rosetta':maps.includes('qemu')?'qemu':'native';
function run(command,args,cwd=root) {
  const result=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,command+' failed: '+(result.signal??result.status)+' '+(result.stderr??'').slice(0,500));
  return (result.stdout??'').trim();
}
try {
  await fs.mkdir(context.temporary,{recursive:true});
  await fs.writeFile(root+'/package.json',JSON.stringify({packageManager:'pnpm@9.15.0'}));
  results.pnpm=run('/usr/local/bin/pnpm',['--version']);
  assert.equal(results.pnpm,'9.15.0');
  const api=root+'/api'; await fs.mkdir(api);
  await fs.writeFile(api+'/package.json',JSON.stringify({packageManager:'pnpm@9.12.0'}));
  results.pnpmVersions={web:results.pnpm,api:run('/usr/local/bin/pnpm',['--version'],api)};
  assert.equal(results.pnpmVersions.api,'9.12.0');
  results.browserVerification=JSON.parse(run(process.execPath,['--input-type=module','-e',browserVerificationScript()],'/opt/agent-platform/vercel'));
  const cli=spawnSync(process.execPath,[context.cli,'--version'],{cwd:root,env,encoding:'utf8',timeout:20000});
  assert.equal(cli.status,0);
  assert.match(cli.stdout+cli.stderr,/62\\.2\\.0/);
  results.vercel='62.2.0';
  const java=spawnSync('/opt/java/openjdk/bin/java',['-version'],{cwd:root,env,encoding:'utf8',timeout:20000});
  assert.equal(java.status,0);
  assert.match(java.stdout+java.stderr,/version "21\\./);
  assert.ok((await fs.stat('/usr/share/jenkins/agent.jar')).size>1000000);
  results.javaMajor=21;
  for(let index=0;index<30;index++) {
    run(process.execPath,['--check','/opt/agent-platform/tools/ci-agent-entrypoint.mjs']);
    results.nodeChecks++;
  }
  await import('/opt/agent-platform/tools/project-ci.mjs');
  const func=root+'/smoke.func'; await fs.mkdir(func);
  const target=process.arch==='x64'?'x86_64':'arm64';
  await fs.writeFile(func+'/.vc-config.json',JSON.stringify({runtime:'nodejs22.x',handler:'index.js',architecture:target}));
  const source='#include <node_api.h>\\nnapi_value Answer(napi_env e,napi_callback_info i){napi_value v;napi_create_int32(e,42,&v);return v;}\\nnapi_value Init(napi_env e,napi_value x){napi_value f;napi_create_function(e,"answer",6,Answer,nullptr,&f);napi_set_named_property(e,x,"answer",f);return x;}\\nNAPI_MODULE(NODE_GYP_MODULE_NAME,Init)\\n';
  await fs.writeFile(func+'/addon.cc',source);
  run('/usr/bin/g++',['-shared','-fPIC','-I/usr/local/include/node',func+'/addon.cc','-o',func+'/addon.node']);
  const header=await fs.readFile(func+'/addon.node');
  assert.equal(header.subarray(0,4).toString('hex'),'7f454c46');
  assert.equal(header.readUInt16LE(18),process.arch==='x64'?62:183);
  assert.equal(createRequire(import.meta.url)(func+'/addon.node').answer(),42);
  const evidence=await treeEvidence(func,{linux:true});
  assert.deepEqual(evidence.nativeArchitectures,[target]);
  await fs.writeFile(func+'/.vc-config.json',JSON.stringify({architecture:target==='arm64'?'x86_64':'arm64'}));
  await assert.rejects(treeEvidence(func,{linux:true}),/does not match/);
  results.native={elfMachine:header.readUInt16LE(18),loadedAnswer:42,architecture:target,mismatchRejected:true};
  for(let index=0;index<3;index++) {
    const browser=await chromium.launch({headless:true,timeout:20000});
    try {
      const page=await browser.newPage({viewport:{width:960,height:540}});
      await page.setContent('<title>CI browser '+index+'</title><button>Run</button><output>idle</output>');
      await page.getByRole('button',{name:'Run'}).click();
      const answer=await page.evaluate(()=>{let value=0;for(let i=0;i<1000000;i++)value=(value+i)%1000003;document.querySelector('output').textContent='done';return value;});
      assert.equal(await page.locator('output').textContent(),'done');
      assert.equal(answer,6);
      const png=await page.screenshot();
      assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      results.browserRuns.push({version:browser.version(),title:await page.title(),jitAnswer:answer,screenshotSha256:createHash('sha256').update(png).digest('hex')});
    } finally { await browser.close(); assert.equal(browser.isConnected(),false); }
  }
  console.log(JSON.stringify(results));
} finally { await fs.rm(root,{recursive:true,force:true}); }
`;
}

// Docker commands against the dedicated build profile of the host layout only.
async function docker(layout, args, input = undefined, timeout = 180000) {
  return new Promise((accept, reject) => {
    const child = spawn(
      layout.dockerCli,
      [
        "--config",
        layout.dockerConfig,
        "--host",
        layout.profiles.build.socket,
        ...args,
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      accept({ code, signal, stdout, stderr: stderr.slice(0, 4000) });
    });
    child.stdin.end(input);
  });
}

export async function smokeImage(architecture, reportPath) {
  const program = smokeProgram(architecture);
  const layout = await loadHostLayout({ requires: "ci-smoke" });
  const { daemonName } = layout.profiles.build;
  const image =
    "agent-platform-ci:node22-" + (architecture === "x64" ? "amd64" : "arm64");
  const daemon = await docker(layout, ["info", "--format", "{{.Name}}"]);
  if (daemon.code !== 0 || daemon.stdout.trim() !== daemonName)
    throw new Error("Smoke requires the dedicated build daemon");
  const metadata = await docker(layout, [
    "image",
    "inspect",
    image,
    "--format",
    "{{json .Id}} {{json .Os}} {{json .Architecture}}",
  ]);
  if (metadata.code !== 0) throw new Error("Built CI image is unavailable");
  const name = "agent-platform-ci-smoke-" + randomUUID();
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    daemon: daemonName,
    image,
    imageMetadata: metadata.stdout.trim(),
    network: "none",
    hostMounts: [],
    credentials: false,
  };
  try {
    const result = await docker(
      layout,
      [
        "run",
        "--rm",
        "--name",
        name,
        "--platform",
        architecture === "x64" ? "linux/amd64" : "linux/arm64",
        "--network",
        "none",
        "--entrypoint",
        "/usr/local/bin/node",
        "-i",
        image,
        "--input-type=module",
      ],
      program,
    );
    report.exitCode = result.code;
    report.signal = result.signal;
    report.status = result.code === 0 ? "passed" : "failed";
    if (result.code === 0) report.evidence = JSON.parse(result.stdout.trim());
    else report.failure = result.stderr;
  } finally {
    // Only the unique container created above can be removed by this harness.
    await docker(layout, ["rm", "--force", name], undefined, 10000);
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  smokeImage(process.argv[2], process.argv[3]).then(
    (report) => {
      console.log(
        JSON.stringify({ image: report.image, status: report.status }),
      );
      if (report.status !== "passed") process.exitCode = 1;
    },
    (error) => {
      // A host layout refusal names only a reason code and a path.
      console.error(
        error instanceof HostLayoutError
          ? error.message
          : "CI image smoke refused or failed; inspect its local report",
      );
      process.exitCode = 1;
    },
  );
