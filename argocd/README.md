# ApplicationSet 설정

`applicationset.yaml`은 이 저장소의 `preview-state` 브랜치에서 `previews/pr-*/state.json`을 읽어 PR별 Application을 생성합니다. 상태 파일은 반드시 검증된 작성자만 생성해야 하며, 파일이 남아 있는 동안에는 최신 PR 빌드가 실패해도 마지막 배포를 유지합니다. ApplicationSet 자체는 PR 상태·라벨·서명을 확인하지 않습니다. 작성·삭제 워크플로와 운영 전제는 `docs/github-actions-preview-report.md`에 정리했습니다.

## 적용 전 준비

1. 이 차트와 ApplicationSet 변경을 검토해 `main`에 반영합니다. ApplicationSet은 로컬 파일이 아니라 GitHub의 `main` 차트를 사용합니다.
2. `preview-state` 브랜치에 신뢰된 자동화만 쓰도록 권한을 설정합니다. 이 브랜치에 쓰기 권한이 있는 사용자는 배포 이미지를 바꿀 수 있으므로 보호가 필수입니다. 저장소가 비공개라면 Argo CD에 Git 읽기 인증을 설정합니다.
3. Argo CD와 ApplicationSet 컨트롤러는 **EKS 내부**에서 실행합니다. 기본 제어 Namespace는 `argocd`이며 운영진이 설치 위치·버전·권한을 확정하고 설치합니다. 애플리케이션 대상은 `server: https://kubernetes.default.svc`, Namespace는 `container-2`입니다. 같은 EKS이므로 외부 클러스터 이름 `container-2-eks` 등록이나 팀 kubeconfig 토큰 복사가 필요하지 않습니다. 제어 Namespace를 바꾸면 두 매니페스트의 `metadata.namespace`도 함께 변경합니다.
4. EKS Argo CD AppProject와 application-controller ServiceAccount가 `container-2`에서 차트 리소스를 관리할 수 있고, ApplicationSet 컨트롤러가 Application 삭제를 허용하는지 확인합니다. 기존 공유 Namespace에 PR마다 서로 다른 릴리스 이름을 사용합니다. EKS의 `container-2`에 발급된 `ghcr-pull` Secret이 있는지 확인하고, `gtmong0077` 계정의 `read:packages` 전용 자격증명을 발급일로부터 30일 만료 전에 갱신합니다. 발급일과 정확한 만료 시각은 발급 담당자에게 확인하며 자동 갱신은 구현되어 있지 않습니다.
5. EKS의 실제 ResourceQuota와 실행 중인 Pod를 확인합니다. 팀 앱 Pod는 실제 할당량 기준 **최대 4개**이며 메인 2개와 PR별 1개씩 최대 2개를 권장합니다. 이 구성에서 CPU와 메모리의 requests 및 limits도 할당량 안에 들어야 합니다. ApplicationSet은 상태 파일마다 Application을 생성하므로 처음 적용하기 전에 배포 대상 PR 수와 기존 상태 파일의 이미지가 EKS 노드 플랫폼(`linux/amd64`)용인지 확인합니다.

운영진이 EKS 설치·권한·관리권 이관을 완료하고, PR 수와 이미지 호환성·quota를 확인한 뒤 **EKS kubeconfig를 명시해** 적용합니다. 아래 명령은 현재 팀 자격증명으로는 권한 부족으로 실행할 수 없습니다.

```sh
kubectl --kubeconfig "$EKS_ARGO_KUBECONFIG" -n argocd apply -f argocd/main-application.yaml
kubectl --kubeconfig "$EKS_ARGO_KUBECONFIG" -n argocd apply -f argocd/applicationset.yaml
kubectl --kubeconfig "$EKS_ARGO_KUBECONFIG" -n argocd get applicationsets,applications
```

EKS의 `container-2`에서 PR 생성, 새 커밋 반영, PR 종료 후 해당 Deployment와 Service 삭제를 확인합니다.

상태 파일 변경은 Git generator가 주기적으로 조회합니다. 기본 설정은 60초지만 repo-server 캐시 등으로 더 늦게 반영될 수 있습니다. Application 삭제 시 `preserveResourcesOnDeletion: false`를 통해 해당 Application의 리소스가 삭제됩니다. 팀 Namespace와 별도로 만든 `ghcr-pull` Secret은 차트가 관리하지 않으며 유지되어야 합니다. GHCR 이미지 삭제도 별도입니다. 공유 Namespace에서의 실제 삭제와 다른 PR 보존은 클러스터에서 검증해야 합니다.

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
3. 기존 Argo CD 관리 주체를 확인하고 EKS 내부 Argo CD로 이관합니다. 기존 컨트롤러의 동기화·삭제를 중지한 뒤 새 컨트롤러가 리소스를 인계하도록 운영진과 전환합니다. Application을 finalizer가 있는 상태로 삭제해 리소스를 정리하지 마세요. EKS controller ServiceAccount와 AppProject가 container-2의 필요한 리소스를 관리할 수 있어야 합니다. 상세 권한과 최신 점검은 아래에 기록했습니다.
4. 현재 PR 수·quota·Secret 및 공용 ALB 정책을 다시 확인한 뒤 EKS의 `argocd`에 main Application과 PR ApplicationSet을 적용합니다. `ghcr-pull`은 유지합니다. 이전 점검에서는 익명 GHCR 조회가 unauthorized였으므로 패키지 공개가 확인되기 전에는 Secret을 제거하지 않습니다.
5. main Pod Ready, ALB target health와 `/container-2/main/health`, `/environment`, `/version`을 검증합니다. Pod의 spec 이미지 digest와 상태 파일, `/environment`의 SHA, `/version`의 앱 버전을 각각 대조합니다.
6. PR 두 개의 새 커밋·빌드 실패·종료를 시험하고 main·나머지 PR·Namespace·Secret이 유지되는지 확인합니다. PR 종료는 Deployment·Service·Ingress만 해당 Application과 함께 정리해야 합니다.

