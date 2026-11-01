import json
import os
import time
import urllib.error
import urllib.request

base = "http://127.0.0.1:8000"
for attempt in range(30):
    try:
        with urllib.request.urlopen(base + "/health", timeout=2) as response:
            assert json.load(response) == {"status": "ok"}
        break
    except (OSError, urllib.error.URLError):
        if attempt == 29:
            raise
        time.sleep(1)

with urllib.request.urlopen(base + "/pr-info", timeout=3) as response:
    data = json.load(response)
assert data["pr_number"] == os.environ["PR_NUMBER"], data
assert data["commit_sha"] == os.environ["COMMIT_SHA"], data
assert data["namespace"] == "preview-smoke", data
with urllib.request.urlopen(base + "/version", timeout=3) as response:
    assert json.load(response)["version"] == os.environ["COMMIT_SHA"]
with urllib.request.urlopen(base, timeout=3) as response:
    assert "PReview" in response.read().decode()
print("Container health, identity, version and home page passed")
