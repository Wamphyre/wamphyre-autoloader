#!/usr/bin/env bash
# Install the vendored PS5 payload SDK into tools/ps5-payload-sdk.
#
# The SDK ships a binary distribution (wrapper scripts plus the sysroot) that
# drives whatever host LLVM is installed (15-23 supported by the wrappers), so
# supplying it in-repo is what lets ./build_release.sh build without Docker.
# The tree is content-ignored by .gitignore: every fresh checkout runs this
# script once; libmicrohttpd is built afterwards by tools/build_sdk_deps.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="$ROOT/tools/ps5-payload-sdk"
ZIP="${WAMP_SDK_ZIP:-$ROOT/build/deps/ps5-payload-sdk.zip}"
URL="https://github.com/ps5-payload-dev/sdk/releases/download/v0.44/ps5-payload-sdk.zip"
SHA256="4d06eab777bb135705b5a6816688c9132efb246093fe606ac488ab6cf65ca5b0"

if [ -x "$SDK/bin/prospero-clang" ] && [ -f "$SDK/target/lib/crt1.o" ]; then
    echo "The PS5 SDK is already installed at $SDK; skipping."
    exit 0
fi

mkdir -p "$(dirname "$ZIP")"
if [ ! -f "$ZIP" ]; then
    echo "Downloading the PS5 SDK distribution (v0.44) ..."
    wget -q -O "$ZIP.tmp" "$URL" && mv "$ZIP.tmp" "$ZIP"
fi

echo "$SHA256  $ZIP" | sha256sum -c - || {
    echo "Error: $ZIP does not match the pinned sha256 for SDK v0.44" >&2
    echo "(point WAMP_SDK_ZIP at a trustable copy or delete this file)" >&2
    exit 1
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
unzip -q "$ZIP" -d "$TMPDIR"
[ -d "$TMPDIR/ps5-payload-sdk" ] || { echo "Error: unexpected zip layout" >&2; exit 1; }
rm -rf "$SDK"
mv "$TMPDIR/ps5-payload-sdk" "$SDK"
chmod +x "$SDK"/bin/*
"$SDK/bin/prospero-clang" --version | head -1
echo "Installed the PS5 SDK at $SDK."
echo "Next: run tools/build_sdk_deps.sh to build libmicrohttpd into the sysroot."
