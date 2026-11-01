# 시연 절차

## GitHub와 Docker 기본 시연

1. 브랜치를 만들고 `app/static/index.html`의 소개 문구를 바꿔 PR을 엽니다.
2. CI의 Python, Helm, Docker 검증 성공을 확인합니다.
3. Publish preview 실행에서 GHCR 이미지 발행과 `preview-sha-*` 라벨을 확인합니다.
4. main은 승인 없이는 병합되지 않고 직접 push도 차단되는지 확인합니다.

## EKS 연결 후 시연

1. PR A 화면의 번호·SHA·Namespace를 보여줍니다.
2. PR B를 열어 서로 다른 환경을 나란히 보여줍니다.
3. A의 문구를 변경하고 push하여 A만 갱신되는지 확인합니다.
4. A를 종료하고 Namespace 삭제를 확인합니다.
5. B가 유지되는지 확인하고, 시연 종료 후 B도 닫습니다.

공용 EKS/Load Balancer는 PR 종료로 삭제되지 않습니다. 전체 프로젝트 종료 시 별도 인프라 정리가 필요합니다.
