import * as fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// BoxLite 0.9.7 runs as root, enables "+cpu +memory +pids" on a new
// /sys/fs/cgroup/boxlite and puts every box in boxlite/<id>. Docker's private
// cgroup namespace delegates no controller below the container root and keeps
// PID 1 inside it, and a non-root cgroup that holds processes cannot enable
// domain controllers (EBUSY), so every box ran without its cgroup. Same remedy
// as moby hack/dind: move the root's processes into a leaf, then delegate the
// controllers BoxLite enables, before BoxLite creates boxlite/.
export const CGROUP_LEAF = "api";
export const DELEGATED_CONTROLLERS = Object.freeze(["cpu", "memory", "pids"]);
// Operator switch in runtime.env, which the entrypoint loads first. A restart
// applies it; reverting this input instead needs another deploy agent upgrade.
export const DELEGATION_SWITCH = "API_CGROUP_DELEGATION";

const words = (text) => text.split(/\s+/).filter(Boolean);

/** Never throws: the API starts either way and the caller logs the result. */
export async function delegateCgroupControllers({
  env = process.env,
  files = fs,
  root = "/sys/fs/cgroup",
  self = "/proc/self/cgroup",
  attempts = 50,
  pause = () => sleep(10),
} = {}) {
  if (env[DELEGATION_SWITCH] === "off")
    return { status: "skipped", reason: "disabled" };
  const path = (name) => root + "/" + name;
  let step = "controllers";
  try {
    let available;
    try {
      available = words(files.readFileSync(path("cgroup.controllers"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT")
        return { status: "skipped", reason: "no-cgroup-v2" };
      throw error;
    }
    step = "membership";
    // Only this container's own namespace root (or the leaf it already moved
    // to) may be reorganised. Under a host cgroup namespace the same paths are
    // the VM's real tree, and moving "our" processes would leave the container.
    const group = /^0::(\/\S*)$/m.exec(files.readFileSync(self, "utf8"))?.[1];
    if (group !== "/" && group !== "/" + CGROUP_LEAF)
      return {
        status: "skipped",
        reason: "foreign-cgroup",
        cgroup: group ?? "none",
      };
    // "0::/" is also the real root, which has no cgroup.type and may hold
    // processes: there the move would sweep up every host process.
    try {
      files.readFileSync(path("cgroup.type"), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT")
        return { status: "skipped", reason: "real-root" };
      throw error;
    }
    step = "subtree";
    const enabled = words(
      files.readFileSync(path("cgroup.subtree_control"), "utf8"),
    );
    if (DELEGATED_CONTROLLERS.every((name) => enabled.includes(name)))
      return { status: "already" };
    if (!DELEGATED_CONTROLLERS.every((name) => available.includes(name)))
      return {
        status: "skipped",
        reason: "controllers-unavailable",
        available,
      };
    step = "leaf";
    files.mkdirSync(path(CGROUP_LEAF), { recursive: true });
    for (let attempt = 1; ; attempt++) {
      step = "move";
      for (const pid of words(files.readFileSync(path("cgroup.procs"), "utf8")))
        try {
          files.writeFileSync(path(CGROUP_LEAF + "/cgroup.procs"), pid);
        } catch (error) {
          // Listed, then exited before the move: moby ignores the same race.
          if (error?.code !== "ESRCH") throw error;
        }
      step = "enable";
      try {
        files.writeFileSync(
          path("cgroup.subtree_control"),
          DELEGATED_CONTROLLERS.map((name) => "+" + name).join(" "),
        );
        return {
          status: "enabled",
          leaf: "/" + CGROUP_LEAF,
          attempts: attempt,
        };
      } catch (error) {
        // docker exec and the HEALTHCHECK can join the root between the move
        // and this write. Move them too, but only a bounded number of times.
        if (error?.code !== "EBUSY" || attempt >= attempts) throw error;
      }
      await pause();
    }
  } catch (error) {
    return {
      status: "failed",
      reason: typeof error?.code === "string" ? error.code : "unexpected",
      step,
    };
  }
}

export function delegationLine(result) {
  return [
    "cgroup-delegation",
    ...Object.entries(result).map(
      ([key, value]) =>
        key + "=" + (Array.isArray(value) ? value.join(",") || "none" : value),
    ),
  ].join(" ");
}

/** One line: delegated on stdout; skipped or failed on stderr (fail-open). */
export function reportCgroupDelegation(result, log = console) {
  const line = delegationLine(result);
  if (result.status === "enabled" || result.status === "already") log.log(line);
  else log.error(line);
  return result;
}
