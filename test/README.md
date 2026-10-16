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

On every other firmware the payload behaves exactly like the official
v1.11 (≤11.60 armed as upstream ships it, 12.x unarmed).

### First 13.60 hardware run — launch phase reached, launch still blocked

First runtime results on a real retail 13.60 console (the purpose of
this tree), recorded against the tree's first artifact build
(`9631144d…00f8c`, an OBS=0 build — see the artifact section below for
why it produced no trace):

* The historical wall is gone. Launching a plaintext fpkg drives
  ShellCore into the launch phase — the console reaches the system
  "wait a moment" loading screen. Before the patch, 13.60 installed the
  package but the launch never began (the upstream-#86 state: a fast,
  clean mount failure). Every failure inside the staging path (marker,
  CHECK, ARM, verifyImage emulation) fails fast inside
  `sceFsMountPprPkg` — that is what the fail-closed wrapper
  guarantees — so a launch attempt starting at all is consistent with
  the whole armed pipeline having run. Only the
  `ppr_plaintext_hook_stage` 5→8→9 trace plus the `PPRVIM7`/`PPRKIDX1`
  word-log markers can turn that into proof.
* The launch never completes: it stays on the loading screen. Two
  candidate locations: the nmount wedged inside the kernel (the
  plaintext block-read path is the first code the static 13.60
  validation does not cover), or the mount completed and the wedge is
  downstream (process spawn / later mailbox or self-verification path).
* Backing out of the wedged launch and starting a different game or a
  homebrew crashes the console. The kernel-side session is designed for
  one lifecycle: when `sceFsMountPprPkg` returns, the wrapper CLEARs the
  latch and releases the retained key pair. If the call never returns —
  the wrapper's `.abort_protocol` only covers protocol errors before
  the native mount runs — the armed/active session, the staged data and
  the fake-XTS/CMAC pair live past the wedge, and the next launch is the
  first one to mount over that state. A launch cancelled while wedged
  has never been exercised in this tree before this run; locating
  where the panic fires (which subsystem) is part of the next capture.
* Next capture (KSTUFF_OBS=1 build + debug-reader):
  * after the stuck launch — `ppr_plaintext_hook_stage` (expect 9),
    `verify_superblock_emulated`, `crypto_requests_emulated` and the
    last `PPRMBX33`/`PPRMBX32`/`PPRVIM7`/`PPRKIDX1` log words. A rising
    `crypto_requests_emulated` with the session already ACTIVE means the
    mount kept streaming plaintext reads (nmount wedged mid-way); a
    quiesced state after emulated reads means the mount completed and
    the wedge is downstream.
  * before the crash-triggering second launch — the retained-pair and
    latch state, to confirm the mode-0 CLEAR never ran.
  * the crash flow itself: which of the two launches' leftovers map to
    panic — gdb_stub attachment during the first stuck launch would
    remove the guesswork.

### Submodules are plain directories

Vendored without git submodules (the same convention as `third_party/`),
at the commits kstuff-lite pins them to:

* `ps5-kstuff/BearSSL` — `79c060ee` (v0.6-34-g79c060e)
* `ps5-kstuff/isa-l_crypto` — `07d0b253`
* `ps5-kstuff/libtomcrypt` — `b96e96cf` (v1.18.2-734-gb96e96cf)

The nested `.gitignore`/`.gitattributes` are kept on purpose, so local
builds inside this tree do not dirty the wamphyre-autoloader repository.

### Building (local only — no cloud build)

The payload needs host `gcc`, `yasm` and `nasm`; the loader additionally
needs the [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk) —
the same SDK wamphyre-autoloader already builds with. The SDK tarball
(`ps5-payload-dev.tar.gz` from the pacbrew repo) extracts anywhere;
`toolchain/prospero.mk` locates itself, so `PS5_PAYLOAD_SDK` can point
at any directory. `yasm`/`nasm` install fine without root by unpacking
the distro debs into a local prefix (`apt-get download yasm nasm` +
`dpkg -x`, then prepend `usr/bin` to `PATH`).

Two loader dependencies are not in the stock SDK — `-lz` and
`-lsqlite3` (the ShellCore DB-trigger patch does real sqlite work) —
so both need one cross-compile into the SDK target prefix (the same
treatment the main repo documents for libmicrohttpd):

