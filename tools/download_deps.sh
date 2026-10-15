#!/usr/bin/env bash
# Download pinned and latest release assets for the build.
# Assets and verified digest sidecars are cached under build/deps/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Shared elfldr (same ELF across all exploit chains)
ELFLDR_SUBMODULE="$ROOT/third_party/ps5-elfldr"
ELFLDR_REPO="itsPLK/ps5-elfldr"
ELFLDR_TAG="v0.26-bb1e117"
ELFLDR_DEST="$ROOT/build/deps/elfldr.elf"

# Payload Manager, embedded by the unified autoloader as the chain's manager UI
PLDMGR_SUBMODULE="$ROOT/third_party/ps5-unified-autoloader/third_party/ps5-payload-manager"
PLDMGR_REPO="itsPLK/ps5-payload-manager"
PLDMGR_TAG="v0.6.1"
PLDMGR_DEST="$ROOT/build/deps/pldmgr.elf"

# Default-chain payloads (no autoload.txt): always the latest official release
KSTUFF_REPO="EchoStretch/kstuff-lite"
KSTUFF_DEST="$ROOT/build/deps/kstuff.elf"
SMP_REPO="drakmor/ShadowMountPlus"
SMP_DEST="$ROOT/build/deps/shadowmountplus.elf"

# Fetch the pinned release, verify the payload, and download it if needed.
# Exit codes: 0 = asset ready, 3 = already present and verified.
download_release() {
    local repo="$1" tag="$2" dest="$3"
    python3 - "$repo" "$tag" "$dest" <<'PY'
import hashlib
import json
import os
import sys
import time
import urllib.request

repo, tag, dest = sys.argv[1], sys.argv[2], sys.argv[3]
sidecar = dest + ".sha256"  # "<tag> <sha256>" cached after a successful verify


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# Offline fast path: asset + sidecar from a previous successful run.
if os.path.isfile(dest) and os.path.isfile(sidecar):
    with open(sidecar) as f:
        try:
            st_tag, st_hash = f.read().split()
        except ValueError:
            st_tag, st_hash = "", ""
    if st_tag == tag and sha256_of(dest) == st_hash:
        print(f"{os.path.basename(dest)} already present and verified ({tag}).")
        sys.exit(0)
    print("Existing asset does not match the pinned release - re-checking...")


def fetch(url, attempts=5):
    """Fetch a URL, tolerating GitHub's flaky release CDN.

    Two things break urllib against github.com release downloads:
      - http.client adds `Accept-Encoding: identity` when unset, and the asset
        CDN (release-assets.githubusercontent.com) deterministically drops those
        connections. We send `gzip` and decompress by hand.
      - The CDN also intermittently closes connections before responding, so we
        retry with a short backoff.
    """
    import gzip

    last = None
    for i in range(attempts):
        req = urllib.request.Request(url, headers={
            "User-Agent": "wamphyre-autoloader-build",
            "Accept-Encoding": "gzip",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
                if resp.headers.get("Content-Encoding", "").lower() == "gzip":
                    data = gzip.decompress(data)
                return data
        except Exception as exc:
            last = exc
            time.sleep(1 + i)
    raise last


try:
    release = json.loads(fetch(f"https://api.github.com/repos/{repo}/releases/tags/{tag}"))
except Exception as exc:
    print(f"Error: could not fetch release {tag} ({exc})", file=sys.stderr)
    sys.exit(1)

ext = os.path.splitext(dest)[1]
asset = None
for a in release.get("assets", []):
    if a.get("name", "").endswith(ext):
        asset = a
        break
if asset is None:
    print(f"Error: release {tag} has no {ext} asset.", file=sys.stderr)
    sys.exit(1)

digest = asset.get("digest", "")
digest = digest.split(":", 1)[-1] if ":" in digest else digest

# Already downloaded and matching the pinned release? Just cache the digest.
if os.path.isfile(dest) and digest and sha256_of(dest) == digest:
    with open(sidecar, "w") as f:
        f.write(f"{tag} {digest}\n")
    print(f"{os.path.basename(dest)} already present and verified ({tag}).")
    sys.exit(0)

url = asset["browser_download_url"]
print(f"Fetching release metadata for {repo}@{tag}...")
print(f"Downloading {url} ...")
os.makedirs(os.path.dirname(dest), exist_ok=True)
tmp = dest + ".tmp"
try:
    data = fetch(url)
except Exception as exc:
    print(f"Error: download failed ({exc})", file=sys.stderr)
    sys.exit(1)
with open(tmp, "wb") as f:
    f.write(data)

if digest:
    actual = hashlib.sha256(data).hexdigest()
    if actual != digest:
        os.remove(tmp)
        print(f"Error: sha256 mismatch (got {actual}, expected {digest})", file=sys.stderr)
        sys.exit(1)
    print(f"sha256 verified: {actual}")

os.replace(tmp, dest)
with open(sidecar, "w") as f:
    f.write(f"{tag} {digest}\n")
print(f"{os.path.basename(dest)} ready ({tag}): {dest}")
PY
}

# Always the LATEST official release — no tag pinning, by design: the chain
# must carry the newest kstuff-lite and ShadowMountPlus the maintainers
# published. The sidecar caches the tag that was current at download time so
# an up-to-date copy is not re-fetched, and any newer release replaces it.
download_latest() {
    local repo="$1" dest="$2"
    python3 - "$repo" "$dest" <<'PY'
import gzip
import hashlib
import json
import os
import sys
import time
import urllib.request

repo, dest = sys.argv[1], sys.argv[2]
sidecar = dest + ".sha256"  # "<tag> <sha256>" of the last downloaded release


def fetch(url, attempts=5):
    last = None
    for i in range(attempts):
        req = urllib.request.Request(url, headers={
            "User-Agent": "wamphyre-autoloader-build",
            "Accept-Encoding": "gzip",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
                if resp.headers.get("Content-Encoding", "").lower() == "gzip":
                    data = gzip.decompress(data)
                return data
        except Exception as exc:
            last = exc
            time.sleep(1 + i)
    raise last


sha256 = None
if os.path.isfile(dest) and os.path.isfile(sidecar):
    with open(sidecar) as f:
        try:
            tag, sha256 = f.read().split()
        except ValueError:
            tag, sha256 = "", None
    if sha256:
        actual = hashlib.sha256(open(dest, "rb").read()).hexdigest()
        if actual == sha256:
            print(f"{os.path.basename(dest)} already present and verified ({tag}).")
            sys.exit(0)

try:
    release = json.loads(fetch(f"https://api.github.com/repos/{repo}/releases/latest"))
except Exception as exc:
    if sha256:
        print(f"Warning: could not ask GitHub for the latest {repo} release "
              f"({exc}); keeping the cached copy.")
        sys.exit(0)
    print(f"Error: could not fetch the latest {repo} release ({exc}).", file=sys.stderr)
    sys.exit(1)

tag = release.get("tag_name", "")
asset = None
for a in release.get("assets", []):
    if a.get("name", "").endswith(".elf"):
        asset = a
        break
if asset is None:
    print(f"Error: the latest {repo} release ({tag}) has no .elf asset.", file=sys.stderr)
    sys.exit(1)

digest = asset.get("digest", "")
digest = digest.split(":", 1)[-1] if ":" in digest else digest
url = asset["browser_download_url"]
print(f"Downloading the latest {repo} release ({tag}): {url} ...")
os.makedirs(os.path.dirname(dest), exist_ok=True)
tmp = dest + ".tmp"
try:
    data = fetch(url)
except Exception as exc:
    if sha256:
        print(f"Warning: download failed ({exc}); keeping the cached copy.")
        sys.exit(0)
    print(f"Error: download failed ({exc}).", file=sys.stderr)
    sys.exit(1)

if digest and hashlib.sha256(data).hexdigest() != digest:
    print("Error: sha256 mismatch against the release digest.", file=sys.stderr)
    sys.exit(1)

with open(tmp, "wb") as f:
    f.write(data)
os.replace(tmp, dest)
with open(sidecar, "w") as f:
    f.write(f"{tag} {digest or hashlib.sha256(data).hexdigest()}\n")
print(f"{os.path.basename(dest)} ready ({tag}): {dest}")
PY
}

# The vendored trees carry no git metadata of their own; the ELF assets come
# from the official GitHub releases above.

if [ ! -d "$ELFLDR_SUBMODULE" ]; then
    echo "Error: vendored ps5-elfldr sources are missing ($ELFLDR_SUBMODULE)."
    exit 1
fi

if [ ! -d "$PLDMGR_SUBMODULE" ]; then
    echo "Error: vendored ps5-payload-manager sources are missing ($PLDMGR_SUBMODULE)."
    exit 1
fi

download_release "$ELFLDR_REPO" "$ELFLDR_TAG" "$ELFLDR_DEST"
download_release "$PLDMGR_REPO" "$PLDMGR_TAG" "$PLDMGR_DEST"
download_latest "$KSTUFF_REPO" "$KSTUFF_DEST"
download_latest "$SMP_REPO" "$SMP_DEST"

# Stage the default chain for the unified autoloader build: canonical
# lowercase names, because the C generator derives symbol names from them.
# Unchanged files are not re-copied, so incremental builds stay incremental.
STAGE="$ROOT/third_party/ps5-unified-autoloader/payloads"
mkdir -p "$STAGE"
stage() { cmp -s "$1" "$2" 2>/dev/null || cp "$1" "$2"; }
stage "$KSTUFF_DEST" "$STAGE/kstuff.elf"
stage "$SMP_DEST" "$STAGE/smp.elf"
stage "$ROOT/payloads/default/etaHEN.elf" "$STAGE/etahen.elf"
stage "$ROOT/payloads/default/etaHEN-config.ini" "$STAGE/etahen-config.ini"
stage "$PLDMGR_DEST" "$STAGE/pldmgr.elf"
echo "default chain staged in $STAGE"
