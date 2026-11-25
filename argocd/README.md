# ApplicationSet 설정

## Argo CD 위치에 맞춰 팀 EKS를 지정

현재 배포의 Application과 ApplicationSet을 소유한 컨트롤러와 kubeconfig 컨텍스트를 먼저 확인합니다. 두 구성 모두 워크로드는 EKS의 `container-2`에 생성하며, 매니페스트는 Argo CD가 실행되는 클러스터의 `argocd`에 적용합니다.

| Argo CD가 실행되는 위치 | 렌더링 명령 | 두 매니페스트의 배포 대상 |
| --- | --- | --- |
| 워크로드와 같은 EKS | `bash argocd/render-eks.sh both --in-cluster` | `https://kubernetes.default.svc` |
| Minikube 등 별도 클러스터 | 아래 예제처럼 등록된 EKS 주소로 실행 | Argo CD에 등록한 EKS 서버 |

저장소 루트에서 승인 목록을 가져온 뒤 렌더링합니다. Node.js와 yq v4가 필요합니다.

```bash
set -e
PREVIEW_CHART_REVISIONS=$(gh variable get PREVIEW_CHART_REVISIONS --env preview-publish --repo ASBG-PReview/PReview)
export PREVIEW_CHART_REVISIONS
# 같은 EKS 내부에 설치한 경우
env -u EKS_SERVER bash argocd/render-eks.sh both --in-cluster > preview-in-cluster.yaml
# 별도 클러스터에서 운영하는 경우
EKS_SERVER='https://등록된-EKS-서버' bash argocd/render-eks.sh both > preview-remote.yaml
```

환경에 해당하는 파일 하나를 선택합니다. `both`는 main과 PR을 함께, `pr`은 PR ApplicationSet만 출력합니다. 모드를 생략한 기존 명령은 PR ApplicationSet 한 개를 출력합니다. 원본 ApplicationSet에는 감사 기준 차트 하나만 허용되어 있으므로 새 차트는 승인 목록으로 렌더링해 적용합니다.

각 PR의 경로와 health check는 `/container-2/pr-<번호>` 및 `/container-2/pr-<번호>/health`입니다. ALB는 경로를 그대로 전달하며 앱의 BASE_PATH, probe와 일치해야 합니다. 같은 `sbg-demo` ALB 그룹을 사용합니다.

`applicationset.yaml`은 `preview-state` 브랜치의 `deployments/pr-*/state.json`을 읽습니다. 각 파일은 PR 번호·head SHA·이미지 digest·차트를 읽을 전체 Git SHA(`chartRevision`)를 담습니다. 작성 워크플로가 이미지와 현재 PR을 검증하며, 최신 빌드가 실패하면 직전의 검증된 배포가 유지됩니다. 작성·삭제 조건은 [작업 보고서](../docs/github-actions-preview-report.md)에 정리했습니다.

## 적용 전 준비

1. 상태 작성용 GitHub App의 저장소 접근·Contents 쓰기와 `preview-publish` 환경의 기본 브랜치 제한을 준비합니다. 관리자 검증을 거친 규칙 리비전을 환경 변수 `PREVIEW_APPROVED_RULESETS`에 등록하고 `PREVIEW_WRITER_APP_ID`와 환경 시크릿 `PREVIEW_WRITER_PRIVATE_KEY`를 설정합니다. 자세한 권한은 [작업 보고서](../docs/github-actions-preview-report.md)에 정리했습니다. 저장소가 비공개라면 Argo CD에도 Git 읽기 인증이 필요합니다.
2. `preview-state`와 `main-deploy` 쓰기는 해당 작성자와 승인된 복구 경로로 제한합니다. 기존 ApplicationSet이 `main` 차트를 따라가는 동안에는 main에 반영한 차트가 즉시 기존 PR에 적용될 수 있습니다. 앞서 배포된 이미지와 새 차트의 경로를 검증하고 기존 관리 주체에서 필요한 자동 동기화 중지를 먼저 진행합니다.
3. 같은 EKS 내부에서는 Argo CD 서비스 계정과 AppProject의 `container-2` 권한을 확인합니다. 외부 Argo CD에서는 등록한 EKS 접속 정보와 이 자격증명의 권한을 확인합니다.
4. EKS의 `container-2`에 `ghcr-pull` Secret이 있는지, AppProject와 컨트롤러에 필요한 배포·정리 권한이 있는지 확인합니다. 토큰 값은 저장소에 기록하지 않습니다.
5. 기존 배포를 관리하는 Argo CD를 확인하고 다른 컨트롤러가 동시에 관리하지 않도록 전환 순서를 협의합니다. PR 수, 기존 이미지의 BASE_PATH 지원 및 실제 quota도 확인합니다.

