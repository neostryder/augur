#!/bin/bash
# Builds one of the PKGBUILDs in a clean Arch container and checks the package: namcap on the recipe and on the result, a test install, and a
# run of the installed command. It expects the repository at /r and a non-root user named builder (the rpgm-validate/arch image has both).
#   docker run --rm -v <repo>:/r:ro -v <folder of release files>:/src:ro rpgm-validate/arch:latest bash /r/packaging/arch/validate.sh <augur-terminal|augur-bin>
# Anything in /src is copied next to the PKGBUILD as a source, and its checksum is written into the copy, so a build can run before the release
# exists. With no /src, makepkg downloads the sources from the release.
set -eu
name=${1:?package folder name}
work=/home/builder/$name
mkdir -p "$work"
cp "/r/packaging/arch/$name/PKGBUILD" "$work/"
[ -d /src ] && cp /src/* "$work/"
chown -R builder "$work"
ver=$(sed -n 's/^pkgver=//p' "$work/PKGBUILD")
echo "=== $name $ver: sources"
ls "$work"
# Checksums for the copied sources, written into the copy of the recipe in the order the sources are listed.
if [ -d /src ]; then
  su builder -c "cd $work && makepkg -g > sums.txt 2> /dev/null"
  su builder -c "cd $work && sed -i '/^sha256sums=(/{:a;/)[[:space:]]*$/!{N;ba};d}' PKGBUILD && cat sums.txt >> PKGBUILD && rm sums.txt"
fi
echo "=== namcap on the recipe"
su builder -c "cd $work && namcap PKGBUILD"
echo "=== dependencies"
# makepkg cannot ask for a password here, so the runtime dependencies are installed first, without their version bounds.
deps=$(bash -c ". $work/PKGBUILD; printf '%s ' \"\${depends[@]%%[<>=]*}\"")
pacman -Sy --needed --noconfirm $deps > /dev/null
echo "=== makepkg"
su builder -c "cd $work && makepkg -f --noconfirm 2>&1 | tail -15"
echo "=== namcap on the package"
su builder -c "cd $work && namcap ./*.pkg.tar.zst" || true
su builder -c "cd $work && pacman -Qlp ./*.pkg.tar.zst"
echo "=== install and run"
pacman -U --noconfirm "$work"/*.pkg.tar.zst > /dev/null
case $name in
  augur-terminal)
    augur --help | head -3
    # No service is running, so a status bar block says so and the command still succeeds.
    AUGURD_DATA=$(mktemp -d) augur status --waybar
    test -f /usr/lib/augur/claude-mod/.claude-plugin/plugin.json
    ;;
  augur-bin)
    test -x /usr/bin/augur-cli && /usr/bin/augur-cli --help | head -3
    ;;
esac
echo "=== ok"
