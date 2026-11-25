"""Load, deploy and check the exact local Docker build using one minikube profile."""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path


def output(*args):
    return subprocess.check_output(args, text=True, encoding="utf-8", timeout=30).strip()


def immutable_image(repository, alias):
    image_id = output("docker", "image", "inspect", "--format", "{{.Id}}", f"{repository}:{alias}")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("Docker did not return an image ID")
    return image_id, f"{repository}:local-{image_id[7:]}"


def resource(kubectl, kind, release):
    selector = f"app.kubernetes.io/instance={release},app.kubernetes.io/name=preview-api"
    doc = json.loads(output(*kubectl, "get", kind, "-l", selector, "-o", "json"))
    items = doc["items"]
    if len(items) != 1:
        raise ValueError(f"Expected one {kind} for {release}, found {len(items)}")
    return items[0]


def deployment_identity(deployment):
    metadata = deployment["metadata"]
    return metadata["uid"], metadata["generation"]


def wait_forward(process, port):
    lines = queue.Queue()

    def read_output():
        for line in process.stdout:
            lines.put(line.rstrip())
        lines.put(None)

    threading.Thread(target=read_output, daemon=True).start()
    deadline = time.monotonic() + 30
    last = ""
    while True:
        try:
            line = lines.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty:
            raise RuntimeError(f"Port-forward timed out. {last}") from None
        if line is None:
            raise RuntimeError(f"Port-forward exited. {last}")
        if line == f"Forwarding from 127.0.0.1:{port} -> 8080":
            return
        last = line
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Port-forward timed out. {last}")


def verify_http(port, expected):
    for endpoint, payload in expected.items():
        raw = output("curl", "--noproxy", "*", "--connect-timeout", "2", "--max-time", "5",
                     "--fail", "--silent", "--show-error", f"http://127.0.0.1:{port}/{endpoint}")
        observed = json.loads(raw)
        if observed != payload:
            raise ValueError(f"/{endpoint}: expected {payload}, got {observed}")
        print(f"/{endpoint} {observed}")


def main(mode):
    profile = os.environ["MINIKUBE_PROFILE"]
    namespace = os.environ["NAMESPACE"]
    release = os.environ["RELEASE"]
    repository = os.environ["IMAGE_REPOSITORY"]
    image_id, reference = immutable_image(repository, os.environ["IMAGE_TAG"])

    if mode in {"load", "deploy"}:
        subprocess.run(["docker", "tag", image_id, reference], check=True)
        subprocess.run(["minikube", "-p", profile, "image", "load", "--daemon", reference], check=True)
        if mode == "load":
            return

    kube = ["kubectl", "--context", profile]
    ns_kube = [*kube, "--namespace", namespace]
    environment = {"prNumber": os.environ["PR_NUMBER"], "commitSha": os.environ["COMMIT_SHA"]}
    if mode == "deploy":
        manifest = output(*kube, "create", "namespace", namespace, "--dry-run=client", "-o", "yaml")
        if not output(*kube, "get", "namespace", namespace, "--ignore-not-found", "-o", "name"):
            subprocess.run([*kube, "apply", "-f", "-"], input=manifest, text=True, check=True)
        subprocess.run([*ns_kube, "apply", "-f", "quota.yaml"], check=True)
        overrides = {"image": {"repository": repository, "tag": reference.rsplit(":", 1)[1], "pullPolicy": "Never"},
                     "preview": environment}
        subprocess.run(["helm", "--kube-context", profile, "upgrade", "--install", release,
                        "charts/preview-api", "--namespace", namespace,
                        "-f", "charts/preview-api/values-local.yaml", "-f", "-"],
                       input=json.dumps(overrides), text=True, check=True)

    deployment = resource(ns_kube, "deployment", release)
    containers = deployment["spec"]["template"]["spec"]["containers"]
    app = [container for container in containers if container["name"] == "preview-api"]
    images = [container["image"] for container in app]
    if images != [reference]:
        raise ValueError(f"Deployment image {images} does not match local build {reference}")
    # Another upgrade may have finished before our first read using the same image.
    values = {entry["name"]: entry.get("value", "") for entry in app[0].get("env", []) if "valueFrom" not in entry}
    for key in ("PR_NUMBER", "COMMIT_SHA"):
        if values.get(key) != os.environ[key]:
            raise ValueError(f"Deployment {key} does not match the requested value")
    name = deployment["metadata"]["name"]
    subprocess.run([*ns_kube, "rollout", "status", f"deployment/{name}", "--timeout=180s"], check=True)
    # rollout status follows newer revisions when a deployment changes mid-check.
    def check_revision():
        current = resource(ns_kube, "deployment", release)
        if deployment_identity(current) != deployment_identity(deployment):
            raise RuntimeError("Deployment changed during verification")

    check_revision()
    if mode == "deploy":
        return

    service = resource(ns_kube, "service", release)["metadata"]["name"]
    port = int(os.environ["LOCAL_PORT"])
    if not 1 <= port <= 65535:
        raise ValueError("LOCAL_PORT must be between 1 and 65535")
    command = [*ns_kube, "port-forward", "--address=127.0.0.1", f"service/{service}", f"{port}:8080"]
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace") as process:
        try:
            wait_forward(process, port)
            verify_http(port, {
                "health": {"status": "ok"},
                "environment": {**environment, "namespace": namespace},
                "version": {"version": Path("preview-api/src/main/version.txt").read_text().strip()},
            })
            if process.poll() is not None:
                raise RuntimeError("Port-forward exited during verification")
            check_revision()
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()


if __name__ == "__main__":
    if sys.argv[1:] not in (["load"], ["deploy"], ["test"]):
        sys.exit("Usage: local_preview.py load|deploy|test (invoked by Make)")
    try:
        main(sys.argv[1])
    except (KeyError, OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
