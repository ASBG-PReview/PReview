import json
import subprocess
from unittest.mock import Mock

import pytest

from scripts import preview_publish as publish

SHA = "abc01234" * 5


@pytest.fixture
def event():
    repo = {"id": 4, "default_branch": "main", "full_name": "ASBG-PReview/PReview"}
    pr = {
        "number": 17,
        "head": {"repo": repo, "sha": SHA},
        "base": {"ref": "main", "repo": repo, "sha": "f" * 40},
    }
    return {
        "repository": repo,
        "workflow_run": {
            "event": "pull_request",
            "conclusion": "success",
            "path": ".github/workflows/pr-build.yml",
            "head_repository": repo,
            "head_sha": SHA,
            "actor": {"login": "team-member"},
            "pull_requests": [pr],
        },
    }


def test_full_sha_image_contract(event):
    candidate = publish.run_candidate(event)
    assert publish.image_ref(event["repository"]["full_name"], candidate) == (
        f"ghcr.io/asbg-preview/preview:pr-17-{SHA}"
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("conclusion", "failure"),
        ("event", "push"),
        ("path", ".github/workflows/lookalike.yml"),
        ("head_repository", {"id": 99}),
        ("head_repository", None),
        ("head_sha", "x" * 40),
        ("head_sha", "d" * 40),
        ("actor", {"login": "dependabot[bot]"}),
        ("pull_requests", []),
    ],
)
def test_refuse_unrelated_run(event, field, value):
    event["workflow_run"][field] = value
    assert publish.run_candidate(event) is None


def test_refuse_ambiguous_run(event):
    event["workflow_run"]["pull_requests"] *= 2
    assert publish.run_candidate(event) is None


@pytest.mark.parametrize("changed_parent", ["head", "base"])
def test_changed_build_workflow_is_never_published(event, monkeypatch, changed_parent):
    candidate = publish.run_candidate(event)
    changed = candidate[changed_parent]["sha"]
    monkeypatch.setattr(publish.subprocess, "check_output", lambda *a, **kw: "trusted\n")
    monkeypatch.setattr(
        publish, "api", lambda path: {"sha": "bad" if changed in path else "trusted"}
    )
    assert not publish.trusted_builder("repos/owner/repo", candidate)


def live_pr(candidate):
    return {**candidate, "state": "open", "user": {"login": "team-member"}}


@pytest.mark.parametrize(
    "change",
    [
        {"state": "closed"},
        {"head": {"sha": "d" * 40, "repo": {"id": 4}}},
        {"head": {"sha": SHA, "repo": {"id": 99}}},
        {"user": {"login": "dependabot[bot]"}},
        {"base": {"ref": "other", "repo": {"id": 4}}},
    ],
)
def test_delayed_run_must_match_current_pr(event, change):
    candidate = publish.run_candidate(event)
    assert not publish.current_pr(live_pr(candidate) | change, candidate, event["repository"])


@pytest.mark.parametrize("still_current", [True, False])
def test_label_only_current_head_and_preserve_existing_labels(
    event, monkeypatch, tmp_path, still_current
):
    payload = tmp_path / "event.json"
    payload.write_text(json.dumps(event), encoding="utf-8")
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(payload))
    live = live_pr(publish.run_candidate(event))
    fresh = live if still_current else live | {"state": "closed"}
    api = Mock(side_effect=[live, fresh, [{"name": "bug"}, {"name": "preview"}]])
    monkeypatch.setattr(publish, "api", api)
    monkeypatch.setattr(publish, "ensure_label", Mock())
    publish.main("label")
    if still_current:
        assert api.call_args.args == (
            "repos/ASBG-PReview/PReview/issues/17/labels",
            {"labels": ["preview"]},
        )
    else:
        assert api.call_count == 2


def test_concurrent_label_creation_confirms_winner(monkeypatch):
    monkeypatch.setattr(publish.subprocess, "check_output", lambda *a, **kw: "bug\n")
    api = Mock(side_effect=[subprocess.CalledProcessError(1, "gh"), {"name": "preview"}])
    monkeypatch.setattr(publish, "api", api)
    publish.ensure_label("repos/owner/repo")
    assert api.call_args.args == ("repos/owner/repo/labels/preview",)
