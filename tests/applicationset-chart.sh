#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

sha=0123456789abcdef0123456789abcdef01234567
digest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
for pr in 17 18; do
  helm template "preview-pr-$pr" charts/preview-api --namespace container-2 \
    --set-string "preview.prNumber=$pr" --set-string "preview.commitSha=$sha" \
    --set-string "image.digest=$digest" --set-string 'imagePullSecrets[0].name=ghcr-pull' |
    ruby -e '
require "yaml"
objects = YAML.load_stream(STDIN.read).compact
raise "chart must not create a namespace" if objects.any? { |x| x["kind"] == "Namespace" }
pr = ARGV.fetch(0)
deployment = objects.find { |x| x["kind"] == "Deployment" }
service = objects.find { |x| x["kind"] == "Service" }
raise "deployment name mismatch" unless deployment.dig("metadata", "name") == "preview-pr-#{pr}-preview-api"
raise "service name mismatch" unless service.dig("metadata", "name") == "preview-pr-#{pr}-preview-api"
raise "deployment selector is not PR-specific" unless deployment.dig("spec", "selector", "matchLabels", "app.kubernetes.io/instance") == "preview-pr-#{pr}"
raise "service selector is not PR-specific" unless service.dig("spec", "selector", "app.kubernetes.io/instance") == "preview-pr-#{pr}"
pod = deployment.dig("spec", "template", "spec")
container = pod.fetch("containers").first
raise "missing pull secret" unless pod.fetch("imagePullSecrets").first["name"] == "ghcr-pull"
raise "wrong image" unless container.fetch("image").end_with?("@" + ARGV.fetch(1))
raise "missing startup probe" unless container.dig("startupProbe", "httpGet", "path") == "/health"
env = container.fetch("env").to_h { |e| [e.fetch("name"), e["value"]] }
raise "wrong PR number" unless env["PR_NUMBER"] == pr
raise "wrong SHA" unless env["COMMIT_SHA"] == ARGV.fetch(2)
' "$pr" "$digest" "$sha"
done
if helm template preview-pr-17 charts/preview-api --namespace container-2 \
  --set-string preview.prNumber=17 --set-string "preview.commitSha=$sha" >/dev/null 2>&1; then
  echo 'Expected missing digest to fail' >&2; exit 1
fi
echo 'Shared namespace chart checks passed'