```sh
# zlib 1.3.1 (core objects only; no extensions needed)
export PATH=/opt/ps5-payload-sdk/bin:$PATH
for f in adler32 compress crc32 deflate inffast inflate inftrees \
         trees uncompr zutil; do prospero-clang -O2 -DNDEBUG -c $f.c; done
prospero-ar rcs libz.a {adler32,compress,crc32,deflate,inffast,inflate,inftrees,trees,uncompr,zutil}.o
cp libz.a /opt/ps5-payload-sdk/target/lib
cp zlib.h zconf.h /opt/ps5-payload-sdk/target/include

# sqlite 3.54.0 amalgamation, built for the PS5 target
prospero-clang -Os -DNDEBUG -DSQLITE_THREADSAFE=0 \
  -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_OMIT_DEPRECATED \
  -DSQLITE_OMIT_RANDOMNESS -DSQLITE_MAX_EXPR_DEPTH=0 -c sqlite3.c
prospero-ar rcs libsqlite3.a sqlite3.o
cp libsqlite3.a /opt/ps5-payload-sdk/target/lib
cp sqlite3.h    /opt/ps5-payload-sdk/target/include

export PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk
export PATH=/path/to/yasm-nasm-bin:$PATH
# KSTUFF_OBS must stay exported on the whole build: the loader's .FORCE
# rule re-runs `make -C ../ps5-kstuff/` and, with the flag dropped, the
# embedded payload silently flips back to the uninstrumented build.
export KSTUFF_OBS=1
make -C ps5-kstuff KSTUFF_OBS=1       # payload.bin (builds BearSSL + isa-l too)
make -C ps5-kstuff KSTUFF_OBS=1 debug-reader.bin  # state dumper for testing
make -C ps5-kstuff-ldr KSTUFF_OBS=1   # -> ps5-kstuff-ldr/kstuff.elf
```

`KSTUFF_OBS=1` builds the instrumented variant (metrics + debug
reader); it is required for any capture run, and the committed
artifact is (since the second build) exactly that instrumented build.
`ci-ps5-kstuff-ldr.sh` expects a real git checkout of
kstuff-lite — drive the Makefiles directly here.

The artifact at the root of this folder,
**`kstuff-lite-fpkg1360.elf`**, is the OBS=1 loader built from this
exact tree — loader+payload in one file, all seven word-log
immediates (`PPRARM08`, `PPRMBX33`/`32`, `PPRVIM7`, `PPRKIDX1`,
`PPRPUT01`, `PPRCLR01`) verified present — sha256
`3a3203a4de883d6b80564b480424a4d74fa6b07bb1227fa2d8ce565d2bbfb1c5`.
It replaces the first tracked build
(`9631144d07f77c8be051faf3d5a036e17710427e5883dab492f0009369200f8c`),
an OBS=0 build whose single hardware run — the entry in the hardware
section above — is the only result this earlier binary produced.
Unlike the intermediate build outputs (kept out of git by the nested
ignore), the artifact itself is committed: it is the exact binary the
13.60 hardware tests run, and tracking it ties every test result to
one reproducible input. A rebuilt replacement shows up as a normal
modification — tracked files are unaffected by the `*.elf` ignore.
After each capture run, send `ps5-kstuff/debug-reader.bin` (kept next
to `payload.bin`, untracked) to dump the metrics snapshot and the
word log; that is where the `ppr_plaintext_hook_stage` trace and the
`PPR*` words listed above come from.

### Testing against wamphyre-autoloader (no rebuild needed)

Take `kstuff-lite-fpkg1360.elf` (the artifact at the root of this
folder — the OBS=1 build) and drop it on a USB stick together with
`ps5_autoloader/autoload.txt`. For a capture run, keep the chain
minimal so the only consoles talking to the kernel are kstuff and the
autoloader:

```text
kstuff-lite-fpkg1360.elf
```

Then launch the fpkg, try to exit the wedged launch — and send
`ps5-kstuff/debug-reader.bin` (untracked; built by
`make -C ps5-kstuff KSTUFF_OBS=1 debug-reader.bin`) right after, from
Payload Manager or etaHEN, and save the dump before the next
troubleshooting step. For regression runs once the capture is
understood, the full chain documents both the patched payload and how
it coexists with the rest:

```text
kstuff-lite-fpkg1360.elf
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