### 기존 상태 파일을 새 ApplicationSet으로 이관

보호된 `preview-publish` 환경 변수 `PREVIEW_CHART_REVISIONS`에 승인한 기본 브랜치 커밋의 전체 SHA를 쉼표로 구분해 등록합니다. 첫 값은 새 이미지에 쓸 차트입니다. 작성기는 이 커밋이 기본 브랜치 이력에 있고 차트 디렉터리가 현재 검증한 내용과 일치하는지 확인합니다. 기존 이미지에는 기록된 차트를 유지합니다. 감사 기준 `55d093d`의 전체 SHA는 구형 배포 복원을 위해 항상 포함됩니다. 변수가 비어 있고 기본 브랜치의 차트가 감사 기준과 다르면 해당 신규 배정을 보류합니다.

운영 중인 차트를 올릴 때는 기존 SHA를 첫 번째에 두고 새 SHA를 목록에 추가합니다. 이 목록으로 ApplicationSet을 렌더링해 같은 이름의 객체에 적용합니다. 설치된 `spec.template.spec.source.targetRevision`에 두 SHA가 있는지 확인한 후 환경 변수 첫 값을 새 SHA로 바꿉니다. 이전 SHA를 제거하기 전에는 제거 예정 목록으로 아래 `--check-projection`을 실행합니다. 이 검사는 활성 배포와 보존 기간 안에 복원할 수 있는 기록을 함께 확인합니다.

1. 기존 ApplicationSet의 이름·UID, 각 Application의 대상·차트 revision·이미지 digest·정상 경로를 기록합니다. 기존 Git generator 경로를 유지한 채 기본 브랜치의 새 상태 작성기를 먼저 실행합니다. 작성기는 기존 `previews/`와 새 `deployments/`를 한 커밋에서 갱신합니다.
2. 기존 #36·#37의 확인된 SHA와 digest 조합은 `55d093d0e6cd705e216de4efd2b4a216e7330644` 차트로 이관됩니다. 다른 구형 상태에는 이 SHA를 임의로 넣지 않습니다. 현재 발행 증거와 PR head, prefix HTTP 검사가 포함된 빌드 정의의 일치 여부를 확인한 경우에만 새 조합을 기록합니다. 확인이 어려운 항목은 이전 상태에서 해결합니다. 같은 이미지 digest로도 차트가 다르면 probe 경로와 Pod 시작 결과가 달라질 수 있습니다.
3. GitHub 읽기 권한으로 `GH_TOKEN`을 설정하거나 `gh auth login` 후 기본 브랜치에서 다음을 실행합니다. 오류가 발생하면 경로·누락 상태·두 파일의 값을 바로잡고 다시 검사합니다. 각 PR의 실제 이미지·차트 쌍을 대상으로 prefix의 세 API, probe 및 ALB target health도 별도로 확인합니다.

   ```sh
   node scripts/reconcile-preview-state.mjs ASBG-PReview/PReview --check-projection
   ```

