# ApplicationSet 설정

## Minikube의 Argo CD에서 팀 EKS에 배포

Argo CD는 로컬 minikube에서 실행하고, 등록된 EKS를 배포 대상으로 사용합니다. 이 차트가 main에 반영되고 PR 이미지가 BASE_PATH를 지원하는지 확인한 뒤 기존 관리자와 전환 순서를 협의하세요. ApplicationSet YAML은 실제 EKS 주소를 인자로 받아 검토용으로 생성합니다.

```bash
EKS_SERVER='https://등록된-EKS-서버' bash argocd/render-eks.sh > applicationset-eks.yaml
```

각 PR의 경로와 health check는 `/container-2/pr-<번호>` 및 `/container-2/pr-<번호>/health`입니다. ALB는 경로를 그대로 전달하며 앱의 BASE_PATH, probe와 일치해야 합니다. 같은 `sbg-demo` ALB 그룹을 사용합니다.

`applicationset.yaml`은 이 저장소의 `preview-state` 브랜치에서 `previews/pr-*/state.json`을 읽어 PR별 Application을 생성합니다. 상태 파일은 반드시 검증된 작성자만 생성해야 하며, 파일이 남아 있는 동안에는 최신 PR 빌드가 실패해도 마지막 배포를 유지합니다. ApplicationSet 자체는 PR 상태·라벨·서명을 확인하지 않습니다. 작성·삭제 워크플로와 운영 전제는 `docs/github-actions-preview-report.md`에 정리했습니다.

## 적용 전 준비

1. 이 차트와 ApplicationSet 변경을 검토해 `main`에 반영합니다. ApplicationSet은 로컬 파일이 아니라 GitHub의 `main` 차트를 사용합니다.
2. `preview-state` 브랜치에 신뢰된 자동화만 쓰도록 권한을 설정합니다. 이 브랜치에 쓰기 권한이 있는 사용자는 배포 이미지를 바꿀 수 있으므로 보호가 필수입니다. 저장소가 비공개라면 Argo CD에 Git 읽기 인증을 설정합니다.
3. 로컬 minikube에 Argo CD와 ApplicationSet 컨트롤러를 준비하고, EKS 접속 정보와 `container-2` 관리 권한을 등록합니다. 운영진 권한 제한으로 EKS 내부 Argo CD 설치를 가정하지 않습니다.
4. EKS의 `container-2`에 `ghcr-pull` Secret이 있는지, AppProject와 컨트롤러에 필요한 배포·정리 권한이 있는지 확인합니다. 토큰 값은 저장소에 기록하지 않습니다.
5. 기존 배포를 관리하는 Argo CD를 확인하고 다른 컨트롤러가 동시에 관리하지 않도록 전환 순서를 협의합니다. PR 수, 기존 이미지의 BASE_PATH 지원 및 실제 quota도 확인합니다.

준비 후 렌더링 결과와 대상 클러스터를 검토한 다음 담당자가 minikube에 적용합니다. main Application도 로컬 Argo CD에 맞는 EKS destination으로 별도 준비해야 합니다.

상태 파일 변경은 Git generator가 주기적으로 조회합니다. 기본 설정은 60초지만 repo-server 캐시 등으로 더 늦게 반영될 수 있습니다. Application 삭제 시 `preserveResourcesOnDeletion: false`를 통해 해당 Application의 리소스가 삭제됩니다. 팀 Namespace와 별도로 만든 `ghcr-pull` Secret은 유지합니다. 실제 리소스 회수와 다른 PR 보존은 클러스터에서 검증합니다.

### PR 종료 시 GHCR 이미지 정리

main 대상 PR을 닫거나 병합하면 GitHub Actions의 `Clean images exclusive to the closed PR` 작업이 실행됩니다. PR이 여전히 닫혀 있고 배포 상태 파일이 사라졌는지 확인한 뒤, GHCR의 모든 버전을 조회합니다. 태그가 전부 해당 PR의 `pr-번호-전체SHA` 형식인 버전만 정리하므로 이전 커밋의 이미지도 포함됩니다. main·다른 PR·사용자 태그와 공유하는 버전, 태그 없는 버전, 다른 배포 상태나 보존 대상 이미지 인덱스가 참조하는 digest는 유지합니다. 이 작업과 팀의 main·PR 발행 작업은 같은 실행 대기열을 사용합니다.

