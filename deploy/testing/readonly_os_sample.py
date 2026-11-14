"""One bounded, passive Linux resource sample; never an event-loop measurement.

CLI: --collect-readonly, with a frozen schemaVersion/bootId/processes binding on
stdin. Production roots are fixed. The root arguments exist for filesystem
fixtures only. No timer, Docker API, signal, retry, SDK or database is used.

The caller must obtain and freeze the tuple from trusted fresh container
metadata. This checks that tuple against the kernel, not Docker provenance.
The monotonic budget is checked around synchronous bounded reads; it cannot
interrupt a blocked kernel syscall. The caller retains its existing outer
timeout. Missing metrics remain unknown. No sample proves a JS phase or SLO.
"""

import contextlib
import json
import os
import re
import stat
import sys
import time
import uuid

INPUT_LIMIT = 32768
OUTPUT_LIMIT = 131072
MAX_PROCESSES = 16
DEFAULT_BUDGET_MS = 500
UINT_MAX = 2**64 - 1
IO_KEYS = ("rchar", "wchar", "syscr", "syscw", "read_bytes", "write_bytes", "cancelled_write_bytes")
CPU_KEYS = ("usage_usec", "user_usec", "system_usec", "nr_periods", "nr_throttled", "throttled_usec", "nr_bursts", "burst_usec")
MEMORY_KEYS = ("anon", "file", "shmem", "file_dirty", "file_writeback", "pgfault", "pgmajfault")
EVENT_KEYS = ("low", "high", "max", "oom", "oom_kill", "oom_group_kill")
VM_KEYS = ("nr_free_pages", "nr_dirty", "nr_writeback", "pgpgin", "pgpgout", "pswpin", "pswpout", "pgfault", "pgmajfault", "pgscan_kswapd", "pgscan_direct", "pgsteal_kswapd", "pgsteal_direct", "oom_kill", "compact_stall")
STATUS_BYTES = ("VmSize", "VmRSS", "VmSwap", "RssAnon", "RssFile", "RssShmem")
STATUS_COUNTS = ("Threads", "voluntary_ctxt_switches", "nonvoluntary_ctxt_switches")
VM_BYTES = ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree", "Dirty", "Writeback")


class Refused(Exception):
    """A fixed code only; never carries input, path, file contents or OS error."""


class InvalidMetric(Exception):
    pass


class Deadline:
    def __init__(self, clock, budget_ms):
        self.clock = clock
        self.started = clock()
        self.end = self.started + budget_ms / 1000

    def check(self):
        if self.clock() >= self.end:
            raise Refused("SAMPLE_DEADLINE_EXCEEDED")

    def elapsed_ms(self):
        return max(0, (self.clock() - self.started) * 1000)


class Reader:
    def __init__(self, root, deadline):
        self.deadline = deadline
        self.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def close(self):
        os.close(self.fd)

    @contextlib.contextmanager
    def directory(self, parts):
        fd = os.dup(self.fd)
        try:
            for part in parts:
                self.deadline.check()
                if not part or part in (".", "..") or "/" in part:
                    raise Refused("DIRECTORY_COMPONENT_INVALID")
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = nxt
            yield fd
        finally:
            os.close(fd)

    def read(self, parts, name, limit=32768):
        self.deadline.check()
        with self.directory(parts) as directory:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise InvalidMetric()
                chunks, size = [], 0
                while True:
                    self.deadline.check()
                    block = os.read(fd, min(4096, limit + 1 - size))
                    if not block:
                        break
                    chunks.append(block)
                    size += len(block)
                    if size > limit:
                        raise InvalidMetric()
                self.deadline.check()
                return b"".join(chunks).decode("utf-8")
            finally:
                os.close(fd)

    def directory_identity(self, parts):
        with self.directory(parts) as fd:
            s = os.fstat(fd)
            return s.st_dev, s.st_ino


def uint(value):
    if not re.fullmatch(r"[0-9]{1,20}", value):
        raise InvalidMetric()
    number = int(value)
    if number > UINT_MAX:
        raise InvalidMetric()
    return number


def stat_record(text, pid):
    # comm can contain spaces and ')'; neither comm nor any other text is emitted.
    right = text.rfind(")")
    if right < 0 or text.partition(" (")[0] != str(pid):
        raise InvalidMetric()
    tail = text[right + 1 :].split()
    if len(tail) < 40 or tail[0] not in "RSDZTtXxKWPI" or len(tail[0]) != 1:
        raise InvalidMetric()
    return {"taskState": tail[0], "userTicks": uint(tail[11]), "systemTicks": uint(tail[12]),
            "threads": uint(tail[17]), "startTicks": str(uint(tail[19])),
            "virtualBytes": uint(tail[20]), "residentPages": uint(tail[21]),
            "blockIODelayTicks": uint(tail[39])}


