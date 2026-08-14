#!/usr/bin/env bash
#
# Install the latest T3 Trade release on an Apple Silicon Mac.
#
# The published app is not notarized by Apple, and macOS refuses to open a
# non-notarized app that arrived through a browser — the download carries a
# quarantine flag, and Gatekeeper reports the app as "damaged" rather than as
# unsigned. Nothing is wrong with the app; the flag is the whole problem.
#
# This script downloads the same DMG the website links to, copies the app to
# /Applications, and removes that flag, which is exactly what the manual
# instructions ask the user to do by hand. It installs nothing else, needs no
# password, and touches no system settings.
#
#   curl -fsSL https://raw.githubusercontent.com/0xgeorgemathew/t3trade/main/scripts/install-macos.sh | bash
#
# Read it before running it — that goes for any script piped into a shell.
set -euo pipefail

REPO="0xgeorgemathew/t3trade"
APP_NAME="T3 Trade (Alpha).app"
INSTALL_DIR="/Applications"

die() {
  echo "error: $*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || die "this installer is for macOS; run T3 Trade from source on other platforms"
[[ "$(uname -m)" == "arm64" ]] || die "the published build is Apple Silicon only; run from source on an Intel Mac"

echo "Finding the latest release…"
# The list endpoint, not /releases/latest: alpha builds are published as
# prereleases, and /latest does not return those — the same reason the download
# page reads the list.
asset_url="$(
  curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=10" |
    /usr/bin/python3 -c '
import json, sys
for release in json.load(sys.stdin):
    if release.get("draft"):
        continue
    for asset in release.get("assets", []):
        if asset["name"].endswith("-arm64.dmg"):
            print(asset["browser_download_url"])
            raise SystemExit(0)
'
)"
[[ -n "$asset_url" ]] || die "the latest release has no arm64 .dmg; see https://github.com/${REPO}/releases"

workdir="$(mktemp -d)"
mountpoint="${workdir}/mnt"
trap 'hdiutil detach "$mountpoint" -quiet >/dev/null 2>&1 || true; rm -rf "$workdir"' EXIT

echo "Downloading $(basename "$asset_url")…"
curl -fL --progress-bar -o "${workdir}/t3trade.dmg" "$asset_url"

echo "Mounting…"
hdiutil attach "${workdir}/t3trade.dmg" -nobrowse -quiet -mountpoint "$mountpoint"

app_path="$(/usr/bin/find "$mountpoint" -maxdepth 1 -name "*.app" -print -quit)"
[[ -n "$app_path" ]] || die "no .app inside the disk image"

# A previous copy has to go first: ditto merges into an existing bundle, which
# can leave stale files from an older version behind.
target="${INSTALL_DIR}/$(basename "$app_path")"
if [[ -e "$target" ]]; then
  echo "Replacing the existing $(basename "$app_path")…"
  rm -rf "$target"
fi

echo "Copying to ${INSTALL_DIR}…"
/usr/bin/ditto "$app_path" "$target"

echo "Clearing the download quarantine flag…"
/usr/bin/xattr -dr com.apple.quarantine "$target"

echo
echo "Installed: ${target}"
echo "Open it from Applications. T3 Trade places orders on Hyperliquid TESTNET only."
