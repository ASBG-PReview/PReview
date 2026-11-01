# PReview

PR 기반 임시 테스트 환경 구축 프로젝트입니다. 현재는 **앱·Docker·GitHub CI 기반**만 준비하며 AWS 연결과 PR별 환경 생성·삭제는 다음 단계에서 구현합니다.

[![CI](https://github.com/ASBG-PReview/PReview/actions/workflows/ci.yaml/badge.svg)](https://github.com/ASBG-PReview/PReview/actions/workflows/ci.yaml)

## 저장소 구조

앱 하나와 배포 설정을 함께 관리하므로 저장소 하나를 사용합니다. AWS를 연결할 때도 같은 저장소에 필요한 설정만 추가합니다.

```text
app/
  main.py             FastAPI: /health, /version, /pr-info
  static/index.html   PR 번호와 Commit SHA를 보여주는 화면
  tests/test_app.py   API 테스트
  Dockerfile
  requirements.txt
.github/
  workflows/ci.yaml   테스트 → Docker 실행 검증 → main 이미지 발행
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

## 협업과 CI

- 기능 브랜치에서 PR을 엽니다. Python 테스트와 Docker 빌드·실행 검증이 자동 수행됩니다.
- main 병합 후 검증한 이미지를 `ghcr.io/asbg-preview/preview:sha-<전체 SHA>`로 발행합니다. Actions 실행 요약에서 태그를 확인합니다.
- PR에서는 레지스트리 쓰기 권한을 사용하지 않습니다. 이미지 발행은 main의 별도 job에서만 수행합니다.
- 일반 팀원은 승인 1명, `CI required` 통과, 리뷰 대화 해결 후 squash merge합니다.
- 관리자는 **PR 병합에만 bypass**할 수 있습니다. main 직접 push·force push·삭제 차단은 GitHub Ruleset으로 유지합니다.
- Dependabot, Secret scanning, 비밀정보 push 차단이 활성화되어 있습니다. 인증정보와 `.env`는 커밋하지 않습니다.

GHCR 패키지는 비공개일 수 있으므로 로컬에서 이미지를 pull할 때에는 패키지 접근 권한이 필요할 수 있습니다.

## 다음 단계

AWS 연결 시 ECR/OIDC와 배포 방식을 정한 후 Helm·Argo CD 등 필요한 설정을 추가합니다. 지금은 PR 전용 URL이나 클러스터를 생성하지 않습니다.
이전에 준비한 AWS/GitOps 예시는 정리 전 커밋 `7c51d61`의 Git 이력에서 확인할 수 있습니다.
