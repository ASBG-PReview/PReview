#!/usr/bin/env bash
# Render the team's ApplicationSet for review. Run with Bash and mikefarah/yq v4.
set -euo pipefail
: "${EKS_SERVER:?Set EKS_SERVER to the EKS server registered in Argo CD}"
if [[ "$EKS_SERVER" != https://* || "$EKS_SERVER" == https://kubernetes.default.svc* ]]; then
  echo "Expected the registered remote EKS HTTPS endpoint." >&2
  exit 1
fi
export EKS_SERVER
dir="$(dirname "$0")"
case "${1:-pr}" in
  pr|both) ;;
  *) echo "Usage: render-eks.sh [pr|both]" >&2; exit 2 ;;
esac
yq eval '
  .spec.template.spec.destination = {"server": strenv(EKS_SERVER), "namespace": "container-2"}
' "$dir/applicationset.yaml"
if [[ "${1:-pr}" == both ]]; then
  printf '%s\n' '---'
  yq eval '.spec.destination = {"server": strenv(EKS_SERVER), "namespace": "container-2"}' "$dir/main-application.yaml"
fi