def key_values(text, keys, colon=False):
    values = {}
    for line in text.splitlines():
        fields = line.replace(":", " ", 1).split() if colon else line.split()
        if fields and fields[0] in keys:
            if len(fields) != 2 or fields[0] in values:
                raise InvalidMetric()
            values[fields[0]] = uint(fields[1])
    if not values:
        raise InvalidMetric()
    return {"values": values, "missingFields": [k for k in keys if k not in values]}


def byte_and_count_values(text, byte_keys, count_keys):
    values = {}
    for line in text.splitlines():
        fields = line.replace(":", " ", 1).split()
        if not fields or fields[0] not in byte_keys + count_keys:
            continue
        key = fields[0]
        if key in values:
            raise InvalidMetric()
        if key in byte_keys:
            if len(fields) != 3 or fields[2] != "kB":
                raise InvalidMetric()
            values[key] = uint(fields[1]) * 1024
        else:
            if len(fields) != 2:
                raise InvalidMetric()
            values[key] = uint(fields[1])
    if not values:
        raise InvalidMetric()
    return {"values": values, "missingFields": [k for k in byte_keys + count_keys if k not in values]}


def pressure(text):
    values = {}
    for line in text.splitlines():
        fields = line.split()
        if not fields or fields[0] not in ("some", "full"):
            continue
        if fields[0] in values or len(fields) != 5:
            raise InvalidMetric()
        row = {}
        for item in fields[1:]:
            pair = item.split("=")
            if len(pair) != 2 or pair[0] in row:
                raise InvalidMetric()
            key, value = pair
            if key == "total":
                row[key] = uint(value)
            elif key in ("avg10", "avg60", "avg300") and re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]{1,6})?", value) and float(value) <= 100:
                row[key] = float(value)
            else:
                raise InvalidMetric()
        if set(row) != {"avg10", "avg60", "avg300", "total"}:
            raise InvalidMetric()
        values[fields[0]] = row
    if not values:
        raise InvalidMetric()
    return {"values": values, "missingFields": [k for k in ("some", "full") if k not in values]}


def io_stat(text):
    rows = []
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        if len(rows) >= 32 or not re.fullmatch(r"[0-9]{1,10}:[0-9]{1,10}", fields[0]):
            raise InvalidMetric()
        values = {}
        for item in fields[1:]:
            pair = item.split("=")
            if len(pair) != 2:
                raise InvalidMetric()
            key, value = pair
            if key in ("rbytes", "wbytes", "rios", "wios", "dbytes", "dios"):
                if key in values:
                    raise InvalidMetric()
                values[key] = uint(value)
        rows.append({"device": fields[0], "values": values})
    # An actually empty io.stat is a known empty device list, not invented zeros.
    if len({r["device"] for r in rows}) != len(rows):
        raise InvalidMetric()
    return {"devices": sorted(rows, key=lambda r: r["device"])}


def schedstat(text):
    fields = text.split()
    if len(fields) != 3:
        raise InvalidMetric()
    return dict(zip(("leaderRuntimeNs", "leaderRunqueueWaitNs", "leaderTimeslices"), map(uint, fields)))


def vm_cpu(text):
    result = {}
    for line in text.splitlines():
        parts = line.split()
        if parts and parts[0] == "cpu":
            if "ticks" in result or not 8 <= len(parts) - 1 <= 10:
                raise InvalidMetric()
            result["ticks"] = dict(zip(("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal", "guest", "guestNice"), map(uint, parts[1:])))
        elif parts and parts[0] in ("procs_running", "procs_blocked"):
            if len(parts) != 2 or parts[0] in result:
                raise InvalidMetric()
            result[parts[0]] = uint(parts[1])
    if "ticks" not in result:
        raise InvalidMetric()
    return result


