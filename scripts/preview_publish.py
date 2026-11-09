"""Trusted workflow_run policy. PR artifacts supply image bytes only.

From a trusted checkout with gh and skopeo read access, deploy the output of
    python -m scripts.preview_publish resolve OWNER/REPO PR_NUMBER FULL_HEAD_SHA
Only a successful exit provides a deployable image reference.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.stage_preview import RECIPE

BUILD_PATH = ".github/workflows/pr-build.yml"
PUBLISH_PATH = ".github/workflows/pr-publish.yml"
RECEIPT_NAME = "preview-publication.json"
BOT = "dependabot[bot]"


def run_candidate(event):
    """Accept only GitHub's unambiguous association between this run and one same-repo PR."""
    run = event["workflow_run"]
    repo_id = event["repository"]["id"]
    links = run["pull_requests"]
    if (
        run["event"] != "pull_request"
        or run["conclusion"] != "success"
        or run["path"] != BUILD_PATH
        or (run["head_repository"] or {}).get("id") != repo_id
        or run["actor"]["login"] == BOT
        or len(links) != 1
    ):
        return None
    pr = links[0]
    sha = run["head_sha"]
    if (
        type(pr["number"]) is not int
        or pr["number"] < 1
        or not re.fullmatch(r"[0-9a-f]{40}", sha)
        or pr["head"]["sha"] != sha
        or pr["head"]["repo"]["id"] != repo_id
        or pr["base"]["repo"]["id"] != repo_id
        or pr["base"]["ref"] != event["repository"]["default_branch"]
        or not re.fullmatch(r"[0-9a-f]{40}", pr["base"]["sha"])
    ):
        return None
    return pr


def current_pr(live, candidate, repository):
    return (
        live["state"] == "open"
        and live["number"] == candidate["number"]
        and live["user"]["login"] != BOT
        and live["head"]["sha"] == candidate["head"]["sha"]
        and (live["head"]["repo"] or {}).get("id") == repository["id"]
        and live["base"]["repo"]["id"] == repository["id"]
        and live["base"]["ref"] == repository["default_branch"]
    )


def image_ref(repository, candidate):
    return f"ghcr.io/{repository.lower()}:pr-{candidate['number']}-{candidate['head']['sha']}"


