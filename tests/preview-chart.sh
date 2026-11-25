#!/usr/bin/env bash
set -euo pipefail

chart=charts/preview-api
digest="sha256:$(printf '%064d' 1)"
sha=$(printf '%040d' 2)
export digest sha
values=(--set-string "image.digest=$digest"
        --set-string preview.prNumber=14
        --set-string "preview.commitSha=$sha")

helm lint "$chart" "${values[@]}"
render() {
  helm template preview-pr-14 "$chart" --show-only templates/deployment.yaml "${values[@]}" "$@"
}

render | yq -e '.spec.template.spec | has("imagePullSecrets") == false' >/dev/null
render --set-string 'imagePullSecrets[0].name=ghcr-pull' | yq -o=json '.spec.template.spec' | node -e '
  const assert = require("node:assert/strict");
  const pod = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const app = pod.containers[0];
  const env = Object.fromEntries(app.env.map(v => [v.name, v.value]));
  assert.deepEqual(pod.imagePullSecrets, [{name: "ghcr-pull"}]);
  assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault");
  assert.equal(app.image, "ghcr.io/asbg-preview/preview@" + process.env.digest);
  assert.equal(env.PR_NUMBER, "14");
  assert.equal(env.COMMIT_SHA, process.env.sha);
  for (const budget of [app.resources.requests, app.resources.limits]) {
    assert.ok(budget.cpu && budget.memory);
  }
'

for invalid in 'image.digest=' 'image.digest=latest' 'preview.prNumber=' \
               'preview.prNumber=0' 'preview.commitSha=' 'preview.commitSha=abc123'; do
  if render --set-string "$invalid" >/dev/null 2>&1; then
    echo "Chart accepted invalid input: $invalid" >&2
    exit 1
  fi
done

helm template preview-local "$chart" -f "$chart/values-local.yaml" >/dev/null
for switch in 'preview.local=false' 'ingress.enabled=false'; do
  if helm template preview-local "$chart" -f "$chart/values-local.yaml" --set-string "$switch" >/dev/null 2>&1; then
    echo "Chart accepted a string as a boolean: $switch" >&2; exit 1
  fi
done
# Helm removes explicit null values while merging, before it checks the schema.
for key in preview ingress preview.local ingress.enabled; do
  if error=$(helm template preview-local "$chart" -f "$chart/values-local.yaml" --set "$key=null" 2>&1); then
    echo "Chart accepted a missing setting: $key" >&2; exit 1
  fi
  if [[ "$error" != *schema* ]]; then echo "$error" >&2; exit 1; fi
done
make -n build load lint deploy test clean >/dev/null
python3 -B -O tests/local-preview.py