4. 검사 직후 2개 렌더링 문서의 EKS 목적지를 대조하고, 담당자가 Argo CD가 실행되는 클러스터의 컨텍스트에 같은 이름의 ApplicationSet을 `apply`합니다. 새로 생성하기 위해 기존 ApplicationSet을 삭제하면 finalizer가 관리 리소스까지 정리할 수 있습니다. 역전환은 기존 경로에 모든 유효 상태를 먼저 복원·대조하고, 이전 매니페스트가 실제 읽을 차트로 라우팅 검증을 마친 뒤 같은 객체를 갱신합니다.

상태 파일 변경은 Git generator가 주기적으로 조회합니다. 기본 설정은 60초지만 repo-server 캐시 등으로 더 늦게 반영될 수 있습니다. Application 삭제 시 `preserveResourcesOnDeletion: false`를 통해 해당 Application의 리소스가 삭제됩니다. 팀 Namespace와 별도로 만든 `ghcr-pull` Secret은 유지합니다. 실제 리소스 회수와 다른 PR 보존은 클러스터에서 검증합니다.

### PR 종료 시 GHCR 이미지 정리

main 대상 PR을 닫으면 상태 작성기가 배포 입력을 회수하고 Git에 정리 요청을 기록합니다. 종료와 상태 회수 중 더 늦은 시점을 기준으로 24시간 동안 이미지를 보존합니다. 실제 정리 전 PR·배포 입력·정리 요청을 다시 검사하며, 태그가 모두 해당 PR의 `pr-번호-전체SHA`인 버전만 후보입니다. 다른 태그와 공유하는 버전, 태그 없는 버전, 보존할 이미지 인덱스가 참조하는 digest의 판정 기준은 [작업 보고서](../docs/github-actions-preview-report.md)를 참조하세요. Argo CD가 오랫동안 오프라인이면 24시간이 지나도 클러스터 정리가 끝나지 않을 수 있으므로 재가동 후 실제 리소스를 확인합니다.

운영 전제는 팀 GHCR 패키지가 저장소에 연결되어 있고 해당 저장소의 Actions에 패키지 **Admin** 권한이 있다는 것입니다. 권한 거부 시 정리 작업이 실패로 표시됩니다. [GitHub Packages의 Actions 삭제 권한](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package)

기존에 닫힌 PR이나 실패한 정리는 Actions → **Reconcile verified preview state** → **Run workflow**에서 main과 `cleanup_pr` 번호를 선택해 다시 검사할 수 있습니다. 기본 `dry_run`은 읽기 전용입니다. 보존 기간을 지난 요청은 예약 실행이 재시도하며, 수동 실행에서 `dry_run`을 해제하면 상태 조정과 정리가 실행됩니다.

## 기존 PR별 Namespace에서 이전할 때

기존 배포의 차트가 Namespace를 관리했고 자동 prune도 켜져 있습니다. 기존 Application이 새 차트를 동기화하면 기존 Namespace와 그 안의 Secret·리소스가 삭제될 수 있습니다. 기존 환경과 인증 정보를 먼저 확인하고 안전한 이전 계획을 마련하기 전에는 변경된 차트를 main에 머지하거나 기존 ApplicationSet에 적용하지 마세요. Namespace 삭제와 공유 Namespace에서의 리소스 보존은 실제로 검증되지 않았습니다.

자동화가 준비되기 전 임의의 digest로 상태 파일을 작성해 실제 배포하지 마세요. ApplicationSet에는 Git 상태 파일의 서명 검증 기능이 없습니다.

## main과 PR의 통합 배포

main은 `argocd/main-application.yaml`의 `preview-main` Application으로 관리합니다.
`main` push의 필수 CI가 성공하면 테스트한 amd64 이미지를 `sha-<전체 SHA>`로 GHCR에 발행합니다.
발행 digest와 플랫폼을 확인한 뒤 `scripts/promote-main.mjs`가 `main-deploy` 브랜치를 갱신합니다.
이 브랜치의 트리는 테스트한 main 커밋의 전체 소스에 `charts/preview-api/values-main-image.json`을 추가한 것입니다.
따라서 main Application은 최신 main 차트를 무조건 가져오는 대신 **발행 이미지와 함께 검증한 차트**를 읽습니다.
PR ApplicationSet은 `preview-state`가 지정한 `chartRevision`과 digest를 한 쌍으로 사용합니다. 상태 작성기는 승인 목록의 첫 SHA와 기본 브랜치에서 검증한 차트 트리를 대조합니다. 동일 이미지 재조정 때는 기록된 차트 SHA를 보존합니다.
`main-deploy`와 `preview-state`에는 신뢰된 자동화와 승인된 복구 담당자만 쓸 수 있도록 저장소 규칙을 설정합니다.
main 발행 job의 상태 브랜치 쓰기에는 제한된 GitHub App 설치 토큰을 사용합니다.

