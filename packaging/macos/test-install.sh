#!/bin/sh
# Runs install.sh against a local copy of a release, so the script and the tarball can be checked before anything is published. It needs the
# macOS tarball from `pnpm pack:terminal --macos` (any platform's tarball with the same layout works for a trial on another system).
#   sh packaging/macos/test-install.sh dist/augur-terminal-<version>-macos.tar.gz
set -eu

tarball=${1:?path to augur-terminal-<version>-macos.tar.gz}
name=$(basename "$tarball")
version=${name#augur-terminal-}
version=${version%-macos.tar.gz}
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/augur-install-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

mirror=$tmp/mirror
mkdir -p "$mirror/latest/download" "$mirror/download/v$version" "$tmp/home"
cp "$tarball" "$mirror/download/v$version/$name"
printf '{\n  "version": "%s"\n}\n' "$version" > "$mirror/latest/download/latest.json"
(cd "$mirror/download/v$version" && shasum -a 256 "$name" > SHA256SUMS.txt)

export HOME=$tmp/home AUGUR_RELEASE_URL=file://$mirror AUGUR_ROOT=$tmp/root AUGUR_BIN=$tmp/bin AUGURD_DATA=$tmp/data
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

echo "--- first install"
sh "$here/install.sh"
[ -x "$AUGUR_BIN/augur" ] || fail "the augur command was not linked"
[ -f "$AUGUR_ROOT/versions/$version/augur.mjs" ] || fail "the version folder is missing"
[ "$(cat "$AUGUR_ROOT/versions/$version/VERSION")" = "$version" ] || fail "VERSION does not name the version"
"$AUGUR_BIN/augur" --help | head -n 1
"$AUGUR_BIN/augur" status --waybar | grep -q '"class":"off"' || fail "status --waybar did not report the service as off"

echo "--- a second run keeps this version and one before it"
mkdir -p "$AUGUR_ROOT/versions/0.9.0" "$AUGUR_ROOT/versions/0.9.1"
sh "$here/install.sh"
count=$(ls -1 "$AUGUR_ROOT/versions" | wc -l | tr -d ' ')
[ "$count" = 2 ] || fail "expected two versions kept, found $count"
[ -d "$AUGUR_ROOT/versions/$version" ] || fail "the new version was pruned"

echo "--- a wrong checksum is refused"
printf '%s  %s\n' "$(printf 'x' | shasum -a 256 | awk '{ print $1 }')" "$name" > "$mirror/download/v$version/SHA256SUMS.txt"
if sh "$here/install.sh" > "$tmp/out" 2>&1; then fail "a bad checksum was accepted"; fi
grep -q "does not match its checksum" "$tmp/out" || fail "the refusal did not say why"
echo "ok"
