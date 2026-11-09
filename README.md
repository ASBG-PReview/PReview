# PReview

PR별 미리보기 환경에 사용하는 Java 21 Spring Boot 서비스입니다. GitHub Actions가 Docker 빌드를 실행하고 Gradle이 실행 가능한 JAR를 만듭니다. Python은 빌드 파일 선택과 이미지 발행·배포 검증에 사용합니다.

## 로컬 실행

저장소 루트에서 실행합니다. `/health`의 정상 상태는 `ok`입니다. `/environment`는 `PR_NUMBER`, `COMMIT_SHA`, `NAMESPACE`를 반환하며 Compose 기본값은 모두 `local`입니다.

```sh
docker compose up --build -d
curl http://localhost:8080/health
curl http://localhost:8080/environment
docker compose down
```

## CI와 이미지 발행

| 대상 | 검사 및 결과 |
| --- | --- |
| main 대상 PR | 필수 CI는 병합 예정 코드의 JUnit, HTTP 응답, 발행 정책, 임시 레지스트리 발행·재시도·digest를 검사합니다. |
| 같은 저장소의 일반 앱 PR | 별도 워크플로가 PR의 최신 커밋을 빌드합니다. 보호된 main과 빌드 정의가 일치하면 `ghcr.io/asbg-preview/preview:pr-<번호>-<전체 SHA>`를 발행하고 검증 기록에 서명한 뒤 `preview` 라벨을 붙입니다. |
| main에 push | 필수 CI를 통과한 이미지 파일을 `ghcr.io/asbg-preview/preview:sha-<전체 main SHA>`로 발행합니다. |

발행 정책을 수정할 때는 Python 3.12 가상환경에서 `pip install -r requirements-dev.txt`, `pytest -q`, `ruff check .`, `ruff format --check .`를 실행합니다.

## 배포 입력

보호된 main에서 열린 PR의 번호와 전체 head SHA를 전달합니다. Python 3, GitHub CLI(`gh attestation verify` 지원), Skopeo와 GitHub·GHCR 읽기 권한이 필요합니다.

```sh
python -m scripts.preview_publish resolve ASBG-PReview/PReview "$PR_NUMBER" "$HEAD_SHA"
```

성공 시 출력된 `ghcr.io/asbg-preview/preview@sha256:…`를 Pod 이미지로 사용합니다. 라벨은 배포 후보를 표시합니다. 새 SHA의 검증이 끝날 때까지 기존 환경을 유지하고 PR이 닫히면 해당 환경을 삭제합니다. 팀 차트와 ApplicationSet의 digest 연동은 별도 작업입니다.

## 팀 PR 규칙

최신 main에서 작업별 `feat/…`, `fix/…`, `chore/…` 브랜치를 만들고 한 PR에 한 목적을 담습니다. 작업 중에는 Draft로 공유합니다. `CI required` 통과, 리뷰 대화 해결, 작성자 외 팀원 1명 승인 후 작성자가 squash 머지합니다. 커밋이 추가되면 재승인이 필요합니다.

main 직접 push·force push·삭제는 금지합니다. 관리자 예외는 승인 1건에만 적용되며 사용 시 PR에 이유를 기록합니다. 인증정보와 `.env`는 커밋하지 않습니다. [팀 저장소 규칙](https://github.com/ASBG-PReview/PReview/rules)
