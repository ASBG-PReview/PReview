import pytest

from scripts.cleanup_ecr import closed_pr_tags


def test_only_closed_pr_tags_are_deleted():
    sha = "a" * 40
    images = [{"imageTags": [f"pr-12-{sha}", f"pr-15-{sha}", "latest", "pr-12-bad"]}, {}]
    assert closed_pr_tags(images, lambda number: number == 12) == [{"imageTag": f"pr-12-{sha}"}]


def test_api_failure_aborts_cleanup():
    def failed_lookup(_):
        raise RuntimeError("GitHub unavailable")

    with pytest.raises(RuntimeError):
        closed_pr_tags([{"imageTags": ["pr-12-" + "a" * 40]}], failed_lookup)
