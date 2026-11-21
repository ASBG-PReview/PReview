#!/usr/bin/env bash
# Render the team's ApplicationSet for review. Run with Bash and mikefarah/yq v4.
set -euo pipefail
: "${EKS_SERVER:?Set EKS_SERVER to the EKS server registered in Argo CD}"
: "${ALB_GROUP:?Set ALB_GROUP to the shared IngressGroup approved by the operator}"
if [[ "$EKS_SERVER" != https://* || "$EKS_SERVER" == https://kubernetes.default.svc* ]]; then
  echo "Expected the registered remote EKS HTTPS endpoint." >&2
  exit 1
fi
export EKS_SERVER ALB_GROUP
base="$(dirname "$0")/applicationset.yaml"
yq eval '
  .spec.template.spec.destination = {"server": strenv(EKS_SERVER), "namespace": "container-2"} |
  .spec.template.spec.source.helm.valuesObject.ingress = {
    "enabled": true,
    "perPR": true,
    "className": "alb",
    "annotations": {
      "alb.ingress.kubernetes.io/target-type": "ip",
      "alb.ingress.kubernetes.io/group.name": strenv(ALB_GROUP)
    }
  }
' "$base"
