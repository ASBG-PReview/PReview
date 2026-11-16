# ApplicationSet 설정

`applicationset.yaml`은 이 저장소의 `preview-state` 브랜치에서 `previews/pr-*/state.json`을 읽어 PR별 Application을 생성합니다. 상태 파일은 반드시 검증된 작성자만 생성해야 하며, 파일이 남아 있는 동안에는 최신 PR 빌드가 실패해도 마지막 배포를 유지합니다. ApplicationSet 자체는 PR 상태·라벨·서명을 확인하지 않습니다. 작성·삭제 워크플로와 운영 전제는 `docs/github-actions-preview-report.md`에 정리했습니다.

## 적용 전 준비

1. 이 차트와 ApplicationSet 변경을 검토해 `main`에 반영합니다. ApplicationSet은 로컬 파일이 아니라 GitHub의 `main` 차트를 사용합니다.
2. `preview-state` 브랜치에 신뢰된 자동화만 쓰도록 권한을 설정합니다. 이 브랜치에 쓰기 권한이 있는 사용자는 배포 이미지를 바꿀 수 있으므로 보호가 필수입니다. 저장소가 비공개라면 Argo CD에 Git 읽기 인증을 설정합니다.
3. PR별 Namespace에 GHCR의 패키지 읽기용 `ghcr-pull` Secret을 제공하는 별도 자동화를 준비합니다. 이 차트는 Secret을 참조하지만 생성하지 않습니다. 공개 이미지라면 ApplicationSet에서 `imagePullSecrets[0].name` 파라미터를 제거할 수 있습니다.
4. AppProject와 Argo CD가 PR별 Namespace 생성·삭제 권한을 가지고 있는지, ApplicationSet 컨트롤러가 Application 삭제를 허용하는지 확인합니다. 기존 `preview-pr-<번호>` Namespace를 다른 목적으로 사용하지 마세요. 차트가 해당 Namespace를 관리하고 삭제합니다.
5. GitHub Actions의 검증된 상태 파일 갱신·종료 정리 작업을 GitHub에서 테스트합니다. 파일이 없으면 Application은 생성되지 않습니다.

준비 후 현재 클러스터를 확인하고 적용합니다.

```sh
kubectl config current-context
kubectl apply -f argocd/applicationset.yaml
kubectl get applicationsets -n argocd
kubectl get applications -n argocd
```

상태 파일 변경은 Git generator가 주기적으로 조회합니다. 기본 설정은 60초지만 repo-server 캐시 등으로 더 늦게 반영될 수 있습니다. Application 삭제 시 finalizer가 차트의 리소스를 삭제하도록 `preserveResourcesOnDeletion: false`를 설정했습니다. 차트가 명시적으로 관리하는 PR별 Namespace를 삭제할 때 그 안에 있는 Secret 등도 함께 삭제됩니다. GHCR 이미지는 별도입니다. 실제 삭제와 재시도는 클러스터에서 검증해야 합니다.

자동화가 준비되기 전 임의의 digest로 상태 파일을 작성해 실제 배포하지 마세요. ApplicationSet에는 Git 상태 파일의 서명 검증 기능이 없습니다. 현재 Minikube가 arm64라면 각 이미지가 arm64를 지원하는지도 배포 전에 확인해야 합니다.