main은 `deploymentMode: main`과 `main.commitSha`를 사용하며 digest·전체 SHA를 필수로 검사합니다.
PR 모드의 양의 정수 PR 번호·SHA·digest 검사는 유지합니다. main에서 local 모드를 켜도 검증을 우회할 수 없습니다.
리소스 이름은 main의 경우 `preview-main-preview-api`, PR의 경우 `preview-pr-<번호>-preview-api`입니다.
Service는 ClusterIP이며 selector는 Helm release마다 다릅니다. 차트는 Namespace와 Secret을 생성·삭제하지 않습니다.

EKS에서는 `values-eks.yaml`을 함께 사용합니다. main은 추가로 `values-main.yaml`을 읽어 replica 2개를 요청합니다.
공통 EKS 리소스는 Pod당 requests 50m/128Mi, limits 200m/320Mi입니다.
main 2개 + PR 2개는 requests 200m/512Mi, limits 800m/1280Mi이며 실제 quota와 다른 사용량을 적용 직전에 확인해야 합니다.
예를 들어 저장소의 로컬 `quota.yaml` 한도인 CPU limits 600m와 memory limits 1Gi를 그대로 적용한 환경에서는 main 2개에 PR 1개(600m/960Mi)까지만 들어갑니다. 다른 워크로드 사용량과 종료 중인 Pod를 포함해 계산한 뒤 `PREVIEW_MAX_SLOTS`를 설정합니다. 기본값은 2이며 0은 새 PR 배포를 보류합니다. 값을 낮춰도 기존 배포는 즉시 삭제되지 않습니다.
차트 기본값은 `rollingUpdate.maxSurge=0`, `rollingUpdate.maxUnavailable=1`입니다. 단일 replica PR 교체에는 중단 구간이 생길 수 있습니다. 추가 Pod를 수용할 여유가 있고 서비스 지속성이 필요한 경우 `maxSurge=1`, `maxUnavailable=0`을 사용합니다. Pod Ready와 ALB target의 Healthy 전환은 별개이므로 기존 target 해제 시점, 실제 HTTP 연속 응답도 확인합니다.
로컬 기본 values의 기존 256Mi limit는 유지합니다.

앱의 `BASE_PATH`, Spring 표준 `SERVER_SERVLET_CONTEXT_PATH`, 세 probe, Ingress Prefix, ALB healthcheck-path는 동일한 경로에서 생성됩니다.
main은 `/container-2/main`, PR은 `/container-2/pr-<번호>`를 사용합니다.
EKS Ingress는 `alb`, `sbg-demo`, `internet-facing`, `ip`를 사용하며 지정된 네 가지 ALB annotation만 허용합니다.
EKS host를 거부하고 TLS/defaultBackend/externalIPs는 렌더링하지 않습니다.
BASE_PATH가 없으면 기존 루트 `/health`, `/environment`, `/version`이 동작합니다. 로컬 nginx Ingress도 유지합니다.
워크북 제출에는 예시 `/container-N/` 대신 `/container-2/main`을 사용한다고 명시합니다.

### 적용 순서와 실패 대응

