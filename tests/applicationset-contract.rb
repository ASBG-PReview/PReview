require "json"
require "open3"
require "tmpdir"
require "yaml"

# Expand the actual ApplicationSet's string fields using Go templates/Sprig,
# then feed its release name, value files and parameters into the real chart.
Dir.mktmpdir("preview-appset") do |chart|
  File.write("#{chart}/Chart.yaml", "apiVersion: v2\nname: fixture\nversion: 0.1.0\n")
  Dir.mkdir("#{chart}/templates")
  app = YAML.load_file("argocd/applicationset.yaml").fetch("spec").fetch("template")
  app.merge!("apiVersion" => "argoproj.io/v1alpha1", "kind" => "Application")
  expressions = {}
  template = JSON.generate(app).gsub(/"(?:[^"\\]|\\.)*"/) do |quoted|
    scalar = JSON.parse(quoted)
    next quoted unless scalar.include?("{{")
    key = "field#{expressions.size}"
    expressions[key] = scalar
    "{{ tpl (index .Values.expressions \"#{key}\") .Values.state | toJson }}"
  end
  File.write("#{chart}/templates/application.yaml", template)
  sha = "a" * 40
  digest = "sha256:" + "b" * 64
  revision = "c" * 40
  state = {"path" => {"basename" => "pr-17"}, "prNumber" => "17",
           "commitSha" => sha, "imageDigest" => digest, "chartRevision" => revision}
  render = lambda do |record|
    Open3.capture3("helm", "template", "fixture", chart, "-f", "-",
                   stdin_data: JSON.generate({"expressions" => expressions, "state" => record}))
  end
  text, err, status = render.call(state)
  raise err unless status.success?
  expanded = YAML.load_stream(text).compact.fetch(0)
  source = expanded.fetch("spec").fetch("source")
  raise "chart changed independently of the image" unless source.fetch("targetRevision") == revision
  values = source.fetch("helm")
  args = ["helm", "template", values.fetch("releaseName"), source.fetch("path"),
          "-n", expanded.fetch("spec").fetch("destination").fetch("namespace")]
  values.fetch("valueFiles").each { |file| args.concat(["-f", File.join(source.fetch("path"), file)]) }
  values.fetch("parameters").each do |parameter|
    args.concat([parameter["forceString"] ? "--set-string" : "--set",
                 "#{parameter.fetch("name")}=#{parameter.fetch("value")}"])
  end
  text, err, status = Open3.capture3(*args)
  raise err unless status.success?
  objects = YAML.load_stream(text).compact
  deployment = objects.find { |item| item["kind"] == "Deployment" }
  container = deployment.dig("spec", "template", "spec", "containers", 0)
  env = container.fetch("env").to_h { |item| [item.fetch("name"), item["value"]] }
  raise "wrong release" unless deployment.dig("metadata", "name") == "preview-pr-17-preview-api"
  raise "wrong image" unless container.fetch("image") == "ghcr.io/asbg-preview/preview@#{digest}"
  raise "wrong identity" unless env["COMMIT_SHA"] == sha && env["PR_NUMBER"] == "17"
  raise "wrong readiness" unless container.dig("readinessProbe", "httpGet", "path") == "/container-2/pr-17/health"
  [state.reject { |k| k == "chartRevision" }, state.merge("chartRevision" => "main"),
   state.merge("path" => {"basename" => "pr-017"}), state.merge("imageDigest" => [digest])].each do |bad|
    raise "invalid projection was accepted" if render.call(bad).last.success?
  end
end
puts "ApplicationSet projection and chart contract passed"