운영 전제는 팀 GHCR 패키지가 저장소에 연결되어 있고 해당 저장소의 Actions에 패키지 **Admin** 권한이 있다는 것입니다. 권한 거부 시 정리 작업이 실패로 표시됩니다. [GitHub Packages의 Actions 삭제 권한](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package)

기존에 닫힌 PR이나 실패한 정리는 Actions → **Reconcile verified preview state** → **Run workflow**에서 main과 `cleanup_pr` 번호를 선택해 다시 검사할 수 있습니다. 수동 실행은 기본적으로 삭제 예정 버전만 출력합니다. 로그 확인 후 같은 번호로 `dry_run`을 해제하면 실제 정리합니다. 자동 종료 이벤트는 해당 PR 한 건만 처리합니다.

## 기존 PR별 Namespace에서 이전할 때

기존 배포의 차트가 Namespace를 관리했고 자동 prune도 켜져 있습니다. 기존 Application이 새 차트를 동기화하면 기존 Namespace와 그 안의 Secret·리소스가 삭제될 수 있습니다. 기존 환경과 인증 정보를 먼저 확인하고 안전한 이전 계획을 마련하기 전에는 변경된 차트를 main에 머지하거나 기존 ApplicationSet에 적용하지 마세요. Namespace 삭제와 공유 Namespace에서의 리소스 보존은 실제로 검증되지 않았습니다.

자동화가 준비되기 전 임의의 digest로 상태 파일을 작성해 실제 배포하지 마세요. ApplicationSet에는 Git 상태 파일의 서명 검증 기능이 없습니다.

## main과 PR의 통합 배포

main은 `argocd/main-application.yaml`의 `preview-main` Application으로 관리합니다.
`main` push의 필수 CI가 성공하면 테스트한 amd64 이미지를 `sha-<전체 SHA>`로 GHCR에 발행합니다.
발행 digest와 플랫폼을 확인한 뒤 `scripts/promote-main.mjs`가 `main-deploy` 브랜치를 갱신합니다.
이 브랜치의 트리는 테스트한 main 커밋의 전체 소스에 `charts/preview-api/values-main-image.json`을 추가한 것입니다.
따라서 main Application은 최신 main 차트를 무조건 가져오는 대신 **발행 이미지와 함께 검증한 차트**를 읽습니다.
PR ApplicationSet은 기존대로 `main` 차트와 `preview-state`의 digest를 사용합니다.
`main-deploy`와 `preview-state`에는 신뢰된 자동화와 승인된 복구 담당자만 쓸 수 있도록 저장소 규칙을 설정합니다.
main 발행 job에는 이 상태 기록을 위해 `contents: write`가 필요합니다.

main은 `deploymentMode: main`과 `main.commitSha`를 사용하며 digest·전체 SHA를 필수로 검사합니다.
PR 모드의 양의 정수 PR 번호·SHA·digest 검사는 유지합니다. main에서 local 모드를 켜도 검증을 우회할 수 없습니다.
리소스 이름은 main의 경우 `preview-main-preview-api`, PR의 경우 `preview-pr-<번호>-preview-api`입니다.
Service는 ClusterIP이며 selector는 Helm release마다 다릅니다. 차트는 Namespace와 Secret을 생성·삭제하지 않습니다.

EKS에서는 `values-eks.yaml`을 함께 사용합니다. main은 추가로 `values-main.yaml`을 읽어 replica 2개를 요청합니다.
공통 EKS 리소스는 Pod당 requests 50m/128Mi, limits 200m/320Mi입니다.
main 2개 + PR 2개는 requests 200m/512Mi, limits 800m/1280Mi이며 실제 quota와 다른 사용량을 적용 직전에 확인해야 합니다.
quota와 LimitRange는 변경하지 않습니다. `maxSurge: 0`, `maxUnavailable: 1`로 갱신하며 replica 1개인 PR은 잠시 중단될 수 있습니다.
로컬 기본 values의 기존 256Mi limit는 유지합니다.

