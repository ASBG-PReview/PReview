"""Trusted workflow_run policy. PR artifacts supply image bytes only."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

BUILD_PATH = ".github/workflows/pr-build.yml"
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


def api(path, payload=None):
    command = ["gh", "api", path]
    if payload is not None:
        command.extend(["--method", "POST", "--input", "-"])
    result = subprocess.run(
        command,
        input=None if payload is None else json.dumps(payload),
        stdout=subprocess.PIPE,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def trusted_builder(root, candidate):
    # pull_request workflows execute from a merge ref. Check both parents' builder
    # blobs against the publisher checkout; a PR cannot substitute a different recipe.
    trusted = subprocess.check_output(["git", "rev-parse", f"HEAD:{BUILD_PATH}"], text=True).strip()
    return all(
        api(f"{root}/contents/{BUILD_PATH}?ref={candidate[side]['sha']}")["sha"] == trusted
        for side in ("head", "base")
    )


def ensure_label(root):
    # Labels may predate this workflow. Never recolor an existing label. If another
    # PR wins the creation race, proceed only after GitHub confirms the label exists.
    names = subprocess.check_output(
        ["gh", "api", "--paginate", f"{root}/labels?per_page=100", "--jq", ".[].name"],
        text=True,
    ).splitlines()
    if "preview" in names:
        return
    try:
        api(f"{root}/labels", {"name": "preview", "color": "0969da"})
    except subprocess.CalledProcessError:
        if api(f"{root}/labels/preview")["name"] != "preview":
            raise


def main(mode):
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    repository = event["repository"]
    root = f"repos/{repository['full_name']}"
    candidate = run_candidate(event)
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
            ensure_label(root)
            if current_pr(api(pr_path), candidate, repository):
                labels = api(f"{root}/issues/{candidate['number']}/labels", {"labels": ["preview"]})
                if not any(label["name"] == "preview" for label in labels):
                    raise RuntimeError("GitHub did not return the requested preview label")
                print(f"PR #{candidate['number']} has the preview label.")
                return
        print("Skipped label: PR is no longer eligible.")
    else:
        raise ValueError(f"Unknown mode: {mode}")


if __name__ == "__main__":
    main(sys.argv[1])
