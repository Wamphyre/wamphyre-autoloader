# test/ — experimentation area (not a build input)

This folder carries **wamphyre experiment trees**. Nothing here is used to
build wamphyre-autoloader: the release chain keeps fetching the official
kstuff-lite release at build time (`tools/download_deps.sh`). These trees
exist for manual hardware testing and local experimentation only. Expect
them to be behind or ahead of upstream at any time.

## kstuff-lite/ — FPKG/PKG plaintext support armed on 13.60

A snapshot of [EchoStretch/kstuff-lite](https://github.com/EchoStretch/kstuff-lite)
at commit `48cd2c4` (v1.11-opt) plus one wamphyre patch, applied in the
tree and also kept as [`wamphyre-fpkg1360.patch`](wamphyre-fpkg1360.patch)
for rebasing onto future upstream releases (or opening an upstream PR).

### What the patch does

kstuff's plaintext-package pipeline — the one that makes **installed**
fpkgs launch — is deliberately not armed above firmware 11.60 (upstream
commit `bd8928c`, pending retail validation), which is why on 13.60 an
fpkg installs but does not run (upstream issue #86). The patch opens that
gate for 13.60 only:

```c
if(FWVER > 0x1160 && FWVER != 0x1360)
    return NULL;
```

Everything the armed path needs on 13.60 was verified **statically**
against a live retail 13.60 kernel capture:

* upstream's own `tools/validate_ppr_offsets.py` passes byte-exact: both
  get-index sites and returns, the cleanup E8 deltas `0x12B/0x15B`, the
  clear-key miss, the verifyImage mailbox LR and the `PACKED_STACK_150`
  no-key continuation;
* the verifyImage request layout the interception assumes
  (`req[0]==1`, `req[3]==0x20000`, physical destinations in
  `req[4]/req[6]/req[7]`, sizes in `req[9]`, response status at `+4`) is
  confirmed by disassembly of the same capture.

Runtime behaviour on 13.60 is **not yet hardware-verified** — that is
what this tree is for. On every other firmware the payload behaves
exactly like the official v1.11 (≤11.60 armed as upstream ships it,
12.x unarmed).

### Submodules are plain directories

Vendored without git submodules (the same convention as `third_party/`),
at the commits kstuff-lite pins them to:

* `ps5-kstuff/BearSSL` — `79c060ee` (v0.6-34-g79c060e)
* `ps5-kstuff/isa-l_crypto` — `07d0b253`
* `ps5-kstuff/libtomcrypt` — `b96e96cf` (v1.18.2-734-gb96e96cf)

The nested `.gitignore`/`.gitattributes` are kept on purpose, so local
builds inside this tree do not dirty the wamphyre-autoloader repository.

### Building

* **Via GitHub Actions (no local toolchain):** push this tree to a repo
  of yours (or apply the patch on a fork of kstuff-lite) — the bundled
  `.github/workflows/ci.yml` builds and uploads `kstuff.elf` as an
  artifact. Use `KSTUFF_OBS=1` for the metrics/debug-reader build.
* **Locally:** host `gcc` + `yasm` build the payload; the loader
  (`ps5-kstuff-ldr/kstuff.elf`) additionally needs the
  [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk) — the same
  SDK wamphyre-autoloader already builds with:

  ```sh
  export PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk
  make -C ps5-kstuff-ldr KSTUFF_OBS=1        # or 0 for a release-style build
  ```

  `ci-ps5-kstuff-ldr.sh` expects a real git checkout of kstuff-lite
  (it walks submodule metadata); drive the Makefiles directly here.

### Testing against wamphyre-autoloader (no rebuild needed)

Rename the built loader (e.g. `kstuff-fpkg1360.elf`) and drop it on a
USB stick together with `ps5_autoloader/autoload.txt`:

```text
kstuff-fpkg1360.elf
!5000
shadowmountplus.elf
!5000
etaHEN.elf
!5000
pldmgr.elf
```

A custom chain replaces the default completely (USB wins over
`/data`), so this exercises the patched payload without touching the
autoloader build. Remove the stick and the default chain is back.

### Safety notes

* The interception is **fail-closed**: after accepting a package's
  `PPRPLAIN-NOAUTH!` marker the ShellCore wrapper never falls back to
  the native verifyImage path — on any protocol error it returns
  `EINVAL` (0x80020016), which is exactly today's behaviour (the launch
  fails with an error, never a hang).
* The fake key handles are never registered in the secure-module key
  trees; staging/latches are per-thread, one-shot, with rollback, and a
  reboot clears all state. kstuff writes nothing persistent to disk.
* Worst realistic case on the test console: a kernel panic during the
  fpkg mount → improper shutdown → possible Rebuild Database.
* Test protocol: fresh boot, no game running, `KSTUFF_OBS=1` build,
  single fpkg launch first — watch `ppr_plaintext_hook_stage` progress
  (5 marker accepted → 8 kernel-side CHECK passed → 9 latch armed) and
  the `verify_superblock_emulated` metric — then mount/unmount cycles,
  then regressions (SMP shadow mounts, homebrew, USB installs).
