#!/usr/bin/env bash
# The calling workflow serializes writers for the same repository, PR and SHA.
set -euo pipefail

source_image=$1
target="docker://$2"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

skopeo copy --format v2s2 --dest-compress "$source_image" "dir:$work/image" >&2
digest=$(skopeo manifest-digest "$work/image/manifest.json")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]

if skopeo inspect --raw "$target" > "$work/remote" 2> "$work/error"; then
  existing=$(skopeo manifest-digest "$work/remote")
  if [[ "$existing" != "$digest" ]]; then
    echo "Refusing to replace $target ($existing) with $digest" >&2
    exit 1
  fi
else
  # Only an explicit missing manifest/repository permits first publication.
  if ! grep -Eq ': (manifest unknown|name unknown)(: [^"]*)?"?$' "$work/error"; then
    cat "$work/error" >&2
    exit 1
  fi
  skopeo copy --preserve-digests "dir:$work/image" "$target" >&2
fi
skopeo inspect --raw "$target" > "$work/remote"
test "$(skopeo manifest-digest "$work/remote")" = "$digest"
printf '%s\n' "$digest"
