import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

app = FastAPI(title="PReview Demo", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/version")
def version() -> dict[str, str]:
    return {"version": os.getenv("COMMIT_SHA", "local")}


@app.get("/pr-info")
def pr_info() -> dict[str, str]:
    return {
        "pr_number": os.getenv("PR_NUMBER", "local"),
        "commit_sha": os.getenv("COMMIT_SHA", "local"),
        "namespace": os.getenv("POD_NAMESPACE", "local"),
        "color": os.getenv("PREVIEW_COLOR", "blue"),
    }


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(Path(__file__).parent / "static" / "index.html")
