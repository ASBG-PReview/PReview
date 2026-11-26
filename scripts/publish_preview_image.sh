#!/usr/bin/env bash
# The registry-writer group serializes PR, main and cleanup operations.
set -euo pipefail

case "${1:-}" in
  prepare)
    test "$#" = 3
    skopeo copy --format v2s2 --dest-compress "$2" "dir:$3" >&2
    skopeo manifest-digest "$3/manifest.json"
    exit
    ;;
  publish|publish-main)
    test "$#" = 4
    ;;
  *)
    echo "Expected prepare SOURCE DIRECTORY or publish/publish-main DIRECTORY TAG SIGNED_DIGEST" >&2
    exit 2
    ;;
esac

directory=$2
target="docker://$3"
digest=$4
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
if [[ "$1" == publish-main ]]; then
  test "$3" = "ghcr.io/${REPOSITORY,,}:sha-$SHA"
fi
test "$(skopeo manifest-digest "$directory/manifest.json")" = "$digest"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

if skopeo inspect --raw "$target" > "$work/remote" 2> "$work/error"; then
  existing=$(skopeo manifest-digest "$work/remote")
  if [[ "$existing" != "$digest" ]]; then
    # A fresh Gradle/Docker build of the same commit may have different bytes.
    # Keep the first image only if this publisher previously signed that exact digest.
    if [[ "$1" == publish-main ]]; then
      IMAGE_DIGEST="$existing" node scripts/promote-main.mjs intent > "$work/main-image-intent.json"
      gh attestation verify "$work/main-image-intent.json" --repo "$REPOSITORY" \
        --cert-identity "$GITHUB_SERVER_URL/$REPOSITORY/.github/workflows/ci.yaml@refs/heads/main" \
        --source-ref refs/heads/main --source-digest "$SHA" --deny-self-hosted-runners >&2
    else
      PREVIEW_DIGEST="$existing" node scripts/preview-publish.mjs verify-intent
    fi
    digest=$existing
  fi
else
  if ! grep -Eq ': (manifest unknown|name unknown)(: [^"]*)?"?$' "$work/error"; then
    cat "$work/error" >&2
    exit 1
  fi
  skopeo copy --preserve-digests "dir:$directory" "$target" >&2
fi
skopeo inspect --raw "$target" > "$work/remote"
test "$(skopeo manifest-digest "$work/remote")" = "$digest"
printf '%s\n' "$digest"
