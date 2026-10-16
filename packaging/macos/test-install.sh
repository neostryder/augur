#!/bin/sh
# Runs install.sh against a local copy of a release, so the script and the tarball can be checked before anything is published. It needs the
# macOS tarball from `pnpm pack:terminal --macos` (any platform's tarball with the same layout works for a trial on another system). The mirror's
# checksums are signed with a throwaway key, which the run hands to install.sh through AUGUR_PUBKEY.
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

# Signs SHA256SUMS.txt in the mirror the way minisign does and prints the matching public key (base64 of the .pub file).
cat > "$tmp/sign.mjs" << 'NODE'
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [dir, keyFile] = process.argv.slice(2);
let k;
if (existsSync(keyFile)) k = JSON.parse(readFileSync(keyFile, 'utf8'));
else { const g = generateKeyPairSync('ed25519'); k = { priv: g.privateKey.export({ format: 'pem', type: 'pkcs8' }), pub: g.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), id: randomBytes(8).toString('base64') }; writeFileSync(keyFile, JSON.stringify(k)); }
const id = Buffer.from(k.id, 'base64');
const text = readFileSync(`${dir}/SHA256SUMS.txt`);
const sig = sign(null, createHash('blake2b512').update(text).digest(), k.priv);
writeFileSync(`${dir}/SHA256SUMS.txt.sig`, `untrusted comment: test signature\n${Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64')}\n`);
process.stdout.write(Buffer.from(`untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), id, Buffer.from(k.pub, 'base64')]).toString('base64')}\n`).toString('base64'));
NODE
sign_mirror() { node "$tmp/sign.mjs" "$mirror/download/v$version" "$tmp/key.json"; }
AUGUR_PUBKEY=$(sign_mirror)
export AUGUR_PUBKEY

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

echo "--- checksums that are not signed with the release key are refused"
cp "$mirror/download/v$version/SHA256SUMS.txt" "$tmp/sums.good"
printf '%s  %s\n' "$(printf 'x' | shasum -a 256 | awk '{ print $1 }')" "$name" > "$mirror/download/v$version/SHA256SUMS.txt"
if sh "$here/install.sh" > "$tmp/out" 2>&1; then fail "a changed checksum list was accepted"; fi
grep -q "not signed with Augur's release key" "$tmp/out" || fail "the refusal did not say why"
rm "$mirror/download/v$version/SHA256SUMS.txt.sig"
cp "$tmp/sums.good" "$mirror/download/v$version/SHA256SUMS.txt"
if sh "$here/install.sh" > "$tmp/out" 2>&1; then fail "a release with no signature was accepted"; fi
grep -q "no signature" "$tmp/out" || fail "the refusal did not say why"

echo "--- a wrong checksum is refused"
printf '%s  %s\n' "$(printf 'x' | shasum -a 256 | awk '{ print $1 }')" "$name" > "$mirror/download/v$version/SHA256SUMS.txt"
sign_mirror > /dev/null
if sh "$here/install.sh" > "$tmp/out" 2>&1; then fail "a bad checksum was accepted"; fi
grep -q "does not match its checksum" "$tmp/out" || fail "the refusal did not say why"
echo "ok"
