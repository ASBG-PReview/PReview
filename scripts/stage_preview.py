"""Assemble a clean Docker context from committed blobs, independent of checkout filters."""

import subprocess
import sys
from pathlib import Path

RECIPE = {
    "Dockerfile",
    "gradlew",
    "gradle/wrapper/gradle-wrapper.jar",
    "gradle/wrapper/gradle-wrapper.properties",
    "settings.gradle",
    "build.gradle",
}


def tree(ref):
    records = subprocess.check_output(["git", "ls-tree", "-rz", ref, "--", "preview-api"])
    files = {}
    for entry in records.split(b"\0"):
        if entry:
            header, name = entry.split(b"\t", 1)
            mode, _, oid = header.decode().split()
            files[name.decode().removeprefix("preview-api/")] = (mode, oid)
    return files


def stage(base, destination):
    head_files, base_files = tree("HEAD"), tree(base)
    destination.mkdir()
    for name in sorted(RECIPE | head_files.keys()):
        if name in {".gitignore", "gradlew.bat", "README.md"}:
            continue
        if name not in RECIPE and not name.startswith("src/"):
            raise ValueError(f"Unreviewed build input: {name}")
        mode, oid = head_files[name]
        if mode not in {"100644", "100755"}:
            raise ValueError(f"Expected a regular file: {name}")
        # Only the first read-only build may introduce the Dockerfile. The publisher
        # independently requires every recipe blob to exist on both PR parents.
        if name in RECIPE and not (name == "Dockerfile" and name not in base_files):
            if (mode, oid) != base_files.get(name):
                raise ValueError(f"Build recipe differs from base: {name}")
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subprocess.check_output(["git", "cat-file", "blob", oid]))


if __name__ == "__main__":
    stage(sys.argv[1], Path(sys.argv[2]))
