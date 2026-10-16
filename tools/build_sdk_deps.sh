#!/usr/bin/env bash
# Build the SDK dependency (libmicrohttpd) into the vendored SDK sysroot.
# This mirrors third_party/ps5-webkit-remote-loader/build_deps.sh, which runs
# inside the SDK Docker image at image-build time; the vendored SDK built via
# tools/install_sdk.sh arrives without it, so the host build calls this once.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${WAMP_SDK:-$ROOT/tools/ps5-payload-sdk}"
[ -x "$SDK/bin/prospero-clang" ] || { echo "Error: no SDK at $SDK (run tools/install_sdk.sh first)" >&2; exit 1; }

if [ -f "$SDK/target/lib/libmicrohttpd.a" ]; then
    echo "libmicrohttpd is already installed into $SDK/target/lib; skipping."
    exit 0
fi

export PATH="$SDK/bin:$PATH"
export CC=prospero-clang CXX=prospero-clang++
export AR=prospero-ar NM=prospero-nm RANLIB=prospero-ranlib

MHD_VERSION=1.0.1
CACHE="$ROOT/build/deps/libmicrohttpd-$MHD_VERSION.tar.gz"
mkdir -p "$(dirname "$CACHE")"
if [ ! -f "$CACHE" ]; then
    echo "Downloading libmicrohttpd $MHD_VERSION ..."
    wget -q -O "$CACHE.tmp" "https://ftp.gnu.org/gnu/libmicrohttpd/libmicrohttpd-$MHD_VERSION.tar.gz" \
        && mv "$CACHE.tmp" "$CACHE"
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
tar xf "$CACHE" -C "$WORKDIR"
cd "$WORKDIR/libmicrohttpd-$MHD_VERSION"

./configure --host=x86_64-pc-freebsd12 \
            --disable-shared --enable-static \
            --disable-curl --disable-examples \
            --prefix="$SDK/target"
make -j"$(nproc)"
make install
echo "libmicrohttpd installed into $SDK/target/lib."