def api(path, payload=None, *, delete=False):
    command = ["gh", "api", path]
    if payload is not None:
        command.extend(["--method", "POST", "--input", "-"])
    if delete:
        command.extend(["--method", "DELETE"])
    result = subprocess.run(
        command,
        input=None if payload is None else json.dumps(payload),
        stdout=subprocess.PIPE,
        encoding="utf-8",
        check=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else None


def trusted_builder(root, candidate):
    paths = {BUILD_PATH, "scripts/stage_preview.py", *(f"preview-api/{p}" for p in RECIPE)}
    rows = subprocess.check_output(
        ["git", "ls-tree", "-r", "HEAD", "--", *sorted(paths)], text=True
    ).splitlines()
    trusted = {}
    for row in rows:
        metadata, path = row.split("\t", 1)
        mode, kind, sha = metadata.split()
        if kind == "blob" and mode in {"100644", "100755"}:
            trusted[path] = (mode, sha)
    if trusted.keys() != paths:
        raise RuntimeError("Publisher checkout is missing a trusted build input")
    for side in ("head", "base"):
        snapshot = api(f"{root}/git/trees/{candidate[side]['sha']}?recursive=1")
        if snapshot["truncated"]:
            raise RuntimeError("Cannot verify a truncated Git tree")
        found = {e["path"]: (e["mode"], e["sha"]) for e in snapshot["tree"] if e["path"] in paths}
        if found != trusted:
            return False
    return True


def ensure_label(root):
    # Labels may predate this workflow. Never recolor an existing label. If another
    # PR wins the creation race, proceed only after GitHub confirms the label exists.
    names = subprocess.check_output(
        ["gh", "api", "--paginate", f"{root}/labels?per_page=100", "--jq", ".[].name"],
        encoding="utf-8",
    ).splitlines()
    if "preview" in names:
        return
    try:
        api(f"{root}/labels", {"name": "preview", "color": "0969da"})
    except subprocess.CalledProcessError:
        if api(f"{root}/labels/preview")["name"] != "preview":
            raise


def status_context(number):
    return f"preview/ready/pr-{number}"


def receipt_bytes(repository, candidate, digest, run_id, attempt):
    """Stable bytes for both the GitHub signer and a deployment-side verifier."""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("Invalid publication digest")
    fields = {
        "version": 1,
        "repository_id": repository["id"],
        "image": image_ref(repository["full_name"], candidate),
        "pr": candidate["number"],
        "head_sha": candidate["head"]["sha"],
        "digest": digest,
        "run_id": int(run_id),
        "run_attempt": int(attempt),
    }
    return (json.dumps(fields, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def verify_publication(root, repository, candidate, digest, target_url):
    # The status supplies a locator. GitHub's run metadata and OIDC signature
    # authenticate the publisher and the PR-specific content of its receipt.
    run_url = re.escape(repository["html_url"] + "/actions/runs/")
    match = re.fullmatch(run_url + r"([1-9][0-9]*)/attempts/([1-9][0-9]*)", target_url or "")
    if not match:
        raise RuntimeError("Missing publisher run attempt")
    run_id, attempt = map(int, match.groups())
    run = api(f"{root}/actions/runs/{run_id}/attempts/{attempt}")
    workflow = api(f"{root}/actions/workflows/pr-publish.yml")
    if (
        run["id"] != run_id
        or run["run_attempt"] != attempt
        or run["status"] != "completed"
        or run["conclusion"] != "success"
        or run["event"] != "workflow_run"
        or run["workflow_id"] != workflow["id"]
        or run["path"] != PUBLISH_PATH
        or run["repository"]["id"] != repository["id"]
        or (run["head_repository"] or {}).get("id") != repository["id"]
        or run["head_branch"] != repository["default_branch"]
        or not re.fullmatch(r"[0-9a-f]{40}", run["head_sha"])
    ):
        raise RuntimeError("The recorded attempt is not a successful default-branch publisher")
    source_ref = f"refs/heads/{repository['default_branch']}"
    with TemporaryDirectory() as directory:
        receipt = Path(directory) / RECEIPT_NAME
        receipt.write_bytes(receipt_bytes(repository, candidate, digest, run_id, attempt))
        subprocess.run(
            [
                "gh",
                "attestation",
                "verify",
                str(receipt),
                "--repo",
                repository["full_name"],
                "--cert-identity",
                f"{repository['html_url']}/{PUBLISH_PATH}@{source_ref}",
                "--source-ref",
                source_ref,
                "--source-digest",
                run["head_sha"],
                "--deny-self-hosted-runners",
            ],
            stdout=subprocess.DEVNULL,
            check=True,
        )


def record_and_label(root, candidate, repository, digest):
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("Invalid publication digest")
    number, sha = candidate["number"], candidate["head"]["sha"]
    pr_path = f"{root}/pulls/{number}"
    label_path = f"{root}/issues/{number}/labels"
    # A commit status remains bound to the verified SHA even if the PR moves during POST.
    api(
        f"{root}/statuses/{sha}",
        {
            "state": "success",
            "context": status_context(number),
            "description": digest,
            "target_url": f"{repository['html_url']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
            f"/attempts/{os.environ['GITHUB_RUN_ATTEMPT']}",
        },
    )
    ensure_label(root)
    before = api(pr_path)
    if not current_pr(before, candidate, repository):
        return
    if any(label["name"] == "preview" for label in before["labels"]):
        return
    labels = api(label_path, {"labels": ["preview"]})
    if not any(label["name"] == "preview" for label in labels):
        raise RuntimeError("GitHub did not return the requested preview label")
    if not current_pr(api(pr_path), candidate, repository):
        api(f"{label_path}/preview", delete=True)


def resolve(repository_name, number, sha):
    """Print a digest-pinned deployment input only for this exact open, labeled PR head."""
    if number < 1 or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected a PR number and a full commit SHA")
    root = f"repos/{repository_name}"
    repository = api(root)
    candidate = {"number": number, "head": {"sha": sha}}
    image = image_ref(repository["full_name"], candidate)
    # GitHub returns the newest status for each context first on the statuses endpoint.
    # A missing status (including a new head that has never published) fails closed.
    page = 1
    while True:
        rows = api(f"{root}/commits/{sha}/statuses?per_page=100&page={page}")
        for row in rows:
            if row["context"] == status_context(number):
                digest = row["description"] or ""
                if (
                    row["state"] != "success"
                    or row["creator"]["login"] != "github-actions[bot]"
                    or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
                ):
                    raise RuntimeError("Invalid preview readiness record")
                verify_publication(root, repository, candidate, digest, row.get("target_url"))
                manifest = subprocess.check_output(
                    ["skopeo", "inspect", "--raw", f"docker://{image}"]
                )
                if "sha256:" + hashlib.sha256(manifest).hexdigest() != digest:
                    raise RuntimeError("Published tag differs from the commit readiness record")
                live = api(f"{root}/pulls/{number}")
                if not current_pr(live, candidate, repository) or not any(
                    label["name"] == "preview" for label in live["labels"]
                ):
                    raise RuntimeError("The requested commit is not the current labeled PR head")
                return f"ghcr.io/{repository['full_name'].lower()}@{digest}"
        if len(rows) < 100:
            raise RuntimeError("No verified publication for the requested PR and SHA")
        page += 1


def main(mode):
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    repository = event["repository"]
    root = f"repos/{repository['full_name']}"
    candidate = run_candidate(event)
    if mode == "receipt":
        if not candidate:
            raise RuntimeError("Cannot attest an unrelated workflow run")
        path = Path(os.environ["RUNNER_TEMP"]) / RECEIPT_NAME
        path.write_bytes(
            receipt_bytes(
                repository,
                candidate,
                os.environ["PREVIEW_DIGEST"],
                os.environ["GITHUB_RUN_ID"],
                os.environ["GITHUB_RUN_ATTEMPT"],
            )
        )
        return
    eligible = False
    if candidate:
        pr_path = f"{root}/pulls/{candidate['number']}"
        eligible = current_pr(api(pr_path), candidate, repository)
    if mode == "current":
        print(str(eligible).lower())
    elif mode == "check":
        eligible = eligible and trusted_builder(root, candidate)
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
            print(f"eligible={str(eligible).lower()}", file=output)
            if eligible:
                print(f"sha={candidate['head']['sha']}", file=output)
                print(f"image={image_ref(repository['full_name'], candidate)}", file=output)
        if not eligible:
            print("Skipped: run, PR head or build definition is no longer eligible.")
    elif mode == "label":
        if eligible:
            record_and_label(root, candidate, repository, os.environ["PREVIEW_DIGEST"])
        else:
            print("Skipped label: PR is no longer eligible.")
    else:
        raise ValueError(f"Unknown mode: {mode}")


if __name__ == "__main__":
    if sys.argv[1] == "resolve":
        print(resolve(sys.argv[2], int(sys.argv[3]), sys.argv[4]))
    else:
        main(sys.argv[1])
