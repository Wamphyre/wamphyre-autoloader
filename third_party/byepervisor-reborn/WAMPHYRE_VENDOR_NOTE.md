# Wamphyre vendor note — byepervisor-reborn

This directory is the [Byepervisor Reborn](https://github.com/PS5Dev/Byepervisor-Reborn)
source tree, vendored as a plain directory (no submodule), pinned to upstream
commit `ea04f7132b837087f552c57261cb800481a3a910` (2026-10-12).

`payloads/default/byepervisor.elf` is **built from this tree** with the PS5
Payload SDK (`PS5_PAYLOAD_SDK=... make`), then stripped and staged for the
unified autoloader to embed — the same treatment etaHEN gets, except the
source is kept here so the binary stays reproducible.

## The one patch

The only modification to the vendored tree removes the upstream demonstration
write to kernel text: when the payload is re-sent after the hypervisor is
already compromised, upstream writes `0x41414141` into `ktext(8)` to prove
XOM is defeated. A product payload must never edit kernel code as a side
effect, so the write (and its output) is removed — reading `.text` back is
proof enough. Everything else is byte-identical upstream.

## Licensing status

The upstream repository ships no top-level license file. The vendored
`Makefile` carries a GPL-3.0 notice (Copyright 2023 John Törnblom), which is
the only explicit license statement in the tree. This payload is vendored in
good faith with full attribution — bug discovered by
[theflow0](https://x.com/theflow0), exploit by the PS5Dev/Byepervisor-Reborn
authors, writeup in [soniciso1/ps5-hv-writeups](https://github.com/soniciso1/ps5-hv-writeups)
— pending an explicit upstream license. Should the upstream authors object,
this directory and the embedded payload will be removed on request.

## Firmware coverage

The offset tables cover 13.00, 13.20 and 13.60. This fork routes only
**13.60** to the payload (the only release marked fully supported upstream;
13.00 is untested there), and the payload additionally self-guards: it
refuses to run on any firmware without an exact offset table.

## What it does in this fork

On firmware 13.60 the default chain launches it **last**, after Payload
Manager, so nothing in the chain ever waits on it: it arms the hypervisor
unlock in the background and tells the user to enter Rest Mode and resume.
Until that Rest Mode round-trip happens, the console behaves exactly as it
always has. After it, XOM/nested-paging protections are gone until the next
full power cycle, and payloads that need real kernel `.text` access work.