빌드·테스트·이미지 발행·상태 기록 실패 시 `main-deploy` ref를 이동하지 않아 기존 배포가 유지됩니다.
오래된 main 작업과 동시 상태 갱신 충돌은 실패 처리하며 강제로 덮어쓰지 않습니다.
상태 갱신 후 실제 rollout 실패를 자동으로 되돌리는 기능은 없습니다. replica 2개에서 readiness 실패 시 정상 replica가 남을 수 있지만 무중단을 보장하지는 않습니다.
복구 담당자는 신규 배포를 중지하고 `main-deploy`의 마지막 정상 **트리**를 복원하는 새 커밋을 기록해 Argo CD가 이전 차트·digest를 동기화하게 합니다.
자동 동기화 중 `kubectl rollout undo`만 하면 Git 상태에 의해 다시 덮어써질 수 있습니다.
첫 배포에 이전 정상 버전이 없다면 수정된 main을 재검증·발행해야 합니다.
EKS 내부 Argo CD로 관리권 이전이 완료되면 로컬 Minikube 실행 여부와 관계없이 동기화·PR 정리를 수행합니다. EKS Argo CD가 중지되면 기존 앱 Pod는 유지되지만 동기화·정리는 중단됩니다. 현재는 설정 변경만 완료했으며 EKS 설치·이관 완료를 확인하지 못했습니다.


## EKS 내부 Argo CD 설치와 권한 요청

Argo CD 제어 Pod는 앱의 4개 한도와 별도의 운영진 관리 Namespace·리소스 예산에 배치해야 합니다.
`container-2`에 제어 Pod까지 넣으면 main 2개와 PR 2개 구성은 성립하지 않습니다.
이 저장소는 팀 quota·LimitRange를 수정하거나 공용 클러스터에 임의로 ClusterRoleBinding을 생성하지 않습니다.

운영진에게 다음을 요청합니다.

- EKS 내부 `argocd` 또는 지정 제어 Namespace에 Argo CD와 ApplicationSet 컨트롤러 설치 및 CRD 준비. 기존 설치가 있다면 소유자·버전·관리 Namespace를 확인합니다.
- application-controller ServiceAccount에 `container-2`의 Deployment·Service·Ingress 생성·조회·갱신·삭제 권한과 ReplicaSet·Pod·Endpoint·Event 등 동기화·상태 확인에 필요한 조회 권한을 부여합니다. 차트에 Namespace 생성·삭제 권한은 필요하지 않습니다. 실제 버전에 필요한 권한은 운영진이 검증합니다.
- AppProject에서 저장소 `https://github.com/ASBG-PReview/PReview.git`, 내부 서버 `https://kubernetes.default.svc`, 대상 Namespace `container-2` 및 차트 리소스를 허용합니다. 공용 default 프로젝트를 사용할 경우 기존 정책을 확인하며 다른 팀 정책을 덮어쓰지 않습니다.
- ApplicationSet 컨트롤러의 Application 생성·갱신·삭제와 finalizer 정리가 가능하도록 설정합니다. 팀에는 제어 Namespace의 두 Application 구성에 대한 적용·조회 권한을 부여하거나 운영진이 대신 적용합니다.
- 로컬 또는 다른 기존 Argo CD의 관리권 인계와 중지 순서를 확정합니다. 리소스 finalizer와 추적 방식도 함께 확인하여 두 컨트롤러의 동시 관리를 피합니다.

### 2026년 11월 21일 실제 점검

`team-deployer` 자격증명으로 EKS 연결은 성공했습니다.
`argocd` Deployment·StatefulSet 조회는 Forbidden이며, 해당 Namespace의 Deployment 생성 및 Application 생성, CRD 생성, `container-2` RoleBinding 생성 권한은 모두 없습니다.
API discovery에서는 Application 리소스 종류를 찾지 못했다는 경고가 나타났습니다. 이 결과만으로 다른 위치의 설치 여부를 단정하지 않고 운영진 확인이 필요합니다.

실행 중인 앱은 PR 17·18·26 각 1개로 총 3개입니다. quota 사용량은 requests 150m/384Mi, limits 600m/960Mi이며 메모리 limits 상한은 1280Mi입니다.
앱 1개분(320Mi)만 남아 있으므로 현재 상태에 main 2개를 추가하면 한도를 넘습니다.
main 2개를 운영하려면 PR 담당자가 배포 대상 PR을 최대 2개로 정리한 뒤 상태 파일·Application·실제 Pod를 함께 확인해야 합니다.
이번 변경에서는 기존 PR을 닫거나 리소스를 삭제하지 않았습니다.

ApplicationSet은 여전히 상태 파일마다 Application을 생성합니다. **최대 PR 2개를 자동 선택·제한하는 기능은 없습니다.**
따라서 PR 추가 전에는 담당자가 현재 활성 PR 수와 main replica·실제 자원 사용량을 확인해야 하며 quota에 걸려 Pending이 되는 것을 배포 완료로 간주하지 않습니다.
`ghcr-pull`은 기존 발급 Secret을 계속 참조하며 토큰 값은 저장소에 기록하지 않습니다.
