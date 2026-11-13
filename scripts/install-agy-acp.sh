#!/usr/bin/env bash
# Installs Google's Antigravity ACP server (from the ACP registry) into .infinity-harness/bin/agy-acp,
# verifying the registry's sha256. It reuses the agy CLI's Google login (auth method oauth-personal).
set -euo pipefail
cd "$(dirname "$0")/.."
# An install from before the rename keeps its data in .meta-harness; move it first so nothing is stranded.
if [ -d .meta-harness ] && [ ! -e .infinity-harness ]; then mv .meta-harness .infinity-harness; fi
DEST=.infinity-harness/bin/agy-acp
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=darwin-aarch64 ;;
  Darwin-x86_64) PLATFORM=darwin-x86_64 ;;
  Linux-x86_64) PLATFORM=linux-x86_64 ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
read -r VERSION URL SHA < <(curl -fsSL https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const a=JSON.parse(s).agents.find(x=>x.id==='antigravity-acp');
    const b=a.distribution.binary['$PLATFORM'];
    console.log(a.version, b.archive, b.sha256);
  });")
STAMP="$VERSION $PLATFORM"
if [ -f "$DEST/VERSION" ] && [ "$(cat "$DEST/VERSION")" = "$STAMP" ]; then echo "agy ACP server $VERSION ($PLATFORM) already installed"; exit 0; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/pkg.zip"
if command -v sha256sum >/dev/null 2>&1; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi
echo "$SHA  $TMP/pkg.zip" | "${SHA256[@]}" -c - >/dev/null
rm -rf "$DEST" && mkdir -p "$DEST"
unzip -q "$TMP/pkg.zip" -d "$DEST"
echo "$STAMP" > "$DEST/VERSION"
echo "installed agy ACP server $VERSION to $DEST"
