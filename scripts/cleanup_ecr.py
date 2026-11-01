"""Delete only images whose well-formed PR tag belongs to a confirmed closed PR."""

import json
import os
import re
import subprocess
import urllib.request


def closed_pr_tags(images, is_closed):
    result = []
    for image in images:
        for tag in image.get("imageTags", []):
            match = re.fullmatch(r"pr-([1-9][0-9]*)-[a-f0-9]{40}", tag)
            if match and is_closed(int(match[1])):
                result.append({"imageTag": tag})
    return result


def main():
    repository = os.environ["GITHUB_REPOSITORY"]
    ecr_uri = os.environ["ECR_REPOSITORY"]
    match = re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/(.+)", ecr_uri)
    if not match:
        raise ValueError("ECR_REPOSITORY must be a complete ECR image repository URI")
    repo_name = match[1]
    states = {}

    def is_closed(number):
        if number not in states:
            req = urllib.request.Request(
                f"https://api.github.com/repos/{repository}/pulls/{number}",
                headers={
                    "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
                    "Accept": "application/vnd.github+json",
                },
            )
            with urllib.request.urlopen(req, timeout=20) as response:
                states[number] = json.load(response)["state"] == "closed"
        return states[number]

    output = subprocess.check_output(
        ["aws", "ecr", "describe-images", "--repository-name", repo_name, "--output", "json"],
        text=True,
    )
    tags = closed_pr_tags(json.loads(output)["imageDetails"], is_closed)
    for start in range(0, len(tags), 100):
        result = subprocess.check_output(
            [
                "aws",
                "ecr",
                "batch-delete-image",
                "--repository-name",
                repo_name,
                "--image-ids",
                json.dumps(tags[start : start + 100]),
                "--output",
                "json",
            ],
            text=True,
        )
        if json.loads(result).get("failures"):
            raise RuntimeError(result)
    print(f"Deleted {len(tags)} image tags belonging to closed PRs")


if __name__ == "__main__":
    main()
