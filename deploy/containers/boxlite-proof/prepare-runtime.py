"""Prepare the official, checksum-pinned 0.9.7 ARM64 companion runtime."""
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile
import urllib.request

url = "https://github.com/boxlite-ai/boxlite/releases/download/v0.9.7/boxlite-runtime-v0.9.7-linux-arm64-gnu.tar.gz"
expected_archive = "78e978d6398d5a78dc76d675941cb05287e8c70b1b647e98a479058a9652be28"
expected_firmware = "f30112748a09cefccb9b3d98098fe2b770e785debfafea5dc9e0523f17b8d74a"
expected_patched = "8b7e1bfff87e691d7a2754b98596adc323014d92ce2a0e522930006161926b6e"
names = {"boxlite-shim", "boxlite-guest", "libkrunfw.so.5", "bwrap", "mke2fs", "debugfs"}
with urllib.request.urlopen(url, timeout=60) as response:
    archive = response.read(32 * 1024 * 1024 + 1)
if hashlib.sha256(archive).hexdigest() != expected_archive:
    raise RuntimeError("Official runtime archive checksum changed")
target = pathlib.Path("/opt/boxlite-runtime")
target.mkdir(parents=True)
found = set()
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
    for entry in tar.getmembers():
        if entry.name == "boxlite-runtime" and entry.isdir():
            continue
        if not entry.isfile() or entry.name not in {"boxlite-runtime/" + name for name in names}:
            raise RuntimeError("Unexpected runtime archive entry")
        name = pathlib.PurePosixPath(entry.name).name
        if name in found:
            raise RuntimeError("Duplicate runtime archive entry")
        found.add(name)
        source = tar.extractfile(entry)
        path = target / name
        path.write_bytes(source.read())
        path.chmod(0o755)
if found != names:
    raise RuntimeError("Incomplete official companion runtime")
firmware = target / "libkrunfw.so.5"
if hashlib.sha256(firmware.read_bytes()).hexdigest() != expected_firmware:
    raise RuntimeError("Unexpected ARM64 firmware")
# ARM64's static glibc loader requires the firmware to declare libc explicitly.
# Never apply this to x86_64: its static loader has different requirements.
subprocess.run(["patchelf", "--add-needed", "libc.so.6", str(firmware)], check=True)
if hashlib.sha256(firmware.read_bytes()).hexdigest() != expected_patched:
    raise RuntimeError("ARM64 firmware fixup result changed")
(target / "proof-runtime.json").write_text(json.dumps({
    "sourceUrl": url, "archiveSha256": expected_archive,
    "firmwareBefore": expected_firmware, "firmwareAfter": expected_patched,
    "fixup": "ARM64-only DT_NEEDED libc.so.6",
}, indent=2) + "\n")
