# 설치와 AWS 연결

## GitHub

GitHub Free Organization의 공개 저장소를 사용합니다. 표준 Linux hosted runner의 공개 저장소 Actions는 무료입니다. 유료 runner, Codespaces, AWS는 별도입니다.

main Ruleset 정의는 `.github/rulesets/main.json`입니다. JSON 파일을 저장하는 것만으로 적용되지 않으며 관리자가 API/UI로 활성화해야 합니다.

```sh
gh api --method POST repos/ASBG-PReview/PReview/rulesets --input .github/rulesets/main.json
```

같은 이름의 규칙이 있으면 해당 ID로 PUT하여 갱신합니다. 새 규칙을 중복 생성하지 마세요.
기본 Actions 토큰은 읽기 권한이고 워크플로 job에 필요한 권한만 명시합니다.
`preview-publish` Environment는 main 브랜치만 허용합니다.

## 로컬 개발

Docker Desktop의 Linux Engine을 시작한 후 `docker compose up --build -d`를 실행합니다.
`PR_NUMBER`, `COMMIT_SHA`, `POD_NAMESPACE`, `PREVIEW_COLOR=blue|red` 환경변수로 표시값을 바꿉니다.

```sh
python -m pip install -r requirements-dev.txt
python -m ruff check .
python -m ruff format --check .
python -m pytest -q
node --test scripts/preview.test.cjs
helm lint helm/preview-demo --namespace preview-pr-local --strict
helm template demo helm/preview-demo --namespace preview-pr-12
```

## AWS 사전 준비

1. ap-northeast-2에 테스트용 EKS와 ECR `preview-demo`를 준비합니다.
2. 노드/Pod가 ECR 이미지를 pull할 IAM 권한을 설정합니다. CI의 push 역할과 구분합니다.
3. GitHub OIDC Provider의 audience를 `sts.amazonaws.com`으로 등록합니다.
4. `infra/aws/oidc-trust-policy.example.json`의 ACCOUNT_ID를 실제 값으로 치환하여 역할 trust policy로 사용합니다.
5. `ecr-policy.example.json`을 같은 계정·리전·저장소에 맞춥니다. 이 역할에는 EKS admin 권한이 필요 없습니다.
6. ECR 태그는 immutable로 설정합니다. 재실행 시 동일 태그가 이미 존재하면 ECR push가 실패할 수 있으므로 새 커밋을 사용하거나 기존 이미지 확인 후 운영자가 처리합니다.
7. `infra/aws/ecr-lifecycle.json`을 적용하면 untagged 이미지만 1일 후 삭제됩니다. 태그가 붙은 열린 PR 이미지를 나이 기준으로 지우지 않습니다.

Repository Variables:

| 이름 | 값 |
|---|---|
| AWS_PREVIEW_ENABLED | 초기 false, 준비 후 true |
| AWS_REGION | ap-northeast-2 |
| AWS_ROLE_ARN | arn:aws:iam::<account>:role/<role> |
| ECR_REPOSITORY | <account>.dkr.ecr.ap-northeast-2.amazonaws.com/preview-demo |

장기 AWS Access Key를 GitHub Secrets에 저장하지 않습니다.
Environment의 배포 브랜치 제한을 main으로 유지해야 OIDC Environment subject를 다른 브랜치가 사용할 수 없습니다.

## Argo CD

클러스터에 지원 버전의 Argo CD/ApplicationSet controller를 설치하고, 관리자 권한으로 아래 두 리소스를 적용합니다.

```sh
kubectl apply -f argocd/project.yaml
kubectl apply -f argocd/applicationset.yaml
```

그 전에 다음을 설정하세요.

- ApplicationSet `image.repository`를 ECR 전체 URI로 변경합니다. chart `targetRevision: main`은 유지합니다.
- 공개 저장소 GitHub API rate limit이 부족하면 `tokenRef`를 추가하고 read-only Secret을 클러스터에 생성합니다. Secret 파일을 커밋하지 않습니다.
- 최초에는 Ingress 없이 `kubectl -n preview-pr-<N> port-forward svc/preview-demo 8000:80`로 검증합니다.
- 도메인과 공용 Ingress Controller가 준비되면 Helm parameters에 `ingress.enabled=true`, `ingress.className`, `ingress.host=pr-{{ .number }}.<도메인>`을 지정합니다.
- NetworkPolicy는 `preview-ingress=true` 라벨이 있는 Namespace의 ingress controller에서 오는 TCP 8000만 외부 ingress로 허용합니다. 관리자가 ingress controller Namespace에 이 라벨을 붙이세요. 이 정책은 ALB 직접 Pod 접근 구성과는 별도 조정이 필요합니다.
- TLS는 각 preview Namespace의 Secret 또는 합의된 인증서 자동화가 필요합니다. 기본 템플릿은 HTTP/port-forward 검증용입니다.

AppProject의 Namespace whitelist는 필요한 리소스로 제한되어 있지만 Namespace 이름 자체의 제한은 admission policy까지 별도 구성해야 강제할 수 있습니다. ApplicationSet 수정 권한은 관리자에게만 부여하세요.

## GHCR만 사용하는 경우

발행 패키지는 기본 비공개일 수 있습니다. 패키지를 공개하거나 각 preview Namespace에 pull Secret을 공급하고 `imagePullSecrets`를 지정해야 합니다. ECR을 쓰는 EKS 경로에는 GHCR 토큰이 필요 없습니다.

## 아직 연결되지 않은 것

실제 EKS, ECR, OIDC 역할, DNS, TLS와 팀원 권한은 저장소 생성만으로 준비되지 않습니다. AWS 계정과 클러스터 준비 후 이 절차에 따라 연결하고 Lifecycle 테스트를 수행해야 합니다.
