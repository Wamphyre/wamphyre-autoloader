#!/usr/bin/env bash
# Build the versioned installer ELF and standalone PC setup host.
set -euo pipefail
cd "$(dirname "$0")"
if [ "$#" -ne 0 ]; then
    echo "Usage: BUILD_TYPE=stable|dev|pre-release CUSTOM_VERSION=<suffix> ./build_release.sh" >&2
    exit 1
fi
BUILD_VERSION="$(python3 tools/gen_version.py --print)"
if [ -z "$BUILD_VERSION" ]; then
    echo "Error: Could not compute version" >&2
    exit 1
fi
export BUILD_VERSION
OUTPUT_ELF="wamphyre-autoloader-installer_v${BUILD_VERSION}.elf"
HOST_PY="wamphyre-autoloader-host_v${BUILD_VERSION}.py"
IMAGE_NAME="wamphyre-autoloader-sdk"

# Remove previous versioned release outputs before rebuilding.
rm -f wamphyre-autoloader-installer_v*.elf wamphyre-autoloader-host_v*.py

if [ -z "$(docker images -q "$IMAGE_NAME")" ]; then
    docker build -t "$IMAGE_NAME" -f third_party/ps5-webkit-remote-loader/Dockerfile.sdk third_party/ps5-webkit-remote-loader
fi
docker run --rm -u "$(id -u):$(id -g)" \
    -e BUILD_VERSION -e "BUILD_TYPE=${BUILD_TYPE:-dev}" -e "CUSTOM_VERSION=${CUSTOM_VERSION:-}" \
    -v "$(pwd)":/src -w /src "$IMAGE_NAME" make clean all
mv installer.elf "$OUTPUT_ELF"
make host HOST_PAYLOAD="$OUTPUT_ELF"
mv wamphyre-autoloader-host.py "$HOST_PY"
echo "Built $OUTPUT_ELF and $HOST_PY (Windows .exe is built by GitHub Actions)."
