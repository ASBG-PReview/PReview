#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -f "$tmp/appset.yaml" "$tmp/values.yaml"; rmdir "$tmp"' EXIT
EKS_SERVER=https://test.example.invalid ALB_GROUP=shared-test bash argocd/render-eks.sh > "$tmp/appset.yaml"
yq -e '.spec.template.spec.destination.namespace == "container-2" and .spec.template.spec.destination.server == "https://test.example.invalid"' "$tmp/appset.yaml" > /dev/null
yq '.spec.template.spec.source.helm.valuesObject' "$tmp/appset.yaml" > "$tmp/values.yaml"
for pr in 17 18; do
  helm template "preview-pr-$pr" charts/preview-api -n container-2 -f "$tmp/values.yaml" \
    --set-string "preview.prNumber=$pr" --set-string "preview.commitSha=$(printf '%040d' 1)" \
    --set-string "image.digest=sha256:$(printf '%064d' 1)" |
    yq -o=json -I=0 '.' - | PR_NUMBER=$pr node -e '
      const assert = require("node:assert/strict");
      const docs = require("node:fs").readFileSync(0, "utf8").trim().split(/\r?\n/).map(JSON.parse);
      const ingresses = docs.filter(d => d.kind === "Ingress");
      assert.equal(ingresses.length, 1);
      const ingress = ingresses[0], pr = process.env.PR_NUMBER;
      const path = "/container-2/pr-" + pr;
      const service = docs.find(d => d.kind === "Service");
      assert.equal(service.metadata.name, "preview-pr-" + pr + "-preview-api");
      assert.equal(ingress.metadata.name, service.metadata.name);
      const rule = ingress.spec.rules[0].http.paths[0];
      assert.equal(rule.backend.service.name, service.metadata.name);
      assert.equal(rule.backend.service.port.number, service.spec.ports[0].port);
      assert.equal(rule.path, path);
      assert.equal(rule.pathType, "Prefix");
      const a = ingress.metadata.annotations;
      assert.equal(a["alb.ingress.kubernetes.io/group.name"], "shared-test");
      assert.equal(a["alb.ingress.kubernetes.io/healthcheck-path"], "/health");
      const [transform] = JSON.parse(a["alb.ingress.kubernetes.io/transforms." + service.metadata.name]);
      const [rewrite] = transform.urlRewriteConfig.rewrites;
      const regex = new RegExp(rewrite.regex);
      assert.equal((path + "/version").replace(regex, rewrite.replace), "/version");
      assert.equal(path.replace(regex, rewrite.replace), "/");
      assert.equal(regex.test(path + "0/version"), false);
    '
done
echo 'PR 17 and 18 Ingress routes passed'
