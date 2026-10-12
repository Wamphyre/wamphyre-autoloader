# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [v0.6.2] - 2026-10-12

### Stability & Reliability

* **Explicit cleanup verdicts gate every retry**: a kernel-phase failure is only
  retryable when the payload itself vouched for the kernel state. Poops already
  prints a verdict banner; Relapse now ends every run with one too — `rescue()`
  aggregates the AIO group defuse, the oid restoration, the crossed-pipe
  disarmament and the parked-worker release, and prints exactly one verdict
  line. A failure that says nothing about the kernel state is no longer
  assumed to be clean, so Relapse stops that used to auto-retry over an
  unvouched kernel now demand a reboot instead. Pre-kernel failures (a refused
  prefetch, missing loader hooks) vouch for themselves with "the kernel was
  never touched" and stay retryable.
* **Relapse refuses to escalate over armed AIO groups**: `defuseAioGroups()`
  returns whether the armed waiters were cleared, and `run()` now honours that
  result — a failed defuse stops the exploit before the privilege escalation
  and payload launch instead of carrying on over live waiters. Cleanup errors
  that were only logged (an unrestorable oid state, a pipe buffer that stayed
  crossed, unreleased parked workers, a skipped restoration when the fast
  kernel write path never came up) now feed the verdict: the run is not treated
  as a success, no krw handle is published, nothing is sent over the kernel,
  and the page's latch records it as dirty.
* **A pending watchdog reload can never fire mid-exploit**: a reload the
  pre-kernel watchdog scheduled while the page was silent is cancelled — and
  its spent retry attempt refunded — the moment the kernel payload starts.
  Previously the countdown kept running and could tear down the WebProcess in
  the middle of the kernel race, the one reload this orchestrator exists to
  prevent.
* **A late success cannot rescue a dirty verdict**: success markers no longer
  clear the retry state or record `clean` in the kernel-state latch once a dirty
  marker was seen. Previously a late "Autoload: sent" after a dirty failure
  erased the reboot demand from the latch, and the next launch would re-exploit
  over a kernel the previous run left modified.
* **A payload timeout stops the queue**: the standalone queue's deadline only
  ends the wait, it does not cancel the payload, so an overrun now stops the
  queue with "may still be running" instead of starting the next payload
  alongside one that may still be executing. New regression coverage in
  `tools/test_payload_queue.js`, alongside new orchestrator tests for the
  pending-reload cancellation, the sticky dirty verdict and the
  explicit-verdict retry rule, and upstream selftest coverage for Relapse's
  verdict lines.

## [v0.6.1] - 2026-10-08

### Wamphyre fork

* **Renamed to Wamphyre Autoloader** across the whole project: homescreen app
  (new Title ID `WAMP00001`), installer logs (`[WAMPI]`), artifacts
  (`wamphyre-autoloader-installer_v*.elf`, `wamphyre-autoloader-host_v*.py`),
  SDK docker image, web storage keys (`wamp_exploit`, `wamp_pending`,
  `wamp_kernel_state`, `wamp_rt_count`) and CI workflows. After a successful
  install, the legacy upstream app (`WKAL00001`) is uninstalled automatically,
  and stale legacy installer processes (`wkali.elf`) are killed on startup, so
  an unprotected upstream install can never be launched by accident.
* **New application icon**: a bat silhouette over a blood moon, generated from
  a new master `assets/icon.svg` (`make icons` now also falls back to
  cairosvg when rsvg-convert is unavailable).
* **Vendored upstream trees**: `third_party/` no longer uses git submodules —
  the upstream projects are plain directories in this repository, and
  `tools/download_deps.sh` pins the payload release tag instead of reading it
  from submodule metadata. `.github`, `.gitignore` and the CI workflows were
  restored after the repository move, with the Wamphyre naming applied.

### Stability & Reliability

* **Kernel-state latch (Relapse's missing safety net)**: the page now records each
  run's kernel outcome in sessionStorage — `inflight` while the kernel exploit
  runs, `clean` or `dirty` at the queue summary. A launch that finds `dirty` or
  `inflight` refuses to boot at all and demands a reboot, instead of firing
  Relapse's AIO use-after-free a second time over a kernel the previous run may
  have left half-modified. Rebooting the console clears the latch. Poops has had
  an equivalent latch of its own; Relapse had none.
* **Automatic retry with a safety gate**: the autoloader page now watches its own
  run. Clean failures (nothing left armed in the kernel) reload the page and
  re-run the whole chain automatically, up to 3 times per session with a visible
  countdown; dirty failures refuse to re-exploit and demand a reboot instead —
  re-running the kernel exploit on a half-modified kernel is what turns a failed
  run into a console panic.
* **Pre-kernel watchdog**: a wedged or silent WebKit stage before any kernel
  contact now recovers with an automatic reload instead of freezing on a dead
  page. The kernel stage itself is never interrupted.
* **Relapse network preflight**: Relapse requires a network interface with an
  address for its kernel-base leak. The autoloader now checks this before the
  kernel exploit starts and stops with a clear, non-retryable message when the
  console has no active connection, instead of burning a full exploit attempt
  on a guaranteed failure. Poops works offline and is never asked.
* **elfldr startup window**: the ELF loader check now re-probes briefly instead of
  trusting a single refused connection, so a loader that is still starting up
  is not mistaken for a dead one.
* **ELF transfer retries**: a failed chunk write during autoload is retried before
  the transfer is called off, so a transient hiccup does not waste a successful
  kernel exploit.
* New offline test suites for the retry orchestrator, the kernel-state latch and
  the network preflight (`tools/test_retry_orchestrator.js`), alongside updated
  payload checks.

* **9.05, 11.40 & 11.60**: Added missing offsets to fix Poops support.
  *(Note: Relapse remains unsupported on 9.05 and 11.40)*

## [v0.6.0] - 2026-10-07

### Unified Architecture & Upstream Remote Loader Base
* **Single Shared Base**: WebKit Autoloader is now built on top of [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader), unifying the userland exploit runner, ROP primitives, and payload pipeline across both Poops and Relapse.
* **Developer Iteration & Contributions**: Developers looking to experiment with, test, or improve Poops or Relapse can now do so easily in [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader) by loading payloads over the network (port 9027). Any improvements made in that repo can be contributed upstream to directly benefit both projects.

### Dropped umtx2 (FW <= 5.50)
* **Dropped Legacy umtx2 Support**: Support for firmwares 1.00–5.50 via umtx2 has been dropped in this release. That path was not receiving updates and was blocking development and architectural changes.
* **Future Lower Firmware Support**: Support for lower firmwares may be added back in the future if it is added to [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader). Contributions to bring lower firmware support to the new unified base are welcome!

### Exploit & Stability Improvements
* **Relapse Stability**: Stability and reliability improvements for the Relapse chain.

---
For changelogs of previous releases, see [GitHub Releases](https://github.com/itsPLK/ps5-webkit-autoloader/releases).

