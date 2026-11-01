# 검증 계획

## 자동 검사

- FastAPI health, local 기본값, 두 PR의 환경 정보, 화면 응답, 404.
- 발행 정책: 성공/실패, 오래된 SHA, closed/draft/fork, 중복 PR, 기존 라벨 보존.
- ECR 정리: 닫힌 PR만 선택, 잘못된 태그 무시, GitHub 오류 시 중단.
- Helm: 서로 다른 Namespace 렌더링, resource quota, probe, 읽기 전용 filesystem, NetworkPolicy.
- Docker: 이미지를 실제 실행하여 health, PR 번호, SHA, Namespace, 화면을 검사.
- main: 활성 Ruleset, 필수 체크, 승인 1명, 관리자 우회 없음.

## AWS 연결 후 필수 E2E

1. PR A/B를 열고 이미지 태그와 preview Namespace가 서로 다른지 확인합니다.
2. A만 수정하여 동일 URL의 `/version`이 새 SHA로 바뀌고 B는 유지되는지 검사합니다.
3. A에 실패하는 테스트를 올려 새 이미지/라벨이 발행되지 않고 이전 환경이 유지되는지 검사합니다.
4. A를 Close하여 Application/Namespace/Pod/Service/Ingress/ConfigMap이 사라지고 B는 남는지 확인합니다.
5. 매일 ECR 정리 또는 수동 workflow_dispatch로 A의 이미지 태그만 삭제되는지 확인합니다.
6. NetworkPolicy를 지원하는 CNI에서 A→B와 Pod→metadata 서비스 접근이 차단되는지 확인합니다.
7. 전체 과정을 세 번 반복하고 생성·갱신·삭제 소요 시간을 기록합니다.

ApplicationSet은 기본 60초 polling이므로 즉시 반응하지 않을 수 있습니다.
GitHub Actions 성공과 실제 클러스터 Healthy 상태는 각각 기록합니다.

| 시행 | Open→Healthy | Push→새 SHA | Close→Namespace 삭제 | 격리 | 잔여 리소스 |
|---|---|---|---|---|---|
| 1 | 미측정 | 미측정 | 미측정 | 미검증 | 미검증 |
| 2 | 미측정 | 미측정 | 미측정 | 미검증 | 미검증 |
| 3 | 미측정 | 미측정 | 미측정 | 미검증 | 미검증 |
