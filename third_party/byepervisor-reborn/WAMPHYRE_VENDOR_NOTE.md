# Wamphyre vendor note — byepervisor-reborn

This directory is the [Byepervisor Reborn](https://github.com/PS5Dev/Byepervisor-Reborn)
source tree, vendored as a plain directory (no submodule), pinned to upstream
commit `ea04f7132b837087f552c57261cb800481a3a910` (2026-10-12).

## Status: vendored as source, NOT shipped in the chain

This payload is **not embedded in the unified autoloader and is never
launched by the default chain**. It was part of the chain in v0.6.6, and
removed after hardware testing, for the reasons below. The source stays
here, inert, so a future release can ship it again once upstream fixes the
problems — nothing else in this repository references or builds it.

## Why it was removed

* **It crashes consoles.** On 13.60 the payload arms (its last line is
  "Hook installed, enter sleep and resume!") and the console then freezes
  and powers off within seconds, before Rest Mode is ever entered. This
  happened on our own test console when loading the payload manually, and
  is reported upstream by other 13.60 users (issues #8, #14 and #15 at the
  time of this writing — all filed after our pinned commit, none resolved).
  Upstream issue #6 shows the same class of failure on a Pro unit (kernel
  trap 12, page fault in kernel mode, as soon as the hook is used).
  A chain step that powers the console off is exactly what this fork
  refuses to do.
* **The chain gate never matched anyway.** The v0.6.6 chain gate compared
  `kernel_get_fw_version()` against `0x0d3c0000` ("13.60" written as hex
  BCD). The kernel actually reports `0x13600000` on 13.60 — as this
  payload's own `kdlsym()` proves (`case 0x13600000:`) — so the chain
  silently skipped the payload on every console it was meant for.
* **Reported side effect.** Upstream issue #16 reports legitimate game
  licences being revoked after using the payload. Until that is understood,
  shipping it automatically is not acceptable for this fork.

Anyone who wants to experiment can still build the payload from this tree
(`PS5_PAYLOAD_SDK=... make`) and send it manually through Payload Manager
— at their own risk, knowing the above.

## The one patch

The only modification to the vendored tree removes the upstream
demonstration write to kernel text: when the payload is re-sent after the
hypervisor is already compromised, upstream writes `0x41414141` into
`ktext(8)` to prove XOM is defeated. A product payload must never edit
kernel code as a side effect, so the write (and its output) is removed —
reading `.text` back is proof enough. Everything else is byte-identical
upstream.

## Known upstream bug to fix before re-adding

`main()` checks `kdlsym(KERNEL_SYM_HV_MP_STARTUP_CALL) == 0`, prints
"Undetected firmware, exiting!" — and then **does not exit**. On a
firmware without an offset table it keeps running with every offset
resolved to 0 and writes to kernel address `0x1000`, an instant kernel
panic. Any future re-introduction should carry an upstream fix for this
(or patch it here).

## Licensing status

The upstream repository ships no top-level license file. The vendored
`Makefile` carries a GPL-3.0 notice (Copyright 2023 John Törnblom), which is
the only explicit license statement in the tree. This payload is vendored in
good faith with full attribution — bug discovered by
[theflow0](https://x.com/theflow0), exploit by the PS5Dev/Byepervisor-Reborn
authors, writeup in [soniciso1/ps5-hv-writeups](https://github.com/soniciso1/ps5-hv-writeups)
— pending an explicit upstream license. Should the upstream authors object,
this directory will be removed on request.

## Firmware coverage

The offset tables cover 13.00, 13.20 and 13.60 (13.00 untested upstream);
the payload self-guards and refuses to run on any firmware without an
exact offset table — except for the missing-exit bug above.
