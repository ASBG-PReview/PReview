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
raise "base env" unless env["BASE_PATH"]==base
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
if helm template preview-pr-17 charts/preview-api --set-string preview.prNumber=main --set-string "preview.commitSha=$sha" --set-string "image.digest=$digest" >/dev/null 2>&1; then
 echo 'PR validation weakened' >&2; exit 1
fi
# Render the documented command with the same arguments, without contacting EKS.
HEAD_SHA="$sha" IMAGE_DIGEST="$digest" TEAM_NAMESPACE=container-2 TEAM_PATH=/container-2/pr-12 ALB_GROUP=sbg-demo \
  ruby -rshellwords -ryaml -e '
    example = File.read("README.md")[/^helm upgrade --install preview-pr-12 .*?(?=^```)/m] or abort "missing README example"
    args = Shellwords.split(example.gsub(/\\\n/, " "))
    args.shift(3)
    args.map! { |arg| arg.gsub(/\$(\w+)/) { ENV.fetch($1) } }
    output = IO.popen(["helm", "template", *args], &:read)
    abort "README helm example failed" unless $?.success?
    objects = YAML.load_stream(output).compact
    pod = objects.find { |d| d["kind"] == "Deployment" }.fetch("spec").fetch("template")
    service = objects.find { |d| d["kind"] == "Service" }
    abort "README selector" unless service.dig("spec","selector").all? { |k,v| pod.dig("metadata","labels",k) == v }
    container = pod.dig("spec","containers",0)
    base = ENV.fetch("TEAM_PATH")
    abort "README base path" unless container["env"].include?({"name"=>"BASE_PATH","value"=>base})
    %w[startupProbe readinessProbe livenessProbe].each { |k| abort "README probe" unless container.dig(k,"httpGet","path") == base + "/health" }
  '
echo 'Main, PR and README Helm checks passed'
