#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
EKS_SERVER=https://test.example.invalid bash argocd/render-eks.sh > "$tmp/appset.yaml"
yq -e '.spec.template.spec.destination.namespace == "container-2" and .spec.template.spec.destination.server == "https://test.example.invalid" and .spec.template.spec.source.helm.valueFiles[0] == "values-eks.yaml"' "$tmp/appset.yaml" > /dev/null
EKS_SERVER=https://test.example.invalid bash argocd/render-eks.sh both > "$tmp/both.yaml"
ruby -ryaml -e '
  set, main = YAML.load_stream(File.read(ARGV.fetch(0)))
  target = {"server"=>"https://test.example.invalid", "namespace"=>"container-2"}
  abort unless set.dig("spec","template","spec","destination") == target && main.dig("spec","destination") == target
' "$tmp/both.yaml"
# Render the ApplicationSet's actual Go template against legacy and new state.
chart="$tmp/revision-check"
mkdir -p "$chart/templates"
printf 'apiVersion: v2\nname: revision-check\nversion: 1.0.0\n' > "$chart/Chart.yaml"
revision_template=$(yq -r '.spec.template.spec.source.targetRevision' "$tmp/appset.yaml")
printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: revision-check\ndata:\n  revision: "{{ with .Values.state }}%s{{ end }}"\n' "$revision_template" > "$chart/templates/check.yaml"
baseline=55d093d0e6cd705e216de4efd2b4a216e7330644
for input in "state.prNumber=17" "state.chartRevision=$baseline"; do
  resolved=$(helm template check "$chart" --set-string "$input" | yq -r '.data.revision')
  test "$resolved" = "$baseline"
done
if helm template check "$chart" --set-string state.chartRevision=unreviewed >/dev/null 2>&1; then
  echo 'ApplicationSet accepted an unreviewed chart revision' >&2
  exit 1
fi
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
      raise "wrong base" unless container["env"].any? { |e| e["name"] == "BASE_PATH" && e["value"] == base }
      %w[startupProbe readinessProbe livenessProbe].each { |p| raise "wrong probe" unless container.dig(p,"httpGet","path") == "#{base}/health" }
    ' "$pr"
done
echo 'PR 17 and 18 Ingress routes passed'
