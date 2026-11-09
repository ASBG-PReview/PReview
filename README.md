# PReview

PR 기반 임시 테스트 환경 구축 프로젝트입니다. 현재는 **앱·Docker·GitHub CI 기반**만 준비하며 AWS 연결과 PR별 환경 생성·삭제는 다음 단계에서 구현합니다.

[![CI](https://github.com/ASBG-PReview/PReview/actions/workflows/ci.yaml/badge.svg)](https://github.com/ASBG-PReview/PReview/actions/workflows/ci.yaml)

## 저장소 구조

FastAPI 기본 앱과 Spring PR 미리보기를 같은 저장소에서 관리합니다.

```text
app/
  main.py             FastAPI: /health, /version, /pr-info
  static/index.html   PR 번호와 Commit SHA를 보여주는 화면
  tests/test_app.py   API 테스트
  Dockerfile
  requirements.txt
preview-api/          Spring Boot PR 미리보기 (8080, /health, /environment)
.github/
  workflows/ci.yaml   테스트 → Docker 실행 검증 → main 이미지 발행
  workflows/pr-build.yml    PR head의 Spring 빌드·테스트·컨테이너 응답 검사
  workflows/pr-publish.yml  이미지 발행·검증 결과 서명·preview 라벨
  dependabot.yml      의존성 업데이트
  pull_request_template.md
scripts/smoke.py      실제 컨테이너의 응답·환경 정보 검사
compose.yaml         로컬 실행
requirements-dev.txt
pyproject.toml       테스트·코드 스타일 설정
```

## 실행

Docker Engine을 시작한 뒤:

```sh
docker compose up --build -d
```

화면: http://localhost:8000 · 종료: `docker compose down`

`PR_NUMBER`, `COMMIT_SHA`, `POD_NAMESPACE`, `PREVIEW_COLOR=blue|red` 환경변수로 화면 정보를 변경할 수 있습니다.

Python만 사용할 때는 가상환경에서:

```sh
python -m pip install -r requirements-dev.txt
python -m pytest -q
python -m uvicorn app.main:app --reload
```

## PR 정책

`최신 main → 작업 브랜치 → PR → 리뷰·CI → Squash merge`

- `develop` 없이 작업별 `feat/…`, `fix/…`, `chore/…` 브랜치를 만듭니다. 한 PR에는 한 가지 목적만 담고, 작업 중에는 Draft로 공유합니다.
- 준비되면 변경 이유와 검증 결과를 적고 작성자 외 1명에게 리뷰를 요청합니다. 중요한 오류는 수정하고, 취향 수준의 의견은 병합을 막지 않습니다.
- 최신 main을 반영하고 CI·리뷰를 확인한 뒤 작성자가 Squash merge합니다. 병합한 브랜치는 자동 삭제되며 다음 작업은 새 브랜치에서 시작합니다.

**GitHub가 강제하는 조건**

| 조건 | 일반 팀원 | 관리자 |
|---|---|---|
| main 직접 push·force push·삭제 금지 | 필수 | 필수 |
| PR + 최신 main 기준 `CI required` 통과 | 필수 | 필수, bypass 없음 |
| 리뷰 대화 해결 + Squash merge | 필수 | 필수 |
| 작성자 외 승인 1명, 변경 시 기존 승인 취소 | 필수 | 이 승인 조건만 PR에서 우회 가능 |

관리자 우회 시 PR 본문에 이유를 남깁니다. 마지막 push 작성자 외의 별도 승인을 요구하지 않아 불필요한 제3자 리뷰를 피합니다.
브랜치 이름·PR 크기·설명 충실도·우회 사유는 팀 약속이며 자동 검사하지 않습니다. 일반 팀원은 Write, 관리자는 최소 인원으로 운영합니다.
규칙은 [GitHub Rulesets](https://github.com/ASBG-PReview/PReview/rules)에서 관리합니다. 관리자의 규칙 편집 권한 자체를 막는 설정은 아닙니다.

## CI와 이미지

FastAPI는 PR에서 Python 테스트와 Docker 실행 검사를 거친 뒤, main에 병합되면 `ghcr.io/asbg-preview/preview:sha-<전체 SHA>`로 발행합니다.
GHCR 패키지는 비공개일 수 있습니다. Dependabot과 Secret scanning/push protection은 활성화되어 있으며 인증정보와 `.env`는 커밋하지 않습니다.

### Spring PR 이미지를 배포하는 쪽에서

같은 저장소의 main 대상 앱 PR에서 Actions가 Spring 이미지를 검사하고 GHCR(GitHub Container Registry)에 `pr-<번호>-<전체 head SHA>` 태그로 발행합니다. 발행한 이미지의 내용 식별자(digest)를 다시 읽고 PR·커밋·digest를 묶은 기록에 서명한 뒤 `preview` 라벨을 추가합니다.

배포 프로세스는 보호된 main의 체크아웃에서 현재 PR 번호와 전체 head SHA를 사용합니다. Python 3, `gh attestation verify`를 지원하는 GitHub CLI, Skopeo가 필요합니다. GitHub에는 PR·커밋 상태·Actions 실행·서명을 읽을 수 있는 계정으로, 비공개 GHCR에는 패키지 읽기가 가능한 계정으로 인증합니다.

```sh
python -m scripts.preview_publish resolve ASBG-PReview/PReview "$PR_NUMBER" "$HEAD_SHA"
```

성공하면 `ghcr.io/asbg-preview/preview@sha256:…` 한 줄을 반환합니다. 배포자는 반환된 주소를 그대로 Pod 이미지에 사용합니다. 새 커밋의 조회가 실패하면 배포 갱신을 보류하고 다시 조회합니다. 이전 버전을 실행 중인 열린 PR은 그동안 유지하고, PR이 닫히거나 병합된 뒤 해당 PR의 환경을 정리합니다.

팀 차트와 ApplicationSet에 이 판정을 연결하고, 실제 Pod 이미지와 `/environment`의 SHA를 대조하는 단계가 남아 있습니다. PR 미리보기 배포는 머지 필수 검사가 아닙니다.
이전에 준비한 AWS/GitOps 예시는 정리 전 커밋 `7c51d61`의 Git 이력에서 확인할 수 있습니다.