def binding_checked(binding):
    if not isinstance(binding, dict) or set(binding) != {"schemaVersion", "bootId", "processes"} or type(binding["schemaVersion"]) is not int or binding["schemaVersion"] != 1:
        raise Refused("FROZEN_BINDING_INVALID")
    try:
        if str(uuid.UUID(binding["bootId"])) != binding["bootId"]:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise Refused("FROZEN_BINDING_INVALID") from None
    rows = binding["processes"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_PROCESSES:
        raise Refused("FROZEN_BINDING_INVALID")
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"name", "containerId", "hostPid", "startTicks", "cgroupPath"}:
            raise Refused("FROZEN_BINDING_INVALID")
        if not isinstance(row["name"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", row["name"]) or not isinstance(row["containerId"], str) or not re.fullmatch(r"[a-f0-9]{64}", row["containerId"]):
            raise Refused("FROZEN_BINDING_INVALID")
        if type(row["hostPid"]) is not int or not 0 < row["hostPid"] <= 2**31 - 1 or not isinstance(row["startTicks"], str) or not re.fullmatch(r"[1-9][0-9]{0,19}", row["startTicks"]) or int(row["startTicks"]) > UINT_MAX:
            raise Refused("FROZEN_BINDING_INVALID")
        cg = row["cgroupPath"]
        if not isinstance(cg, str) or not 1 < len(cg) <= 1024 or not cg.startswith("/") or not re.fullmatch(r"/[A-Za-z0-9_.:@/+\-]+", cg):
            raise Refused("FROZEN_BINDING_INVALID")
        parts = cg[1:].split("/")
        if any(p in ("", ".", "..") for p in parts) or not any(p in (row["containerId"], "docker-" + row["containerId"] + ".scope") for p in parts):
            raise Refused("FROZEN_BINDING_INVALID")
    for key in ("name", "containerId", "hostPid"):
        if len({r[key] for r in rows}) != len(rows):
            raise Refused("FROZEN_BINDING_INVALID")
    return [dict(row) for row in rows]


def identity(proc, cgroup, row):
    pid = row["hostPid"]
    parts = [str(pid)]
    try:
        directory = proc.directory_identity(parts)
        observed = stat_record(proc.read(parts, "stat", 8192), pid)
        lines = proc.read(parts, "cgroup", 4096).splitlines()
        if len(lines) != 1 or not lines[0].startswith("0::"):
            raise Refused("UNIFIED_CGROUP_REQUIRED")
        if observed["startTicks"] != row["startTicks"]:
            raise Refused("PROCESS_BIRTH_CHANGED")
        if lines[0][3:] != row["cgroupPath"]:
            raise Refused("PROCESS_CGROUP_CHANGED")
        cg_directory = cgroup.directory_identity(row["cgroupPath"][1:].split("/"))
        return directory, cg_directory, observed
    except (OSError, InvalidMetric, UnicodeError):
        raise Refused("PROCESS_IDENTITY_UNAVAILABLE") from None


def metric(reader, parts, filename, parser, limit=32768):
    try:
        return {"state": "observed", **parser(reader.read(parts, filename, limit))}
    except FileNotFoundError:
        return {"state": "unknown", "reason": "missing"}
    except (OSError, InvalidMetric, UnicodeError):
        return {"state": "unknown", "reason": "unreadable-or-invalid"}


def collect(binding, *, proc_root="/proc", cgroup_root="/sys/fs/cgroup", clock=time.monotonic, epoch=time.time, budget_ms=DEFAULT_BUDGET_MS):
    """Returns a passive non-atomic sample or an explicit unknown; never signals."""
    if type(budget_ms) is not int or not 1 <= budget_ms <= DEFAULT_BUDGET_MS:
        return {"state": "unknown", "reason": "SAMPLE_BUDGET_INVALID"}
    deadline = Deadline(clock, budget_ms)
    result = {"schemaVersion": 1, "kind": "readonly-frozen-container-os-sample", "observedAtEpoch": epoch(), "snapshotIsAtomic": False, "eventLoopDelayMeasured": False}
    readers = []
    try:
        rows = binding_checked(binding)
        expected_boot = binding["bootId"]
        for root in (proc_root, cgroup_root):
            readers.append(Reader(root, deadline))
        proc, cgroup = readers
        boot = lambda: proc.read(["sys", "kernel", "random"], "boot_id", 128).strip()
        if boot() != expected_boot:
            raise Refused("BOOT_CHANGED")
        before = [identity(proc, cgroup, r) for r in rows]
        sampled = []
        for row, original in zip(rows, before):
            pid_parts, cg_parts = [str(row["hostPid"])], row["cgroupPath"][1:].split("/")
            metrics = {
                "stat": {"state": "observed", **original[2]},
                "status": metric(proc, pid_parts, "status", lambda s: byte_and_count_values(s, STATUS_BYTES, STATUS_COUNTS)),
                "io": metric(proc, pid_parts, "io", lambda s: key_values(s, IO_KEYS, True)),
                "schedstat": metric(proc, pid_parts, "schedstat", schedstat, 4096),
                "cpu": metric(cgroup, cg_parts, "cpu.stat", lambda s: key_values(s, CPU_KEYS)),
                "cgroupIO": metric(cgroup, cg_parts, "io.stat", io_stat),
                "memoryStat": metric(cgroup, cg_parts, "memory.stat", lambda s: key_values(s, MEMORY_KEYS)),
                "memoryEvents": metric(cgroup, cg_parts, "memory.events", lambda s: key_values(s, EVENT_KEYS)),
            }
            for filename in ("memory.current", "memory.peak", "memory.swap.current"):
                metrics[filename] = metric(cgroup, cg_parts, filename, lambda s: {"bytes": uint(s.strip())}, 128)
            for kind in ("cpu", "io", "memory"):
                metrics[kind + "Pressure"] = metric(cgroup, cg_parts, kind + ".pressure", pressure, 4096)
            sampled.append({**row, "sampledAtMonotonic": clock(), "metrics": metrics})
        vm = {"cpu": metric(proc, [], "stat", vm_cpu), "vmstat": metric(proc, [], "vmstat", lambda s: key_values(s, VM_KEYS)), "memory": metric(proc, [], "meminfo", lambda s: byte_and_count_values(s, VM_BYTES, ()))}
        for kind in ("cpu", "io", "memory"):
            vm[kind + "Pressure"] = metric(proc, ["pressure"], kind, pressure, 4096)
        for row, original in zip(rows, before):
            current = identity(proc, cgroup, row)
            if current[:2] != original[:2]:
                raise Refused("PROCESS_OR_CGROUP_DIRECTORY_CHANGED")
        if boot() != expected_boot:
            raise Refused("BOOT_CHANGED")
        deadline.check()
        all_metrics = list(vm.values()) + [m for p in sampled for m in p["metrics"].values()]
        complete = all(m["state"] == "observed" and not m.get("missingFields") for m in all_metrics)
        result.update({"state": "observed" if complete else "observed-with-unknown-metrics", "identityStableAcrossSampling": True, "bootId": expected_boot, "clockTicksPerSecond": os.sysconf("SC_CLK_TCK"), "pageSizeBytes": os.sysconf("SC_PAGE_SIZE"), "metricsComplete": complete, "processes": sampled, "vm": vm})
    except Refused as error:
        result.update({"state": "unknown", "reason": str(error), "identityStableAcrossSampling": False})
    except (OSError, InvalidMetric, UnicodeError):
        result.update({"state": "unknown", "reason": "REQUIRED_OS_METADATA_UNAVAILABLE", "identityStableAcrossSampling": False})
    finally:
        for reader in readers:
            reader.close()
    result["sampleDurationMs"] = deadline.elapsed_ms()
    encoded_size = len(json.dumps(result, allow_nan=False).encode())
    result["sampleDurationMs"] = deadline.elapsed_ms()
    if result["state"] != "unknown" and result["sampleDurationMs"] >= budget_ms:
        return {"schemaVersion": 1, "kind": result["kind"], "state": "unknown", "reason": "SAMPLE_DEADLINE_EXCEEDED", "identityStableAcrossSampling": False, "sampleDurationMs": result["sampleDurationMs"]}
    # Reserve space for the final duration update rather than exceeding the cap
    # because the float representation gained a few digits after serialization.
    if encoded_size + 64 > OUTPUT_LIMIT:
        return {"schemaVersion": 1, "kind": result["kind"], "state": "unknown", "reason": "OUTPUT_BOUND_EXCEEDED", "sampleDurationMs": result["sampleDurationMs"]}
    return result


def main(argv=None):
    if (sys.argv[1:] if argv is None else argv) != ["--collect-readonly"]:
        print(json.dumps({"state": "HELD", "oneShot": True, "remoteCalls": 0, "SDKCalls": 0}))
        return 0
    try:
        raw = sys.stdin.buffer.read(INPUT_LIMIT + 1)
        if len(raw) > INPUT_LIMIT:
            raise ValueError()
        binding = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        result = collect(binding)
    except (ValueError, TypeError, UnicodeError):
        result = {"state": "unknown", "reason": "FROZEN_BINDING_JSON_INVALID"}
    print(json.dumps(result, separators=(",", ":"), allow_nan=False))
    return 2 if result["state"] == "unknown" else 0


if __name__ == "__main__":
    sys.exit(main())
