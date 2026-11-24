#!/usr/bin/env bash
# Render both GitOps controllers for the same registered EKS destination.
set -euo pipefail
: "${EKS_SERVER:?Set EKS_SERVER to the EKS server registered in Argo CD}"
if [[ ! "$EKS_SERVER" =~ ^https://([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(:[0-9]+)?(/[^?#[:space:]]*)?$ ||
      "${EKS_SERVER,,}" =~ ^https://kubernetes\.default\.svc(\.cluster\.local)?\.?(:[0-9]+)?(/|$) ]]; then
  echo "Expected the registered remote EKS HTTPS endpoint." >&2
  exit 1
fi
export EKS_SERVER
base="$(dirname "$0")"
yq eval '
  .spec.destination.server = strenv(EKS_SERVER)
' "$base/main-application.yaml"
printf '%s\n' '---'
yq eval '
  .spec.template.spec.destination.server = strenv(EKS_SERVER)
' "$base/applicationset.yaml"
