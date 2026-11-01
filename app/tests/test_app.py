import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "pr,sha,namespace", [("12", "a" * 40, "preview-pr-12"), ("15", "b" * 40, "preview-pr-15")]
)
def test_environment_identity(monkeypatch, pr, sha, namespace):
    monkeypatch.setenv("PR_NUMBER", pr)
    monkeypatch.setenv("COMMIT_SHA", sha)
    monkeypatch.setenv("POD_NAMESPACE", namespace)
    monkeypatch.setenv("PREVIEW_COLOR", "red")
    assert client.get("/pr-info").json() == {
        "pr_number": pr,
        "commit_sha": sha,
        "namespace": namespace,
        "color": "red",
    }
    assert client.get("/version").json() == {"version": sha}


def test_local_defaults(monkeypatch):
    for key in ["PR_NUMBER", "COMMIT_SHA", "POD_NAMESPACE", "PREVIEW_COLOR"]:
        monkeypatch.delenv(key, raising=False)
    assert client.get("/version").json() == {"version": "local"}
    assert client.get("/pr-info").json()["namespace"] == "local"


def test_home_page():
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "PReview" in response.text


def test_unknown_endpoint():
    assert client.get("/unknown").status_code == 404
