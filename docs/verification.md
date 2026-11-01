# 초기 검증 기록

2026-11-01 기준 GitHub/Docker 기반 구성을 검증합니다.

- Python 테스트: 로컬 CPython 3.12에서 8개 통과.
- 이미지 발행 정책: Node 테스트 4개 통과(라벨 길이 제한 회귀 테스트 포함).
- Ruff lint/format: 통과.
- actionlint: 3개 workflow 문법 검사 통과.
- Helm lint 및 PR 12/15 manifest 격리 검사: 통과.
- Docker Compose 구성 검사: 통과.

실제 Docker 실행 결과와 GHCR 이미지 발행 결과는 이 문서의 PR에 연결된 CI 및 Publish preview 실행을 근거로 확인합니다.
초기 발행 실행에서 Docker/GHCR push는 성공했으나 라벨 길이가 GitHub의 50자 제한을 넘었습니다. SHA 라벨 접두사를 `sha-`로 줄여 전체 SHA를 유지한 44자 라벨로 수정했습니다.
로컬 Docker Engine은 초기 점검 당시 꺼져 있었으므로 실제 컨테이너 검증은 GitHub hosted runner에서 수행합니다.

AWS ECR/EKS, Ingress, DNS와 PR Open→Update→Close 클러스터 Lifecycle은 아직 검증 대상입니다. `preview-ready` 라벨만으로 클러스터 배포 완료를 판단하지 않습니다.