앱의 `BASE_PATH`와 세 probe, Ingress Prefix, ALB healthcheck-path는 동일한 경로에서 생성됩니다.
main은 `/container-2/main`, PR은 `/container-2/pr-<번호>`를 사용합니다.
EKS Ingress는 `alb`, `sbg-demo`, `internet-facing`, `ip`를 사용하며 지정된 네 가지 ALB annotation만 허용합니다.
EKS host를 거부하고 TLS/defaultBackend/externalIPs는 렌더링하지 않습니다.
BASE_PATH가 없으면 기존 루트 `/health`, `/environment`, `/version`이 동작합니다. 로컬 nginx Ingress도 유지합니다.
워크북 제출에는 예시 `/container-N/` 대신 `/container-2/main`을 사용한다고 명시합니다.

### 적용 순서와 실패 대응

1. 이 변경을 리뷰 후 main에 병합하고 CI의 이미지 발행·`main-deploy` 기록 성공을 확인합니다. 로컬 복사본 수정만으로 원격 차트는 바뀌지 않습니다.
2. 기존 PR 17·18 이미지는 BASE_PATH 지원이 없을 수 있습니다. 새 코드로 재빌드·검증된 PR digest가 상태에 기록되기 전에 경로가 바뀐 차트를 동기화하지 마세요. 기존 PR 컨트롤러의 자동 동기화를 먼저 중지하고 차트 변경과 새 PR 이미지를 함께 전환합니다.
3. 기존 Argo CD 관리 주체를 확인하고 선택한 로컬 Argo CD로 관리권을 이관합니다. 기존 컨트롤러의 동기화·삭제를 중지한 뒤 새 컨트롤러가 리소스를 인계하도록 운영진과 전환합니다. Application을 finalizer가 있는 상태로 삭제해 리소스를 정리하지 마세요. EKS controller ServiceAccount와 AppProject가 container-2의 필요한 리소스를 관리할 수 있어야 합니다. 상세 권한과 최신 점검은 아래에 기록했습니다.
4. 현재 PR 수·quota·Secret 및 공용 ALB 정책을 다시 확인한 뒤 로컬 minikube의 `argocd`에 EKS를 대상으로 하는 main Application과 PR ApplicationSet을 적용합니다. `ghcr-pull`은 유지합니다. 이전 점검에서는 익명 GHCR 조회가 unauthorized였으므로 패키지 공개가 확인되기 전에는 Secret을 제거하지 않습니다.
5. main Pod Ready, ALB target health와 `/container-2/main/health`, `/environment`, `/version`을 검증합니다. Pod의 spec 이미지 digest와 상태 파일, `/environment`의 SHA, `/version`의 앱 버전을 각각 대조합니다.
6. PR 두 개의 새 커밋·빌드 실패·종료를 시험하고 main·나머지 PR·Namespace·Secret이 유지되는지 확인합니다. PR 종료는 Deployment·Service·Ingress만 해당 Application과 함께 정리해야 합니다.

빌드·테스트·이미지 발행·상태 기록 실패 시 `main-deploy` ref를 이동하지 않아 기존 배포가 유지됩니다.
오래된 main 작업과 동시 상태 갱신 충돌은 실패 처리하며 강제로 덮어쓰지 않습니다.
상태 갱신 후 실제 rollout 실패를 자동으로 되돌리는 기능은 없습니다. replica 2개에서 readiness 실패 시 정상 replica가 남을 수 있지만 무중단을 보장하지는 않습니다.
복구 담당자는 신규 배포를 중지하고 `main-deploy`의 마지막 정상 **트리**를 복원하는 새 커밋을 기록해 Argo CD가 이전 차트·digest를 동기화하게 합니다.
자동 동기화 중 `kubectl rollout undo`만 하면 Git 상태에 의해 다시 덮어써질 수 있습니다.
첫 배포에 이전 정상 버전이 없다면 수정된 main을 재검증·발행해야 합니다.
로컬 minikube가 중지되면 기존 EKS 앱 Pod는 유지되지만 Argo CD의 동기화·PR 정리는 중단됩니다.

## 운영 권한

Argo CD가 실행되는 로컬 minikube에서 EKS에 연결할 수 있어야 하며, 등록한 EKS 자격증명은 `container-2`의 Deployment·Service·Ingress 관리와 필요한 상태 조회 권한을 가져야 합니다. 기존 관리 주체와 finalizer를 확인하고 관리권을 넘겨받으세요. 실제 권한과 ALB 정책은 운영진과 검증합니다.
