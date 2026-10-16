#!/usr/bin/env bash
# Build the installer ELF (always installer.elf) and the versioned PC setup host.
#
# Prefers the vendored SDK under tools/ps5-payload-sdk (once via
# tools/install_sdk.sh, then tools/build_sdk_deps.sh for libmicrohttpd): its
# wrappers drive the host LLVM, so the machine builds without Docker. The
# Docker SDK image remains the fallback for machines that never installed
# the vendored SDK.
set -euo pipefail
cd "$(dirname "$0")"
if [ "$#" -ne 0 ]; then
    echo "Usage: BUILD_TYPE=stable|dev|pre-release CUSTOM_VERSION=<suffix> ./build_release.sh" >&2
    exit 1
fi
export BUILD_TYPE="${BUILD_TYPE:-dev}"
export CUSTOM_VERSION="${CUSTOM_VERSION:-}"
BUILD_VERSION="$(python3 tools/gen_version.py --print)"
if [ -z "$BUILD_VERSION" ]; then
    echo "Error: Could not compute version" >&2
    exit 1
fi
export BUILD_VERSION
HOST_PY="wamphyre-autoloader-host_v${BUILD_VERSION}.py"
IMAGE_NAME="wamphyre-autoloader-sdk"

# Remove previous versioned release outputs before rebuilding.
rm -f wamphyre-autoloader-installer_v*.elf wamphyre-autoloader-host_v*.py

# The installer keeps its plain name: the version lives inside the binary
# (WAMP_FULL_VERSION) and in the /app/<version>/ cache layout it installs.
# The host build embeds it under a versioned virtual name automatically
# (HOST_PAYLOAD_VIRTUAL in the Makefile).

LOCAL_SDK="$(pwd)/tools/ps5-payload-sdk"
LOCAL_SDK_ARG=""
if [ -x "$LOCAL_SDK/bin/prospero-clang" ]; then
    echo "Building with the vendored SDK at $LOCAL_SDK (no Docker)."
    export WAMP_SDK="$LOCAL_SDK"
    LOCAL_SDK_ARG="SDK=$LOCAL_SDK"
    make clean all $LOCAL_SDK_ARG
elif command -v docker >/dev/null 2>&1; then
    if [ -z "$(docker images -q "$IMAGE_NAME")" ]; then
        docker build -t "$IMAGE_NAME" -f third_party/ps5-webkit-remote-loader/Dockerfile.sdk third_party/ps5-webkit-remote-loader
    fi
    docker run --rm -u "$(id -u):$(id -g)" \
        -e BUILD_VERSION -e BUILD_TYPE -e CUSTOM_VERSION -e WAMP_SDK=/opt/ps5-payload-sdk \
        -v "$(pwd)":/src -w /src "$IMAGE_NAME" make clean all
else
    echo "Error: no vendored SDK at $LOCAL_SDK and Docker is unavailable." >&2
    echo "Run tools/install_sdk.sh once (SDK lands in tools/ps5-payload-sdk)," >&2
    echo "then tools/build_sdk_deps.sh (libmicrohttpd), and retry." >&2
    exit 1
fi

make host HOST_PAYLOAD="installer.elf" $LOCAL_SDK_ARG
mv wamphyre-autoloader-host.py "$HOST_PY"
echo "Built installer.elf and $HOST_PY (Windows .exe is built by GitHub Actions)."
