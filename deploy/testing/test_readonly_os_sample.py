"""Real filesystem fixtures for the passive one-shot sampler; no live /proc."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

MODULE = Path(__file__).with_name("readonly_os_sample.py")
SPEC = importlib.util.spec_from_file_location("readonly_os_sample", MODULE)
sample = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sample)
BOOT = "8caa2619-d4c9-4aa4-a715-aea73fc3f9b5"
OTHER_BOOT = "0b86de4d-73e5-4f38-a9a6-a2e8a6b67e4a"
CID = "a" * 64
PID = 4321
CG = "/system.slice/docker-" + CID + ".scope"
PSI = "some avg10=0.15 avg60=1.25 avg300=2.50 total=123456\nfull avg10=0.00 avg60=0.00 avg300=0.25 total=123\n"


def proc_stat(pid=PID, birth=123456, comm="node (pool) worker)"):
    fields = ["0"] * 50
    fields[0] = "S"
    for index, value in {11: "123", 12: "45", 17: "7", 19: str(birth), 20: "104857600", 21: "8192", 39: "3"}.items():
        fields[index] = value
    return str(pid) + " (" + comm + ") " + " ".join(fields) + "\n"


class Fixture:
    def __init__(self, root):
        self.root = Path(root)
        self.proc = self.root / "proc"
        self.cgroup = self.root / "cgroup"
        self.put(self.proc / "sys/kernel/random/boot_id", BOOT + "\n")
        self.put(self.proc / "stat", "cpu 10 0 20 300 4 5 6 7 0 0\ncpu0 1 2 3 4 5 6 7 8\nprocs_running 2\nprocs_blocked 1\n")
        self.put(self.proc / "vmstat", "".join(k + " 12\n" for k in sample.VM_KEYS) + "UNLISTED_PRIVATE 991\n")
        self.put(self.proc / "meminfo", "".join(k + ": 4000 kB\n" for k in sample.VM_BYTES))
        for kind in ("cpu", "io", "memory"):
            self.put(self.proc / "pressure" / kind, PSI)
        self.add_process()

    @staticmethod
    def put(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def add_process(self, pid=PID, cid=CID, name="source-coordinator"):
        cg = "/system.slice/docker-" + cid + ".scope"
        p = self.proc / str(pid)
        self.put(p / "stat", proc_stat(pid))
        self.put(p / "cgroup", "0::" + cg + "\n")
        self.put(p / "status", "Name:\tDO-NOT-EMIT-THIS-NAME\nUid:\t1000 1000 1000 1000\n" + "".join(k + ": 24 kB\n" for k in sample.STATUS_BYTES) + "".join(k + ": 7\n" for k in sample.STATUS_COUNTS))
        self.put(p / "io", "".join(k + ": 81\n" for k in sample.IO_KEYS) + "UNLISTED_PRIVATE: 123\n")
        self.put(p / "schedstat", "50000000 6000000 75\n")
        # These files deliberately exist, but the sampler must never open them.
        for forbidden in ("environ", "cmdline"):
            self.put(p / forbidden, "NEVER-READ-PRIVATE-PAYLOAD")
        c = self.cgroup / cg[1:]
        self.put(c / "cpu.stat", "".join(k + " 25\n" for k in sample.CPU_KEYS))
        self.put(c / "io.stat", "8:16 rbytes=500 wbytes=600 rios=7 wios=8 dbytes=9 dios=10\n")
        self.put(c / "memory.stat", "".join(k + " 42\n" for k in sample.MEMORY_KEYS))
        self.put(c / "memory.events", "".join(k + " 0\n" for k in sample.EVENT_KEYS))
        for filename in ("memory.current", "memory.peak", "memory.swap.current"):
            self.put(c / filename, "0\n" if filename == "memory.swap.current" else "1048576\n")
        for kind in ("cpu", "io", "memory"):
            self.put(c / (kind + ".pressure"), PSI)
        return {"name": name, "containerId": cid, "hostPid": pid, "startTicks": "123456", "cgroupPath": cg}

    def binding(self):
        return {"schemaVersion": 1, "bootId": BOOT, "processes": [{"name": "source-coordinator", "containerId": CID, "hostPid": PID, "startTicks": "123456", "cgroupPath": CG}]}


class ReadonlyOSSampleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.f = Fixture(self.temp.name)

    def collect(self, binding=None, **kwargs):
        return sample.collect(binding or self.f.binding(), proc_root=self.f.proc, cgroup_root=self.f.cgroup, **kwargs)

    def mutated_during_read(self, filename, mutate, **kwargs):
        original = sample.Reader.read
        happened = False

        def read(reader, parts, name, limit=32768):
            nonlocal happened
            value = original(reader, parts, name, limit)
            if name == filename and not happened:
                happened = True
                mutate()
            return value

        with patch.object(sample.Reader, "read", read):
            result = self.collect(**kwargs)
        self.assertTrue(happened)
        return result

    def assert_refused(self, result, reason):
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["reason"], reason)
        self.assertFalse(result.get("identityStableAcrossSampling", False))
        self.assertNotIn("processes", result)
        self.assertNotIn("vm", result)

    def test_real_files_numeric_whitelist_and_identity_rechecked(self):
        opened = []
        original = sample.Reader.read

        def read(reader, parts, name, limit=32768):
            opened.append((tuple(parts), name))
            return original(reader, parts, name, limit)

        with patch.object(sample.Reader, "read", read):
            result = self.collect()
        self.assertEqual(result["state"], "observed")
        self.assertTrue(result["metricsComplete"])
        self.assertTrue(result["identityStableAcrossSampling"])
        self.assertFalse(result["snapshotIsAtomic"])
        self.assertFalse(result["eventLoopDelayMeasured"])
        self.assertGreaterEqual(result["sampleDurationMs"], 0)
        metrics = result["processes"][0]["metrics"]
        self.assertEqual(metrics["stat"]["userTicks"], 123)
        self.assertEqual(metrics["stat"]["state"], "observed")
        self.assertEqual(metrics["stat"]["taskState"], "S")
        self.assertEqual(metrics["stat"]["startTicks"], "123456")
        self.assertEqual(metrics["status"]["values"]["VmRSS"], 24 * 1024)
        self.assertEqual(metrics["schedstat"]["leaderRunqueueWaitNs"], 6000000)
        self.assertEqual(metrics["cgroupIO"]["devices"][0]["values"]["wbytes"], 600)
        self.assertEqual(metrics["memory.swap.current"], {"state": "observed", "bytes": 0})
        serialized = json.dumps(result)
        for forbidden in ("DO-NOT-EMIT", "UNLISTED_PRIVATE", "NEVER-READ", "Uid", "node (pool)"):
            self.assertNotIn(forbidden, serialized)
        names = [name for _, name in opened]
        for forbidden in ("environ", "cmdline", "fd", "socket", "platform.sqlite"):
            self.assertNotIn(forbidden, names)
        self.assertEqual(opened.count(((str(PID),), "cgroup")), 2)
        self.assertEqual(names.count("boot_id"), 2)

    def test_missing_metric_is_unknown_not_zero(self):
        (self.f.proc / str(PID) / "io").unlink()
        result = self.collect()
        self.assertEqual(result["state"], "observed-with-unknown-metrics")
        self.assertEqual(result["processes"][0]["metrics"]["io"], {"state": "unknown", "reason": "missing"})
        self.assertFalse(result["metricsComplete"])

    def test_missing_numeric_key_is_explicit_not_invented(self):
        self.f.put(self.f.cgroup / CG[1:] / "cpu.stat", "usage_usec 0\n")
        cpu = self.collect()["processes"][0]["metrics"]["cpu"]
        self.assertEqual(cpu["values"], {"usage_usec": 0})
        self.assertIn("throttled_usec", cpu["missingFields"])
        self.assertNotIn("throttled_usec", cpu["values"])

    def test_invalid_negative_and_oversized_metrics_are_bounded_unknown(self):
        cg = self.f.cgroup / CG[1:]
        self.f.put(self.f.proc / str(PID) / "io", "read_bytes: -1\n")
        self.f.put(cg / "memory.stat", "anon 1\n" + "x" * 32768)
        result = self.collect()
        self.assertEqual(result["state"], "observed-with-unknown-metrics")
        for name in ("io", "memoryStat"):
            self.assertEqual(result["processes"][0]["metrics"][name]["state"], "unknown")
        self.assertLess(len(json.dumps(result)), 20000)

    def test_nonfinite_pressure_and_duplicate_devices_are_unknown(self):
        cg = self.f.cgroup / CG[1:]
        self.f.put(cg / "cpu.pressure", "some avg10=NaN avg60=0 avg300=0 total=1\n")
        self.f.put(cg / "io.stat", "8:16 rbytes=1\n8:16 rbytes=2\n")
        result = self.collect()["processes"][0]["metrics"]
        self.assertEqual(result["cpuPressure"]["state"], "unknown")
        self.assertEqual(result["cgroupIO"]["state"], "unknown")

    def test_empty_io_stat_is_a_known_empty_list(self):
        self.f.put(self.f.cgroup / CG[1:] / "io.stat", "")
        result = self.collect()["processes"][0]["metrics"]["cgroupIO"]
        self.assertEqual(result, {"state": "observed", "devices": []})

    def test_wrong_boot_before_or_during_sample_is_rejected(self):
        binding = self.f.binding()
        binding["bootId"] = OTHER_BOOT
        self.assert_refused(self.collect(binding), "BOOT_CHANGED")
        result = self.mutated_during_read("vmstat", lambda: self.f.put(self.f.proc / "sys/kernel/random/boot_id", OTHER_BOOT))
        self.assert_refused(result, "BOOT_CHANGED")

    def test_pid_reuse_before_or_during_sample_is_rejected(self):
        p = self.f.proc / str(PID) / "stat"
        self.f.put(p, proc_stat(birth=987654))
        self.assert_refused(self.collect(), "PROCESS_BIRTH_CHANGED")
        self.f.put(p, proc_stat())
        result = self.mutated_during_read("io", lambda: self.f.put(p, proc_stat(birth=987654)))
        self.assert_refused(result, "PROCESS_BIRTH_CHANGED")

    def test_cgroup_migration_before_or_during_sample_is_rejected(self):
        p = self.f.proc / str(PID) / "cgroup"
        self.f.put(p, "0::/different/docker-" + CID + ".scope\n")
        self.assert_refused(self.collect(), "PROCESS_CGROUP_CHANGED")
        self.f.put(p, "0::" + CG + "\n")
        result = self.mutated_during_read("memory.current", lambda: self.f.put(p, "0::/different/docker-" + CID + ".scope\n"))
        self.assert_refused(result, "PROCESS_CGROUP_CHANGED")

    def test_cgroup_directory_replacement_discards_partial_sample(self):
        p = self.f.cgroup / CG[1:]

        def replace():
            p.rename(p.with_name(p.name + "-closed"))
            p.mkdir()

        self.assert_refused(self.mutated_during_read("memory.current", replace), "PROCESS_OR_CGROUP_DIRECTORY_CHANGED")

    def test_proc_directory_replacement_even_same_frozen_birth_is_rejected(self):
        p = self.f.proc / str(PID)

        def replace():
            p.rename(p.with_name(p.name + "-closed"))
            self.f.put(p / "stat", proc_stat())
            self.f.put(p / "cgroup", "0::" + CG + "\n")

        self.assert_refused(self.mutated_during_read("memory.current", replace), "PROCESS_OR_CGROUP_DIRECTORY_CHANGED")

    def test_unified_cgroup_unknown_is_not_guessed(self):
        self.f.put(self.f.proc / str(PID) / "cgroup", "2:cpu:/docker/" + CID + "\n")
        self.assert_refused(self.collect(), "UNIFIED_CGROUP_REQUIRED")

    def test_symlink_metric_is_not_followed(self):
        target = self.f.root / "private-outside"
        self.f.put(target, "NEVER-READ-PRIVATE-PAYLOAD")
        p = self.f.proc / str(PID) / "status"
        p.unlink()
        p.symlink_to(target)
        result = self.collect()
        self.assertEqual(result["processes"][0]["metrics"]["status"]["state"], "unknown")
        self.assertNotIn("NEVER-READ", json.dumps(result))

    def test_symlink_proc_or_cgroup_directory_is_rejected(self):
        p = self.f.cgroup / CG[1:]
        target = p.with_name(p.name + "-elsewhere")
        p.rename(target)
        p.symlink_to(target, target_is_directory=True)
        self.assert_refused(self.collect(), "PROCESS_IDENTITY_UNAVAILABLE")

    def test_symlink_pid_directory_is_not_followed(self):
        p = self.f.proc / str(PID)
        target = p.with_name("another-process-directory")
        p.rename(target)
        p.symlink_to(target, target_is_directory=True)
        self.assert_refused(self.collect(), "PROCESS_IDENTITY_UNAVAILABLE")

    def test_fifo_metric_cannot_block_or_be_read_as_payload(self):
        p = self.f.proc / str(PID) / "io"
        p.unlink()
        os.mkfifo(p)
        result = self.collect()
        self.assertEqual(result["processes"][0]["metrics"]["io"]["state"], "unknown")

    def test_invalid_binding_has_no_operational_reads(self):
        cases = []
        b = self.f.binding()
        b["extra"] = "forbidden"
        cases.append(b)
        for key, value in (("hostPid", True), ("hostPid", 0), ("startTicks", "1.5"), ("startTicks", "0"), ("cgroupPath", "/system.slice/docker-" + CID + "-suffix.scope"), ("cgroupPath", "/system.slice/../" + CID), ("containerId", "x" * 64), ("name", "private/unsafe")):
            b = self.f.binding()
            b["processes"][0][key] = value
            cases.append(b)
        b = self.f.binding()
        b["processes"] *= 2
        cases.append(b)
        b = self.f.binding()
        b["processes"] = []
        cases.append(b)
        for binding in cases:
            with self.subTest(binding=binding), patch.object(sample.Reader, "__init__", side_effect=AssertionError("must not read")):
                self.assert_refused(self.collect(binding), "FROZEN_BINDING_INVALID")

    def test_sync_elapsed_deadline_does_not_qualify_a_late_read(self):
        result = self.mutated_during_read("io", lambda: time.sleep(0.52), budget_ms=500)
        self.assert_refused(result, "SAMPLE_DEADLINE_EXCEEDED")
        self.assertGreaterEqual(result["sampleDurationMs"], 520)

    def test_caller_mutating_binding_cannot_hide_pid_reuse(self):
        binding = self.f.binding()
        original = sample.Reader.read
        changed = False

        def read(reader, parts, name, limit=32768):
            nonlocal changed
            value = original(reader, parts, name, limit)
            if name == "io" and not changed:
                binding["processes"][0]["startTicks"] = "999"
                self.f.put(self.f.proc / str(PID) / "stat", proc_stat(birth=999))
                changed = True
            return value

        with patch.object(sample.Reader, "read", read):
            self.assert_refused(self.collect(binding), "PROCESS_BIRTH_CHANGED")

    def test_output_limit_returns_small_unknown(self):
        with patch.object(sample, "OUTPUT_LIMIT", 100):
            result = self.collect()
        self.assertEqual(result["reason"], "OUTPUT_BOUND_EXCEEDED")
        self.assertNotIn("processes", result)

    def test_final_json_work_crossing_deadline_is_unknown(self):
        original = sample.json.dumps
        delayed = False

        def dumps(value, *args, **kwargs):
            nonlocal delayed
            if isinstance(value, dict) and value.get("processes") and not delayed:
                delayed = True
                time.sleep(0.52)
            return original(value, *args, **kwargs)

        with patch.object(sample.json, "dumps", dumps):
            result = self.collect()
        self.assertTrue(delayed)
        self.assert_refused(result, "SAMPLE_DEADLINE_EXCEEDED")
        self.assertGreaterEqual(result["sampleDurationMs"], 520)

    def test_one_changed_process_discards_all_process_samples(self):
        second = self.f.add_process(pid=PID + 1, cid="b" * 64, name="candidate-coordinator")
        binding = self.f.binding()
        binding["processes"].append(second)
        original = sample.Reader.read
        changed = False

        def read(reader, parts, name, limit=32768):
            nonlocal changed
            value = original(reader, parts, name, limit)
            if name == "vmstat" and not changed:
                self.f.put(self.f.proc / str(PID + 1) / "stat", proc_stat(PID + 1, birth=999))
                changed = True
            return value

        with patch.object(sample.Reader, "read", read):
            self.assert_refused(self.collect(binding), "PROCESS_BIRTH_CHANGED")

    def test_cli_default_held_and_malformed_input_no_values_or_traceback(self):
        held = subprocess.run([sys.executable, str(MODULE)], input=b"NEVER-READ-PRIVATE-PAYLOAD", capture_output=True, check=False)
        self.assertEqual(held.returncode, 0)
        self.assertEqual(json.loads(held.stdout)["state"], "HELD")
        self.assertEqual(held.stderr, b"")
        for raw in (b'{"schemaVersion":NaN}', b"x" * (sample.INPUT_LIMIT + 1)):
            run = subprocess.run([sys.executable, str(MODULE), "--collect-readonly"], input=raw, capture_output=True, check=False)
            self.assertEqual(run.returncode, 2)
            self.assertEqual(json.loads(run.stdout)["reason"], "FROZEN_BINDING_JSON_INVALID")
            self.assertEqual(run.stderr, b"")


if __name__ == "__main__":
    unittest.main()
