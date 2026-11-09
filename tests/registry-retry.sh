#!/usr/bin/env bash
# Exercise the production writer against a real disposable registry. Only GitHub's
# attestation lookup is substituted, so this test can run on read-only pull requests.
set -euo pipefail
first=$1
rebuilt=$2
target=$3
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
export RUNNER_TEMP="$work"
export GITHUB_EVENT_PATH="$work/event.json"
cat > "$GITHUB_EVENT_PATH" <<'JSON'
{"repository":{"id":11,"full_name":"example/preview","html_url":"https://github.com/example/preview","default_branch":"main"},"workflow_run":{"event":"pull_request","conclusion":"success","path":".github/workflows/pr-build.yml","head_repository":{"id":11},"actor":{"login":"contributor"},"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pull_requests":[{"number":17,"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repo":{"id":11}},"base":{"ref":"main","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","repo":{"id":11}}}]}}
JSON
mkdir "$work/bin"
cat > "$work/bin/gh" <<'SH'
#!/usr/bin/env bash
set -eu
test "$1 $2" = "attestation verify"
node -e 'const fs = require("node:fs"); process.exit(fs.readFileSync(process.argv[1]).equals(fs.readFileSync(process.argv[2])) ? 0 : 1)' "$3" "$RUNNER_TEMP/authorized.json"
SH
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"
writer=scripts/publish_preview_image.sh
a=$(bash "$writer" prepare "$first" "$work/first")
b=$(bash "$writer" prepare "$rebuilt" "$work/rebuilt")
test "$a" != "$b"
PREVIEW_DIGEST="$a" node scripts/preview-publish.mjs intent
cp "$work/preview-intent.json" "$work/authorized.json"
test "$(bash "$writer" publish "$work/first" "$target" "$a")" = "$a"
test "$(bash "$writer" publish "$work/first" "$target" "$a")" = "$a"

# A second build may be signed, while readiness still needs to record the first digest.
PREVIEW_DIGEST="$b" node scripts/preview-publish.mjs intent
test "$(bash "$writer" publish "$work/rebuilt" "$target" "$b")" = "$a"

# A valid intent for another image cannot authorize the existing registry digest.
cp "$work/preview-intent.json" "$work/authorized.json"
if bash "$writer" publish "$work/rebuilt" "$target" "$b"; then exit 1; fi
if bash "$writer" publish "$work/rebuilt" "$target" "$a"; then exit 1; fi
skopeo inspect --raw "docker://$target" > "$work/remote.json"
test "$(skopeo manifest-digest "$work/remote.json")" = "$a"
printf 'First and recovered digest %s\nRebuilt digest %s\n' "$a" "$b"
