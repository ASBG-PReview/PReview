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

Java 21에서 컨테이너 없이 검증하려면 `preview-api`에서 `./gradlew verifyPreviewTests bootJar`를 실행합니다. 한국어 Windows의 한글 작업 경로에서 Gradle 8.14.3 테스트 실행기가 컴파일된 클래스를 찾지 못하면 영문 경로에서 다시 실행하거나 별도 PowerShell 창에서 `$env:JAVA_TOOL_OPTIONS='-Dfile.encoding=MS949'`를 설정한 뒤 `.\gradlew.bat verifyPreviewTests bootJar`를 실행합니다.

## EKS API 호출기

로컬 브라우저에서 main 또는 PR 배포의 `/health`, `/environment`, `/version` 응답을 확인할 수 있습니다. Python 3만 있으면 실행되며, EKS 고정 주소는 `/container-2`까지 입력합니다.

```sh
python3 tools/api-caller/server.py
```

브라우저에서 `http://127.0.0.1:8765`를 열고 main 체크박스 또는 PR 번호를 선택한 뒤 API 버튼을 누릅니다. 서버를 종료하려면 터미널에서 `Ctrl+C`를 누릅니다.

`PR 목록 및 이미지 새로고침`을 누르면 열려 있는 PR과 각 PR의 최신 커밋에 해당하는 GHCR 이미지 태그를 조회합니다. 목록에서 PR을 선택하면 번호가 입력됩니다. 조회에는 [GitHub CLI](https://cli.github.com/) 설치 및 `gh auth login`이 필요하며, 비공개 저장소와 패키지에는 각각 읽기 권한이 필요합니다. 이미지 존재는 EKS 배포 완료를 의미하지 않으며, 서명이나 이미지 신뢰성 검증도 수행하지 않습니다. 최신 이미지를 확인하지 못해도 PR 번호를 직접 입력해 API를 호출할 수 있습니다.

## CI와 이미지 발행

| 대상 | 검사 및 결과 |
| --- | --- |
| main 대상 PR | 필수 CI는 병합 예정 코드의 JUnit, HTTP 응답, 발행 정책, 임시 레지스트리 발행·재시도·digest를 검사합니다. |
| 같은 저장소의 일반 앱 PR | 별도 워크플로가 PR의 최신 커밋을 빌드합니다. 보호된 main과 빌드 정의가 일치하면 `ghcr.io/asbg-preview/preview:pr-<번호>-<전체 SHA>`를 발행하고 검증 기록에 서명한 뒤 `preview` 라벨을 붙입니다. |
| main에 push | 필수 CI를 통과한 이미지 파일을 `ghcr.io/asbg-preview/preview:sha-<전체 main SHA>`로 발행합니다. |

같은 PR 커밋을 재빌드해 이미지 내용이 달라지면 보호된 워크플로가 같은 PR·SHA에 대해 미리 서명한 기존 digest만 재사용합니다. 기존 태그는 덮어쓰지 않습니다.

발행 정책을 수정할 때는 Node.js 22 이상에서 `node --test tests/preview-publish.test.mjs`를 실행합니다. 별도 패키지 설치는 필요 없습니다.

## 배포 입력

PR별 ApplicationSet 구성과 적용 전 준비 사항은 [argocd/README.md](argocd/README.md), 상태 파일을 갱신하는 GitHub Actions의 동작과 운영 전제는 [작업 보고서](docs/github-actions-preview-report.md)를 참고합니다. 실제 GitHub와 클러스터에서의 통합 검증은 아직 필요합니다.

보호된 main에서 열린 PR의 번호와 전체 head SHA를 전달합니다. Node.js 22 이상, GitHub CLI(`gh attestation verify` 지원), Skopeo와 GitHub·GHCR 읽기 권한이 필요합니다.

```sh
node scripts/preview-publish.mjs resolve ASBG-PReview/PReview "$PR_NUMBER" "$HEAD_SHA"
```

성공 시 출력된 `ghcr.io/asbg-preview/preview@sha256:…`를 Pod 이미지로 사용합니다. 같은 SHA의 재발행이 끝나기 전이거나 실패했을 때도 이전 성공 기록의 서명과 현재 레지스트리 digest가 일치하면 그 이미지를 반환합니다. 기존 `preview` 라벨은 새 커밋에도 남을 수 있으므로 배포자는 최신 SHA로 `resolve`를 실행합니다. 팀 배포 컨트롤러는 조회 성공 시 차트에 digest를 전달하고, 검증 대기 중 기존 환경 유지와 PR 종료 시 삭제를 담당합니다.

## 팀 PR 규칙

최신 main에서 작업별 `feat/…`, `fix/…`, `chore/…` 브랜치를 만들고 한 PR에 한 목적을 담습니다. 작업 중에는 Draft로 공유합니다. `CI required` 통과, 리뷰 대화 해결, 작성자 외 팀원 1명 승인 후 작성자가 squash 머지합니다. 커밋이 추가되면 재승인이 필요합니다.

main 직접 push·force push·삭제는 금지합니다. 관리자 예외는 승인 1건에만 적용되며 사용 시 PR에 이유를 기록합니다. 인증정보와 `.env`는 커밋하지 않습니다. [팀 저장소 규칙](https://github.com/ASBG-PReview/PReview/rules)

## Helm 배포 및 버전 조회

차트는 `charts/preview-api`에 있습니다. `/version`은 빌드에 포함된 애플리케이션 버전을 반환합니다(예: `{"version":"0.0.1"}`). 버전 시연을 위한 PR에서는 `preview-api/src/main/version.txt`의 값을 변경합니다. CI는 실제 컨테이너 응답이 이 값과 일치하는지 확인합니다. `Chart.yaml`의 `version`은 차트 자체의 버전이고 `appVersion`은 차트가 설명하는 애플리케이션 버전입니다.

로컬 minikube를 시작한 뒤 저장소 루트에서 실행합니다. Docker, minikube, kubectl, Helm, GNU Make, Python 3와 curl이 필요합니다. 기본 프로필은 `minikube`입니다. 다른 프로필을 사용하면 모든 명령에 같은 `MINIKUBE_PROFILE`을 지정합니다.

```sh
make build
make lint
make deploy
make test
make clean
```

`make deploy`는 로컬 Docker 이미지 ID에서 `local-<64자리>` 태그를 만들고 선택한 프로필에 이미지를 로드합니다. 같은 `IMAGE_TAG`로 다시 빌드해도 내용이 달라지면 Pod 이미지가 바뀝니다. `make load`로 이미지 로드만 실행할 수도 있습니다. 배포는 `preview-local` 네임스페이스와 로컬 `quota.yaml`을 준비한 뒤 rollout 완료를 기다립니다. `make test`는 현재 Docker 이미지와 Deployment의 이미지가 일치하는지 확인하고 임시 포트 포워딩(기본 18080)으로 상태·환경·버전을 검증합니다. 배포와 테스트에는 동일한 식별자를 전달합니다(`make deploy PR_NUMBER=12 COMMIT_SHA=abc123`, `make test PR_NUMBER=12 COMMIT_SHA=abc123`). `make clean`은 해당 Helm 릴리스를 삭제합니다. 로컬 Ingress에는 minikube의 nginx ingress 애드온이 필요합니다.

아래 명령은 수동 EKS 배포에 사용할 PR 매니페스트를 렌더링합니다. Argo CD가 이미 관리하는 릴리스는 상태 파일로 갱신합니다. 해당 PR의 배포 입력에서 전체 head SHA와 이미지 digest를 읽어 `HEAD_SHA`와 `IMAGE_DIGEST`에 지정하고, 기록된 `chartRevision`을 체크아웃한 깨끗한 작업 트리에서 실행합니다. CI도 이 예제의 실제 인수로 렌더링해 Ingress부터 Service, Pod와 세 probe까지 같은 경로를 쓰는지 검사합니다.

```sh
PR_NUMBER=12
helm template "preview-pr-$PR_NUMBER" charts/preview-api \
  --namespace container-2 -f charts/preview-api/values-eks.yaml \
  --set-string preview.prNumber="$PR_NUMBER" \
  --set-string preview.commitSha="$HEAD_SHA" \
  --set-string image.digest="$IMAGE_DIGEST" \
  --set-string basePath="/container-2/pr-$PR_NUMBER"
```

`IMAGE_DIGEST`는 `resolve` 결과의 `sha256:…` 부분입니다. 독립 릴리스를 실제로 설치할 때는 대상 EKS 컨텍스트·기존 소유자·가용 quota를 확인하고 위 `helm template`을 `helm --kube-context "$EKS_CONTEXT" upgrade --install`로 바꿉니다. Ingress의 ALB 그룹은 `sbg-demo`이며 요청 경로는 Pod까지 그대로 전달됩니다. 세 API와 probe, ALB health check는 동일한 접두 경로를 사용합니다. EKS Pod당 요청량은 50m/128Mi, 상한은 200m/320Mi입니다. 로컬 예시 quota와 실제 EKS quota를 구분해 계산합니다.
