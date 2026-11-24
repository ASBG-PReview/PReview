#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
EKS_SERVER=https://test.example.invalid bash argocd/render-eks.sh > "$tmp/controllers.yaml"
ruby -ryaml -e '
main, prs, *extra = YAML.load_stream(File.read(ARGV.fetch(0)))
raise "expected main and PR controllers" unless extra.empty? && main["kind"] == "Application" && prs["kind"] == "ApplicationSet"
destination = {"server"=>"https://test.example.invalid", "namespace"=>"container-2"}
raise "main destination" unless main.dig("spec","destination") == destination
raise "PR destination" unless prs.dig("spec","template","spec","destination") == destination
raise "unexpected main source" unless main.dig("spec","source","targetRevision") == "main-deploy"
raise "incorrect deployment projection" unless prs.dig("spec","generators",0,"git","files").map { |f| f.fetch("path") } == ["deployments/pr-*/state.json"]
' "$tmp/controllers.yaml"
for invalid in https://kubernetes.default.svc https://KUBERNETES.DEFAULT.SVC.CLUSTER.LOCAL:443/ \
               http://test.example.invalid https://user@test.example.invalid; do
  if EKS_SERVER="$invalid" bash argocd/render-eks.sh > /dev/null 2>&1; then
    echo "Expected registered remote HTTPS endpoint" >&2; exit 1
  fi
done
for pr in 17 18; do
  helm template "preview-pr-$pr" charts/preview-api -n container-2 -f charts/preview-api/values-eks.yaml \
    --set-string "basePath=/container-2/pr-$pr" --set-string "preview.prNumber=$pr" \
    --set-string "preview.commitSha=$(printf '%040d' 1)" --set-string "image.digest=sha256:$(printf '%064d' 1)" |
    ruby -r yaml -e '
      docs = YAML.load_stream(STDIN.read).compact
      pr = ARGV.fetch(0); base = "/container-2/pr-#{pr}"
      ingress = docs.find { |d| d["kind"] == "Ingress" }; service = docs.find { |d| d["kind"] == "Service" }
      deployment = docs.find { |d| d["kind"] == "Deployment" }; container = deployment.dig("spec", "template", "spec", "containers", 0)
      raise "service mismatch" unless ingress.dig("spec", "rules", 0, "http", "paths", 0, "backend", "service", "name") == service.dig("metadata", "name")
      raise "path mismatch" unless ingress.dig("spec", "rules", 0, "http", "paths", 0, "path") == base
      a = ingress.dig("metadata", "annotations")
      raise "wrong ALB group" unless a["alb.ingress.kubernetes.io/group.name"] == "sbg-demo"
      raise "wrong health" unless a["alb.ingress.kubernetes.io/healthcheck-path"] == "#{base}/health"
      raise "unexpected annotation" unless a.keys.sort == %w[alb.ingress.kubernetes.io/group.name alb.ingress.kubernetes.io/healthcheck-path alb.ingress.kubernetes.io/scheme alb.ingress.kubernetes.io/target-type].sort
      %w[BASE_PATH SERVER_SERVLET_CONTEXT_PATH].each do |key|
        raise "wrong #{key}" unless container["env"].any? { |e| e["name"] == key && e["value"] == base }
      end
      %w[startupProbe readinessProbe livenessProbe].each { |p| raise "wrong probe" unless container.dig(p,"httpGet","path") == "#{base}/health" }
    ' "$pr"
done
echo 'PR 17 and 18 Ingress routes passed'
