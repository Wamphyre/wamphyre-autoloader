# Wamphyre vendor note — kstuff 1.15-dr-test3-stable

`kstuff-1.15-dr-test3-stable.elf` is **vendored as a binary**, like
`etaHEN.elf` in this directory. It is not downloaded at build time.

## What it is

- **Payload:** Kstuff Lite 1.15, drakmor's `dr-test3` stable build (the ELF
  prints `Welcome To Kstuff Lite 1.15-dr-test3`).
- **Author:** [drakmor](https://github.com/drakmor), on top of
  [EchoStretch/kstuff-lite](https://github.com/EchoStretch/kstuff-lite) and
  the wider kstuff work by sleirsgoevy, zecoxao, flatz, idlesauce and others.
- **Role in the chain:** first default-chain payload. It provides the kernel
  patches the rest of the chain expects (ShadowMountPlus mounting, etaHEN's
  app jailbreak). etaHEN's own bundled kstuff stays disabled by the config
  template (`[kstuff] autoload=false`), so there is exactly one kstuff.
- **Build traits visible in the ELF:** PPR/resume handling, fPKG scope
  patches, `.ffpkg` support, and 13.60 offset handling.

## Provenance

drakmor published this build as a test binary through the scene (Discord),
not as a GitHub release: at vendoring time `drakmor/kstuff-lite`'s newest
tagged release was still `1.2-dr-test2`. Community testing reported that
Rest Mode works with this build, and the GBAtemp PS5 guide lists the 1.15 DR
line for fPKG use on 12.00&ndash;13.60
([post](https://gbatemp.net/threads/ps5-exploit-guide.613891/post-10955190)).

Because a Discord attachment is not a stable, versioned source, the binary is
committed here so every build of this repository embeds the same bytes and
still works offline.

## Integrity

```
file:    kstuff-1.15-dr-test3-stable.elf
size:    1,927,240 bytes
sha256:  6c3758c2cc84e3aa7e3c41952371fd04e641647d46d03f8d4bea2ab77c16ecf5
```

`tools/download_deps.sh` verifies this hash before staging the binary as
`third_party/ps5-unified-autoloader/payloads/kstuff.elf`; `make payload-deps`
fails rather than embedding a different file. If the binary is ever replaced,
update the hash here and in `tools/download_deps.sh`.

## Updating it

1. Obtain the new ELF from drakmor (or a future tagged release).
2. Replace the file in this directory, keeping the version in its name.
3. Update the `file`, `size` and `sha256` values above and the
   `KSTUFF_VENDORED` / `KSTUFF_SHA256` pair in `tools/download_deps.sh`.
4. Update the chain name in
   `third_party/ps5-unified-autoloader/src/default_chain.c` if the version
   changed, then rebuild with `BUILD_TYPE=stable ./build_release.sh`.
5. Record the change in `CHANGELOG.md`.

## Licensing

The upstream kstuff-lite repositories do not ship a top-level license file at
the time of vendoring. The binary is included in good faith with full
attribution to drakmor and the kstuff contributors; it will be removed on
request from the authors.
