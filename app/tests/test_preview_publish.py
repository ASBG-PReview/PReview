import hashlib
import json
import subprocess
from unittest.mock import Mock

import pytest

from scripts import preview_publish as publish
from scripts.stage_preview import stage

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


@pytest.mark.parametrize("side", ["head", "base"])
@pytest.mark.parametrize("change", ["missing", "modified", "mode", "intact", "truncated", "403"])
def test_verify_recipe_tree(event, monkeypatch, side, change):
    candidate = publish.run_candidate(event)
    paths = [
        publish.BUILD_PATH,
        "scripts/stage_preview.py",
        *[f"preview-api/{p}" for p in publish.RECIPE],
    ]
    local = "\n".join(f"100644 blob abc\t{p}" for p in paths)
    monkeypatch.setattr(publish.subprocess, "check_output", Mock(return_value=local))

    def snapshot(url):
        files = [{"path": p, "mode": "100644", "sha": "abc"} for p in paths]
        if candidate[side]["sha"] in url:
            item = next(e for e in files if e["path"] == "preview-api/Dockerfile")
            if change == "missing":
                files.remove(item)
            elif change == "modified":
                item["sha"] = "changed"
            elif change == "mode":
                item["mode"] = "120000"
            elif change == "403":
                raise subprocess.CalledProcessError(1, "gh", stderr="403")
            elif change == "truncated":
                return {"truncated": True, "tree": files}
        return {"truncated": False, "tree": files}

    monkeypatch.setattr(publish, "api", snapshot)
    if change in {"403", "truncated"}:
        with pytest.raises((RuntimeError, subprocess.CalledProcessError)):
            publish.trusted_builder("repos/owner/repo", candidate)
    else:
        assert publish.trusted_builder("repos/owner/repo", candidate) == (change == "intact")


def live_pr(candidate):
    return {**candidate, "state": "open", "user": {"login": "team-member"}}


@pytest.mark.parametrize("trusted", [True, False])
def test_gate_emits_publication_target_only_for_a_trusted_build(
    event, monkeypatch, tmp_path, trusted
):
    payload = tmp_path / "event.json"
    payload.write_text(json.dumps(event), encoding="utf-8")
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(payload))
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    candidate = publish.run_candidate(event)
    monkeypatch.setattr(publish, "api", Mock(return_value=live_pr(candidate)))
    monkeypatch.setattr(publish, "trusted_builder", Mock(return_value=trusted))
    publish.main("check")
    result = dict(line.split("=", 1) for line in output.read_text().splitlines())
    expected = {"eligible": "false"}
    if trusted:
        expected = {
            "eligible": "true",
            "sha": SHA,
            "image": f"ghcr.io/asbg-preview/preview:pr-17-{SHA}",
        }
    assert result == expected


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


DIGEST = "sha256:" + hashlib.sha256(b"manifest").hexdigest()


@pytest.mark.parametrize("race", ["before", "during", "already labeled", "stable"])
def test_label_race_is_bound_to_original_commit(event, monkeypatch, race):
    candidate = publish.run_candidate(event)
    root = "repos/ASBG-PReview/PReview"
    live = live_pr(candidate) | {"labels": [{"name": "bug"}]}
    stale = live | {"head": {"sha": "d" * 40, "repo": {"id": 4}}}
    if race == "already labeled":
        live["labels"].append({"name": "preview"})
    replies = [
        None,
        stale if race == "before" else live,
        [{"name": "preview"}],
        stale if race == "during" else live,
        [],
    ]
    api = Mock(side_effect=replies)
    monkeypatch.setattr(publish, "api", api)
    monkeypatch.setenv("GITHUB_SERVER_URL", "https://github.com")
    monkeypatch.setenv("GITHUB_RUN_ID", "42")
    monkeypatch.setattr(publish, "ensure_label", Mock())
    publish.record_and_label(root, candidate, event["repository"], DIGEST)
    assert api.call_args_list[0].args[0] == f"{root}/statuses/{SHA}"
    assert api.call_args_list[0].args[1]["description"] == DIGEST
    if race == "during":
        api.assert_called_with(f"{root}/issues/17/labels/preview", delete=True)
    elif race in {"before", "already labeled"}:
        assert api.call_count == 2
    else:
        assert api.call_count == 4


@pytest.mark.parametrize(
    "case",
    [
        "ready",
        "new head",
        "stale",
        "unlabeled",
        "other PR",
        "bad digest",
        "registry changed",
        "untrusted writer",
        "failed",
    ],
)
def test_resolve_requires_matching_readiness(event, monkeypatch, case):
    candidate = publish.run_candidate(event)
    live = live_pr(candidate) | {"labels": [] if case == "unlabeled" else [{"name": "preview"}]}
    requested = "b" * 40 if case in {"stale", "new head"} else SHA
    if case == "new head":
        live["head"] = dict(live["head"], sha=requested)
    row = {
        "creator": {"login": "other" if case == "untrusted writer" else "github-actions[bot]"},
        "state": "failure" if case == "failed" else "success",
        "description": "bad" if case == "bad digest" else DIGEST,
        "context": publish.status_context(18 if case == "other PR" else 17),
    }
    api = Mock(side_effect=[event["repository"], [] if case == "new head" else [row], live])
    monkeypatch.setattr(
        publish.subprocess,
        "check_output",
        Mock(return_value=b"different" if case == "registry changed" else b"manifest"),
    )
    monkeypatch.setattr(publish, "api", api)
    if case == "ready":
        assert (
            publish.resolve("ASBG-PReview/PReview", 17, requested)
            == f"ghcr.io/asbg-preview/preview@{DIGEST}"
        )
    else:
        with pytest.raises(RuntimeError):
            publish.resolve("ASBG-PReview/PReview", 17, requested)
    if case == "new head":
        assert f"/commits/{requested}/" in api.call_args.args[0]


@pytest.mark.parametrize("attack", ["old image", "skip tests", "dockerignore", "clean"])
def test_stage_only_tested_commit_inputs(tmp_path, monkeypatch, attack):
    monkeypatch.chdir(tmp_path)
    app = tmp_path / "preview-api"
    java_test = "src/test/java/BrokenTest.java"
    for name in publish.RECIPE | {java_test}:
        path = app / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("original", encoding="utf-8")

    def commit():
        subprocess.run(["git", "add", "preview-api"], check=True)
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-qm",
                "test fixture",
            ],
            check=True,
        )

    subprocess.run(["git", "init", "-q"], check=True)
    commit()
    base = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    (app / java_test).write_text("throw new AssertionError();", encoding="utf-8")
    if attack == "old image":
        (app / "Dockerfile").write_text("FROM old-app", encoding="utf-8")
    elif attack == "skip tests":
        (app / "build.gradle").write_text("test.enabled = false", encoding="utf-8")
    elif attack == "dockerignore":
        (app / ".dockerignore").write_text("src/test", encoding="utf-8")
    commit()
    destination = tmp_path / "context"
    if attack == "clean":
        stage(base, destination)
        assert (destination / java_test).read_text() == "throw new AssertionError();"
    else:
        with pytest.raises(ValueError):
            stage(base, destination)


def test_concurrent_label_creation_confirms_winner(monkeypatch):
    monkeypatch.setattr(publish.subprocess, "check_output", lambda *a, **kw: "bug\n")
    api = Mock(side_effect=[subprocess.CalledProcessError(1, "gh"), {"name": "preview"}])
    monkeypatch.setattr(publish, "api", api)
    publish.ensure_label("repos/owner/repo")
    assert api.call_args.args == ("repos/owner/repo/labels/preview",)
