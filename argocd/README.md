# ApplicationSet 설정

`applicationset.yaml`은 이 저장소의 `preview-state` 브랜치에서 `previews/pr-*/state.json`을 읽어 PR별 Application을 생성합니다. 상태 파일은 반드시 검증된 작성자만 생성해야 하며, 파일이 남아 있는 동안에는 최신 PR 빌드가 실패해도 마지막 배포를 유지합니다. ApplicationSet 자체는 PR 상태·라벨·서명을 확인하지 않습니다. 작성·삭제 워크플로와 운영 전제는 `docs/github-actions-preview-report.md`에 정리했습니다.

## 적용 전 준비

1. 이 차트와 ApplicationSet 변경을 검토해 `main`에 반영합니다. ApplicationSet은 로컬 파일이 아니라 GitHub의 `main` 차트를 사용합니다.
2. `preview-state` 브랜치에 신뢰된 자동화만 쓰도록 권한을 설정합니다. 이 브랜치에 쓰기 권한이 있는 사용자는 배포 이미지를 바꿀 수 있으므로 보호가 필수입니다. 저장소가 비공개라면 Argo CD에 Git 읽기 인증을 설정합니다.
3. 운영진이 생성한 팀 Namespace를 확인하고 `applicationset.yaml`의 `replace-with-team-namespace`를 해당 이름으로 바꿉니다. 로컬 시험에서도 전용 테스트 Namespace를 미리 생성합니다. 해당 Namespace에 GHCR 읽기용 `ghcr-pull` Secret을 한 번 준비합니다. 이 차트는 Secret을 생성하지 않습니다.
4. AppProject와 Argo CD가 팀 Namespace에 리소스를 관리할 권한이 있는지, ApplicationSet 컨트롤러가 Application 삭제를 허용하는지 확인합니다. Namespace 생성·삭제 권한은 필요하지 않습니다. 같은 Namespace에 서로 다른 PR의 릴리스 이름을 사용합니다.
5. GitHub Actions의 검증된 상태 파일 갱신·종료 정리 작업을 GitHub에서 테스트합니다. 파일이 없으면 Application은 생성되지 않습니다.

준비 후 현재 클러스터를 확인하고 적용합니다.

```sh
kubectl config current-context
kubectl apply -f argocd/applicationset.yaml
kubectl get applicationsets -n argocd
kubectl get applications -n argocd
```

상태 파일 변경은 Git generator가 주기적으로 조회합니다. 기본 설정은 60초지만 repo-server 캐시 등으로 더 늦게 반영될 수 있습니다. Application 삭제 시 `preserveResourcesOnDeletion: false`를 통해 해당 Application의 리소스가 삭제됩니다. 팀 Namespace와 별도로 만든 `ghcr-pull` Secret은 차트가 관리하지 않으며 유지되어야 합니다. GHCR 이미지 삭제도 별도입니다. 공유 Namespace에서의 실제 삭제와 다른 PR 보존은 클러스터에서 검증해야 합니다.

## 기존 PR별 Namespace에서 이전할 때

기존 배포의 차트가 Namespace를 관리했고 자동 prune도 켜져 있습니다. 기존 Application이 새 차트를 동기화하면 기존 Namespace와 그 안의 Secret·리소스가 삭제될 수 있습니다. 기존 환경과 인증 정보를 먼저 확인하고 안전한 이전 계획을 마련하기 전에는 변경된 차트를 main에 머지하거나 기존 ApplicationSet에 적용하지 마세요. Namespace 삭제와 공유 Namespace에서의 리소스 보존은 실제로 검증되지 않았습니다.

자동화가 준비되기 전 임의의 digest로 상태 파일을 작성해 실제 배포하지 마세요. ApplicationSet에는 Git 상태 파일의 서명 검증 기능이 없습니다.
