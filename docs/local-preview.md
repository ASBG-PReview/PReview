# 로컬 Argo CD 미리보기

## 배포 경로

현재 PR 이미지 빌드는 `ubuntu-24.04`에서 amd64로 수행됩니다.
Apple Silicon minikube의 arm64와는 호환되지 않아 동기화 스크립트가 배포 전에
차단합니다. 실제 배포에는 arm64에서 빌드·테스트·발행한 이미지 또는 호환되는
클러스터가 필요합니다. 이 연결 구현에서는 빌드 워크플로를 변경하지 않습니다.
Wrapper와 Docker Gradle은 8.14.3입니다.

Helm 차트는 이미 기본 브랜치에 있습니다. 스크립트는 로컬에서 실행하며
기본 브랜치의 차트를 읽도록 Application을 등록합니다.

## 실행

Mac에는 Node.js 22+, gh, skopeo, kubectl이 필요합니다.

```sh
brew install skopeo
gh auth refresh -h github.com -s read:packages
minikube start
node scripts/sync-local-previews.mjs ASBG-PReview/PReview --watch
```

스크립트가 30초마다 열린 PR과 `preview` 라벨을 확인하고, `Publisher.resolve`로
최신 SHA의 발행 성공·서명·digest를 검증합니다. 노드와 이미지 아키텍처가 같을
때만 Application을 생성합니다. Argo CD는 기본 브랜치의 특정 커밋에 있는
`charts/preview-api`를 읽고 검증한 이미지를 `helm.valuesObject`로 전달받습니다.
배포 values를 Git에 커밋하지는 않습니다. PR의 Helm 코드는 사용하지 않습니다.

namespace와 Application은 `preview-pr-<번호>`입니다. 한 클러스터에서 같은 PR 번호를
다른 저장소에 사용하지 않습니다. 기본 context는 minikube이며 변경하려면
`PREVIEW_KUBE_CONTEXT`를 지정합니다.

새 커밋 검증 대기 시 이전 배포를 유지합니다. PR 종료 또는 라벨 제거 시
Application과 관리 리소스를 삭제하지만 namespace와 Secret은 보존합니다.
GitHub 조회 실패 시 삭제하지 않습니다. `--watch`를 생략하면 단발 실행합니다.

## 인증

현재 로그인으로 Secret을 준비하려면 `node scripts/setup-preview-pull-secret.mjs 18`을
실행합니다. 토큰은 출력하거나 저장소 파일에 기록하지 않습니다. 현재 계정 토큰을
Secret에 저장하는 로컬 개발 편의 기능이므로 공유 환경에서는 패키지 읽기 전용
자격증명을 사용하세요. 아직 실행하지 않았다면 Secret도 생성되지 않은 상태입니다.

저장소는 공개이므로 Argo CD Git 인증은 불필요합니다. 비공개 저장소로 변경하면
Argo CD repository Secret 또는 UI에 별도 읽기 인증을 등록해야 합니다.
비공개 GHCR에는 패키지를 읽을 수 있는 계정과 `read:packages` 권한이 필요합니다.
로컬 Skopeo와 각 namespace의 `ghcr-pull` Secret 모두 인증해야 합니다.

토큰을 출력하지 않고 stdin으로 Skopeo에 전달합니다.

```sh
gh auth token | skopeo login ghcr.io --username "$(gh api user --jq .login)" --password-stdin
```

namespace Secret은 권한이 있는 Docker config를 사용해 만듭니다. README의
`GHCR_CONFIG` 예시를 참고하세요. Secret을 사용하도록 실행합니다.

```sh
PREVIEW_PULL_SECRET=ghcr-pull node scripts/sync-local-previews.mjs ASBG-PReview/PReview --watch
```

## 검증

```sh
kubectl --context=minikube -n argocd get applications
kubectl --context=minikube -n preview-pr-<번호> rollout status deployment/preview-pr-<번호>-preview-api --timeout=120s
kubectl --context=minikube -n preview-pr-<번호> port-forward service/preview-pr-<번호>-preview-api 18080:8080
```

다른 터미널에서:

```sh
curl --fail http://localhost:18080/health
curl --fail http://localhost:18080/environment
curl --fail http://localhost:18080/version
```

환경 응답이 PR 번호/전체 SHA/namespace와 같은지, Pod imageID가 발행된 digest와
같은지 확인합니다. Ctrl+C로 포트 연결과 동기화 스크립트를 종료할 수 있습니다.

```sh
node --test tests/preview-publish.test.mjs tests/local-previews.test.mjs
bash tests/preview-chart.sh
```
