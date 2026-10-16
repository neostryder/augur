#!/bin/sh
# Installs the Augur terminal app on macOS: downloads the newest release, checks the signature on the release's checksums and the download against them, unpacks it under
# ~/.local/share/augur, and puts the augur command in ~/.local/bin. Run it again to update; `augur update` does the same from the command.
#   curl -fsSL https://github.com/neostryder/augur/releases/latest/download/install.sh | sh
# AUGUR_VERSION installs a particular version, AUGUR_ROOT and AUGUR_BIN change the two folders, AUGUR_RELEASE_URL points at a mirror.
# The checksums must be signed with the release key below, which is also the key the window app's updater trusts. Node.js (which the app needs anyway) or minisign checks it.
set -eu

release=${AUGUR_RELEASE_URL:-https://github.com/neostryder/augur/releases}
root=${AUGUR_ROOT:-$HOME/.local/share/augur}
bin=${AUGUR_BIN:-$HOME/.local/bin}
pubkey=${AUGUR_PUBKEY:-dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDYxOTkwMjIwNjcwMDFGMDYKUldRR0h3Qm5JQUtaWWRzY0p2Mkp2aXlQaFU1eEtWa2Zadk1RUWlRZG9KbVZHRS96anBHMnhMR1cK}

say() { printf '%s\n' "$*"; }
die() { printf 'augur install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this installer is for macOS. On Arch Linux, install the augur-terminal package instead; the README shows how."
for tool in curl tar shasum; do command -v "$tool" > /dev/null 2>&1 || die "$tool is needed and was not found."; done

version=${AUGUR_VERSION:-}
if [ -z "$version" ]; then
  # latest.json is the file the apps check for updates; its first "version" line names the newest release.
  version=$(curl -fsSL "$release/latest/download/latest.json" | sed -n 's/.*"version" *: *"v\{0,1\}\([0-9][^"]*\)".*/\1/p' | head -n 1) || true
  [ -n "$version" ] || die "could not read the latest version from $release."
fi
version=${version#v}
name=augur-terminal-$version-macos.tar.gz
tag=$release/download/v$version

work=$(mktemp -d "${TMPDIR:-/tmp}/augur-install.XXXXXX")
trap 'rm -rf "$work"' EXIT

say "Downloading Augur $version."
curl -fsSL -o "$work/SHA256SUMS.txt" "$tag/SHA256SUMS.txt" || die "could not download the checksums for $version."
curl -fsSL -o "$work/SHA256SUMS.txt.sig" "$tag/SHA256SUMS.txt.sig" || die "the release has no signature for its checksums, so it was not installed."

# The signature is minisign's: Ed25519 over the BLAKE2b-512 hash of the file.
verify_signature() {
  if command -v node > /dev/null 2>&1; then
    node - "$work/SHA256SUMS.txt" "$work/SHA256SUMS.txt.sig" "$pubkey" << 'NODE'
const fs = require('fs'), c = require('crypto');
const [file, sigFile, key] = process.argv.slice(2);
const text = (t) => (/^untrusted comment:/i.test(t.trim()) ? t : Buffer.from(t.trim(), 'base64').toString('utf8'));
const first = (t) => Buffer.from(text(t).split(/\r?\n/).filter((l) => l.trim() && !/^(untrusted|trusted) comment:/i.test(l))[0].trim(), 'base64');
try {
  const k = first(key), s = first(fs.readFileSync(sigFile, 'utf8')), algo = s.toString('latin1', 0, 2);
  if (k.length !== 42 || s.length !== 74 || k.toString('latin1', 0, 2) !== 'Ed' || (algo !== 'Ed' && algo !== 'ED') || !k.subarray(2, 10).equals(s.subarray(2, 10))) process.exit(1);
  const body = fs.readFileSync(file), signed = algo === 'ED' ? c.createHash('blake2b512').update(body).digest() : body;
  const pub = c.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), k.subarray(10)]), format: 'der', type: 'spki' });
  process.exit(c.verify(null, signed, pub, s.subarray(10)) ? 0 : 1);
} catch (e) { process.exit(1); }
NODE
  elif command -v minisign > /dev/null 2>&1; then
    printf '%s\n' "$pubkey" | base64 -d | sed -n 2p > "$work/release.key"
    minisign -V -P "$(cat "$work/release.key")" -m "$work/SHA256SUMS.txt" -x "$work/SHA256SUMS.txt.sig" > /dev/null 2>&1
  else
    die "Node.js or minisign is needed to check the release signature, and neither was found."
  fi
}
verify_signature || die "the checksums are not signed with Augur's release key, so nothing was installed."
curl -fSL --progress-bar -o "$work/$name" "$tag/$name" || die "could not download $name."

want=$(awk -v f="$name" '{ n = $2; sub(/^\*/, "", n); if (n == f) { print $1; exit } }' "$work/SHA256SUMS.txt")
[ -n "$want" ] || die "$name has no checksum in the release, so it was not installed."
have=$(shasum -a 256 "$work/$name" | awk '{ print $1 }')
[ "$have" = "$want" ] || die "the download does not match its checksum, so it was not installed."

mkdir -p "$root/versions" "$bin"
tar -xzf "$work/$name" -C "$work"
[ -f "$work/augur-terminal-$version/augur.mjs" ] || die "$name does not hold an Augur install."
rm -rf "$root/versions/$version"
mv "$work/augur-terminal-$version" "$root/versions/$version"
# The files came through curl, which does not mark them as quarantined, but a browser download of the tarball would have; clear it either way.
xattr -dr com.apple.quarantine "$root/versions/$version" 2> /dev/null || true

# The link is replaced by renaming a new one over it, so the command is never missing.
ln -sfn "versions/$version" "$root/.current-new"
mv -fh "$root/.current-new" "$root/current" 2> /dev/null || { rm -f "$root/current"; mv "$root/.current-new" "$root/current"; }
printf '{"method":"script","version":"%s"}\n' "$version" > "$root/install.json"
ln -sf "$root/current/augur" "$bin/augur"
ln -sf "$root/current/augur-mcp" "$bin/augur-mcp"

# Keep this version and the one before it.
ls -1 "$root/versions" | sort -t. -k1,1nr -k2,2nr -k3,3nr | tail -n +3 | while read -r old; do
  [ "$old" = "$version" ] || rm -rf "$root/versions/$old"
done

# The login entry names the files of whichever version was current when it was set up, so it is written again for the new one.
if [ -f "$HOME/Library/LaunchAgents/com.neostryder.augurd.plist" ]; then
  "$root/current/augur" service enable > /dev/null 2>&1 && say "The service now runs the new version." || say "Run augur service enable to move the start at login to the new version."
fi

say "Augur $version is installed. Run augur to open it."
case ":$PATH:" in
  *":$bin:"*) ;;
  *) say "$bin is not on your PATH. Add it with: echo 'export PATH=\"$bin:\$PATH\"' >> ~/.zshrc" ;;
esac
