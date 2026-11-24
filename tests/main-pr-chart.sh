#!/usr/bin/env bash
set -euo pipefail
sha=0123456789abcdef0123456789abcdef01234567
digest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
for target in main 17 18; do
  args=(-f charts/preview-api/values-eks.yaml --set-string "image.digest=$digest")
  if [ "$target" = main ]; then
    release=preview-main
    base=/container-2/main
    args+=(-f charts/preview-api/values-main.yaml --set-string "main.commitSha=$sha")
  else
    release=preview-pr-$target
    base=/container-2/pr-$target
    args+=(--set-string "preview.prNumber=$target" --set-string "preview.commitSha=$sha" --set-string "basePath=$base")
  fi
  helm template "$release" charts/preview-api --namespace container-2 "${args[@]}" | ruby -r yaml -e '
objects=YAML.load_stream(STDIN.read).compact
raise "namespace managed" if objects.any? { |o| o["kind"] == "Namespace" }
d,s,i=%w[Deployment Service Ingress].map { |k| objects.find { |o| o["kind"] == k } }
name=ARGV[0]+"-preview-api"; base=ARGV[1]
raise "collision" unless [d,s,i].all? { |o| o.dig("metadata","name")==name }
raise "service type" unless s.dig("spec","type")=="ClusterIP" && !s["spec"].key?("externalIPs")
raise "selector" unless s.dig("spec","selector")==d.dig("spec","selector","matchLabels")
c=d.dig("spec","template","spec","containers")[0]
env=c["env"].to_h { |e| [e["name"],e["value"]] }
raise "base env" unless env["BASE_PATH"]==base && env["SERVER_SERVLET_CONTEXT_PATH"]==base
raise "identity" unless env["PR_NUMBER"]==ARGV[2] && env["COMMIT_SHA"]==ARGV[3]
%w[startupProbe readinessProbe livenessProbe].each { |k| raise "probe" unless c.dig(k,"httpGet","path")==base+"/health" }
raise "ALB health" unless i.dig("metadata","annotations","alb.ingress.kubernetes.io/healthcheck-path")==base+"/health"
raise "ALB group" unless i.dig("metadata","annotations","alb.ingress.kubernetes.io/group.name")=="sbg-demo"
raise "path" unless i.dig("spec","rules",0,"http","paths",0,"path")==base
raise "forbidden ingress" if i["spec"].key?("tls") || i["spec"].key?("defaultBackend") || i["spec"]["rules"].any? { |r| r.key?("host") }
raise "replicas" unless d.dig("spec","replicas") == (ARGV[2]=="main" ? 2 : 1)
raise "surge" unless d.dig("spec","strategy","rollingUpdate","maxSurge")==0
' "$release" "$base" "$target" "$sha"
done
reject() {
 if helm template preview-main charts/preview-api -f charts/preview-api/values-eks.yaml -f charts/preview-api/values-main.yaml --set-string "main.commitSha=$sha" --set-string "image.digest=$digest" "$@" >/dev/null 2>&1; then
   echo "Unexpectedly accepted: $*" >&2; exit 1
 fi
}
reject --set-string main.commitSha=bad
reject --set-string image.digest=
reject --set preview.local=true --set-string image.digest=
reject --set-string basePath=/container-2/pr-17
reject --set-string ingress.host=example.com
reject --set-string ingress.path=/container-2
reject --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/load-balancer-name=custom'
reject --set rollingUpdate.maxSurge=0,rollingUpdate.maxUnavailable=0
reject --set rollingUpdate.maxSurge=-1
helm template preview-local charts/preview-api -f charts/preview-api/values-local.yaml \
  --set rollingUpdate.maxSurge=1,rollingUpdate.maxUnavailable=0 --show-only templates/deployment.yaml | \
  ruby -ryaml -e 'policy = YAML.load(STDIN.read).dig("spec", "strategy", "rollingUpdate")
    raise "rollout policy" unless policy == {"maxSurge"=>1, "maxUnavailable"=>0}'
if helm template preview-pr-17 charts/preview-api --set-string preview.prNumber=main --set-string "preview.commitSha=$sha" --set-string "image.digest=$digest" >/dev/null 2>&1; then
 echo 'PR validation weakened' >&2; exit 1
fi
echo 'Main and PR shared ALB checks passed'
