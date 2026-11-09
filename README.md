# PReview

PR별 미리보기 환경에 사용하는 Java 21 Spring Boot 서비스입니다. GitHub Actions가 Docker 빌드를 실행하고 Gradle이 실행 가능한 JAR를 만듭니다. Node.js 표준 라이브러리로 빌드 파일을 선택하고 이미지 발행·배포를 검증합니다.

## 로컬 실행

저장소 루트에서 실행합니다. `/health`의 정상 상태는 `ok`입니다. `/environment`는 `PR_NUMBER`, `COMMIT_SHA`, `NAMESPACE`를 반환하며 Compose 기본값은 모두 `local`입니다.

```sh
docker compose up --build --wait -d
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

같은 PR 커밋을 재빌드해 이미지 내용이 달라지면 보호된 워크플로가 같은 PR·SHA에 대해 미리 서명한 기존 digest만 재사용합니다. 기존 태그는 덮어쓰지 않습니다.

발행 정책을 수정할 때는 Node.js 22 이상에서 `node --test tests/preview-publish.test.mjs`를 실행합니다. 별도 패키지 설치는 필요 없습니다.

## 배포 입력

보호된 main에서 열린 PR의 번호와 전체 head SHA를 전달합니다. Node.js 22 이상, GitHub CLI(`gh attestation verify` 지원), Skopeo와 GitHub·GHCR 읽기 권한이 필요합니다.

```sh
node scripts/preview-publish.mjs resolve ASBG-PReview/PReview "$PR_NUMBER" "$HEAD_SHA"
```

성공 시 출력된 `ghcr.io/asbg-preview/preview@sha256:…`를 Pod 이미지로 사용합니다. 같은 SHA의 재발행이 끝나기 전이거나 실패했을 때도 이전 성공 기록의 서명과 현재 레지스트리 digest가 일치하면 그 이미지를 반환합니다. 기존 `preview` 라벨은 새 커밋에도 남을 수 있으므로 배포자는 최신 SHA로 `resolve`를 실행합니다. 팀 배포 컨트롤러는 조회 성공 시 차트에 digest를 전달하고, 검증 대기 중 기존 환경 유지와 PR 종료 시 삭제를 담당합니다.

## 팀 PR 규칙

최신 main에서 작업별 `feat/…`, `fix/…`, `chore/…` 브랜치를 만들고 한 PR에 한 목적을 담습니다. 작업 중에는 Draft로 공유합니다. `CI required` 통과, 리뷰 대화 해결, 작성자 외 팀원 1명 승인 후 작성자가 squash 머지합니다. 커밋이 추가되면 재승인이 필요합니다.

main 직접 push·force push·삭제는 금지합니다. 관리자 예외는 승인 1건에만 적용되며 사용 시 PR에 이유를 기록합니다. 인증정보와 `.env`는 커밋하지 않습니다. [팀 저장소 규칙](https://github.com/ASBG-PReview/PReview/rules)
