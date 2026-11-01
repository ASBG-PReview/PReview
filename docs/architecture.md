# 저장소와 배포 설계

## 결정: 지금은 모노레포

앱 하나를 대상으로 PR 생성→갱신→삭제를 검증하는 단계에서는 저장소 하나가 적합합니다.
앱·Dockerfile·Helm·CI의 의존 변경을 한 PR에서 리뷰하고 동일한 SHA로 추적할 수 있습니다.
여러 저장소를 도입하면 교차 저장소 토큰, 이벤트 전달, 버전 동기화부터 해결해야 합니다.

| 현재 경계 | 디렉터리 | 분리할 시점 |
|---|---|---|
| 테스트 대상 앱 | app | 독립된 앱 여러 개, 각기 다른 팀/배포 주기 |
| 공용 배포 정의 | helm, argocd | 운영 인프라에 별도 승인·권한이 필요할 때 |
| 클라우드 기반 | infra | 여러 프로젝트가 같은 플랫폼을 공유할 때 |

향후에는 `preview-platform`과 `demo-app` 두 저장소로 분리하면 충분합니다.
현재도 Argo CD는 **main의 Helm만** 읽으므로 PR 작성자가 배포 매니페스트를 바꿔 클러스터 권한을 얻는 경로를 줄입니다. Helm 변경 PR은 CI 렌더링 후 병합해야 실제 preview에 반영됩니다.

## 이벤트와 신뢰 경계

- CI: `pull_request`, read-only 토큰, GitHub hosted runner. 기본 checkout으로 merge 결과를 테스트하며 Docker는 정확한 PR head를 빌드·실행합니다.
- Publish: 성공한 `workflow_run`, 저장소·PR·SHA·작성자 권한을 다시 검증. main의 스크립트만 실행하고 빌드 산출물은 load/tag/push만 수행합니다.
- Fork/Dependabot: 테스트는 가능하지만 자동 발행 대상에서 제외됩니다.
- AWS: `preview-publish` Environment와 OIDC 사용. PR 코드에 AWS 자격증명을 전달하지 않습니다.
- GitOps: `preview-ready`로 최초 생성 여부를, `preview-sha-*`로 성공한 이미지 버전을 선택합니다.

`head_sha`를 그대로 ApplicationSet 이미지 태그로 쓰면 새 커밋이 올라온 순간 아직 없는 이미지로 전환됩니다. 이 구현은 마지막 성공한 SHA를 라벨에 저장하여 빌드 실패 시 기존 환경을 유지합니다. 발행 종료 직전 PR 상태와 head를 재확인해 오래된 실행이 최신 결과를 덮지 않게 합니다. PR 상태와 라벨 변경은 GitHub의 원자적 트랜잭션이 아니므로 아주 짧은 경합은 가능하나, 라벨은 항상 실제 발행된 이미지만 가리킵니다.

## 삭제와 격리

ApplicationSet이 닫힌 PR을 제외하면 Application finalizer가 리소스를 삭제합니다.
Namespace는 Helm이 명시적으로 관리하여 Namespace 자체도 삭제 대상에 들어갑니다.
공용 Ingress Load Balancer는 PR 종료 시 삭제하지 않습니다.
ECR 이미지는 별도 매일 정리 작업이 **종료가 확인된 PR의 태그만** 삭제합니다. 열린 PR의 오래된 이미지는 보존합니다.
GHCR은 초기 CI 증명용이며 버전 삭제 자동화는 포함하지 않습니다. 테스트 artifact 보관기간은 하루입니다.

Namespace, ResourceQuota, restricted Pod Security, non-root/read-only container, NetworkPolicy를 적용합니다.
NetworkPolicy는 지원 CNI와 정책 엔진이 실제 활성화되어야 작동합니다. EKS VPC CNI network policy 기능을 확인하세요.
이 구성은 적대적인 외부 코드를 안전하게 실행하는 다중 고객 SaaS 샌드박스를 의미하지 않습니다.

## 범위

데모 DB와 고객용 GitHub App 설치는 후속 기능입니다. EKS/VPC/Ingress를 자동 생성하지 않으며, 실제 AWS 배포와 도메인 검증은 인프라 연결 후 수행합니다.

## 근거

- 팀 요구사항: Notion의 ASBG 5조 / PReview 구현 계획(2026-11-01 확인). 공개 저장소에는 팀원 정보와 내부 문서 원문을 복사하지 않았습니다.
- [GitHub Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Actions 보안](https://docs.github.com/en/actions/reference/security/secure-use)
- [Argo CD PR Generator](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Generators-Pull-Request/)
