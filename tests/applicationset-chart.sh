#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

sha=0123456789abcdef0123456789abcdef01234567
digest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
output=$(helm template preview-pr-17 charts/preview-api --namespace preview-pr-17 \
  --set manageNamespace=true --set-string preview.prNumber=17 \
  --set-string "preview.commitSha=$sha" --set-string "image.digest=$digest" \
  --set-string 'imagePullSecrets[0].name=ghcr-pull')

printf '%s\n' "$output" | ruby -e '
require "yaml"
objects = YAML.load_stream(STDIN.read).compact
ns = objects.find { |x| x["kind"] == "Namespace" }
deployment = objects.find { |x| x["kind"] == "Deployment" }
raise "namespace mismatch" unless ns.dig("metadata", "name") == "preview-pr-17"
pod = deployment.dig("spec", "template", "spec")
container = pod.fetch("containers").first
raise "missing pull secret" unless pod.fetch("imagePullSecrets").first["name"] == "ghcr-pull"
raise "wrong image" unless container.fetch("image") == "ghcr.io/asbg-preview/preview@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
raise "missing startup probe" unless container.dig("startupProbe", "httpGet", "path") == "/health"
env = container.fetch("env").to_h { |e| [e.fetch("name"), e["value"]] }
raise "wrong PR number" unless env["PR_NUMBER"] == "17"
raise "wrong SHA" unless env["COMMIT_SHA"] == "0123456789abcdef0123456789abcdef01234567"
'

if helm template preview-pr-17 charts/preview-api --namespace preview-pr-18 \
  --set manageNamespace=true --set-string preview.prNumber=17 \
  --set-string "preview.commitSha=$sha" --set-string "image.digest=$digest" >/dev/null 2>&1; then
  echo 'Expected mismatched PR namespace to fail' >&2; exit 1
fi
if helm template preview-pr-17 charts/preview-api --namespace preview-pr-17 \
  --set manageNamespace=true --set-string preview.prNumber=17 \
  --set-string "preview.commitSha=$sha" >/dev/null 2>&1; then
  echo 'Expected missing digest to fail' >&2; exit 1
fi
echo 'ApplicationSet chart checks passed'