1. 이 변경을 리뷰 후 main에 병합하고 CI의 이미지 발행·`main-deploy` 기록 성공을 확인합니다. 로컬 복사본 수정만으로 원격 차트는 바뀌지 않습니다.
2. 과거 #17 소스에서 빌드한 JAR는 `BASE_PATH`만으로는 PR 접두 경로에 404를 반환합니다. 현재 차트의 `SERVER_SERVLET_CONTEXT_PATH`를 함께 주면 같은 JAR가 접두 경로의 `/health`, `/environment`, `/version`에 정상 응답합니다. 이미 고정된 과거 차트는 이 추가 설정을 받지 않으므로 전환할 각 실제 digest와 차트 조합을 확인하고 필요하면 새 이미지 발행·검증을 먼저 완료합니다.
3. 기존 Argo CD 관리 주체를 확인하고 컨트롤러 변경이 필요한 경우에만 선택한 Argo CD로 관리권을 이관합니다. 기존 컨트롤러의 동기화·삭제를 중지한 뒤 새 컨트롤러가 리소스를 인계하도록 운영진과 전환합니다. Application을 finalizer가 있는 상태로 삭제해 리소스를 정리하지 마세요. EKS controller ServiceAccount와 AppProject가 container-2의 필요한 리소스를 관리할 수 있어야 합니다. 상세 권한과 최신 점검은 아래에 기록했습니다.
4. 현재 PR 수·quota·Secret 및 공용 ALB 정책을 다시 확인한 뒤 컨트롤러가 실행되는 클러스터의 `argocd`에 EKS를 대상으로 하는 main Application과 PR ApplicationSet을 적용합니다. `ghcr-pull`은 유지합니다. 이전 점검에서는 익명 GHCR 조회가 unauthorized였으므로 패키지 공개가 확인되기 전에는 Secret을 제거하지 않습니다.
5. main Pod Ready, ALB target health와 `/container-2/main/health`, `/environment`, `/version`을 검증합니다. Pod의 spec 이미지 digest와 상태 파일, `/environment`의 SHA, `/version`의 앱 버전을 각각 대조합니다.
6. PR 두 개의 새 커밋·빌드 실패·종료를 시험하고 main·나머지 PR·Namespace·Secret이 유지되는지 확인합니다. PR 종료는 Deployment·Service·Ingress만 해당 Application과 함께 정리해야 합니다.

빌드·테스트·이미지 발행·상태 기록 실패 시 `main-deploy` ref를 이동하지 않아 기존 배포가 유지됩니다.
오래된 main 작업과 동시 상태 갱신 충돌은 실패 처리하며 강제로 덮어쓰지 않습니다.
상태 갱신 후 실제 rollout 실패를 자동으로 되돌리는 기능은 없습니다. replica 2개에서 readiness 실패 시 정상 replica가 남을 수 있지만 무중단을 보장하지는 않습니다.
복구 담당자는 `main-deploy`의 마지막 정상 **트리**를 복원하는 새 커밋을 기록해 Argo CD가 이전 차트·digest를 동기화하게 합니다. 이 복구 커밋이 선두에 있는 동안 자동 승격은 보류됩니다. 재개할 정확한 main SHA와 digest를 검토하고 현재 배포 트리를 유지하는 승인 커밋의 제목을 `main 배포 재개 <전체 SHA> <sha256:digest>`로 작성한 후 해당 발행 작업을 재실행합니다.
자동 동기화 중 `kubectl rollout undo`만 하면 Git 상태에 의해 다시 덮어써질 수 있습니다.
첫 배포에 이전 정상 버전이 없다면 수정된 main을 재검증·발행해야 합니다.
Argo CD 컨트롤러가 중지되면 기존 EKS 앱 Pod는 유지되지만 Argo CD의 동기화·PR 정리는 중단됩니다.

## 운영 권한

EKS 내부에서는 Argo CD 서비스 계정이, 별도 클러스터에서는 등록한 EKS 자격증명이 `container-2`의 Deployment·Service·Ingress 관리와 필요한 상태 조회 권한을 가져야 합니다. 기존 관리 주체와 finalizer를 확인하고 관리권을 넘겨받으세요. 실제 권한과 ALB 정책은 운영진과 검증합니다.
