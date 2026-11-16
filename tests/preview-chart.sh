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
