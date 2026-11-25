#!/usr/bin/env bash
# Render reviewed manifests for the Argo CD instance that owns the workloads.
set -euo pipefail
mode=${1-pr}
if [[ "$mode" != both && "$mode" != pr ]] || (( $# > 2 )) || [[ $# == 2 && $2 != --in-cluster ]]; then
  echo 'Usage: render-eks.sh [both|pr] [--in-cluster]' >&2
  exit 2
fi
if [[ ${2-} == --in-cluster ]]; then
  if [[ -n ${EKS_SERVER:-} ]]; then echo 'Unset EKS_SERVER for in-cluster installation.' >&2; exit 2; fi
  EKS_SERVER=https://kubernetes.default.svc
else
  : "${EKS_SERVER:?Set EKS_SERVER to the EKS server registered in Argo CD}"
  if [[ ! "$EKS_SERVER" =~ ^https://([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(:[0-9]+)?(/[^?#[:space:]]*)?$ ||
        "${EKS_SERVER,,}" =~ ^https://kubernetes\.default\.svc(\.cluster\.local)?\.?(:[0-9]+)?(/|$) ]]; then
    echo "Expected the registered remote EKS HTTPS endpoint." >&2
    exit 1
  fi
fi
export EKS_SERVER
base="$(dirname "$0")"
CHART_TEMPLATE=$(node "$base/../scripts/preview-chart-policy.mjs")
export CHART_TEMPLATE
if [[ "$mode" == both ]]; then
  yq eval '.spec.destination.server = strenv(EKS_SERVER)' "$base/main-application.yaml"
  printf '%s\n' '---'
fi
yq eval '
  .spec.template.spec.destination.server = strenv(EKS_SERVER) |
  .spec.template.spec.source.targetRevision = strenv(CHART_TEMPLATE)
' "$base/applicationset.yaml"
