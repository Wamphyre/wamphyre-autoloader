# Wamphyre Autoloader architecture

This repository installs an offline homescreen app and bundles a standalone HTML
page built by `third_party/ps5-webkit-remote-loader`. Remote-loader owns WebKit,
firmware offsets, the ROP worker, Poops, Relapse, and the standalone runtime.
It also owns the shared native installer helpers and SDK Docker recipe. This
repository provides `include/installer_config.h` for its app name, title ID,
assets and log prefix. Remote-loader has no dependency on this repository.
The installer has a small exploit chooser and cache progress bar. The exploit
runs directly in the standalone page, without an iframe or generated-code patches.

## Runtime

`tools/build_standalone.py` builds **one standalone page per chain**, and each
page carries three ordinary payloads. The loader first prepares the WebKit memory
primitive and ROP worker, then runs this queue:

1. `elfldr-check.js` connects to `127.0.0.1:9021` without sending data. If a loader
   accepts the connection, it requests `api.stopQueue()`, closes its socket, and
   skips both remaining payloads. A refused connection is re-probed twice more
   (400 ms apart) so a loader that is still starting up is not mistaken for a dead
   one; re-running the kernel exploit over a live loader is the case the check
   exists to prevent. It also receives the chain name as a payload argument; on
   the relapse chain it mirrors upstream's `firstInterfaceAddress()` (via
   `netgetiflist`) and stops with a precise, non-retryable reason when no network
   interface carries an address, because Relapse's KASLR leak hard-fails there
   and the attempt would be wasted. Poops works offline, so the poops chain never
   asks. A refused connection after the short window allows the queue to
   proceed; an unexpected probe or cleanup error stops it instead of retrying a
   kernel exploit blindly. No kernel access is required for this check.
2. `poops.js` (or `relapse.js`) runs unmodified from the vendored upstream payload. It establishes
   kernel access and brings up elfldr/kexp itself on port 9021.
3. `autoload.js` then stages the bundled ELF into an anonymous mapping and streams
   it to elfldr in 64 KiB chunks. A failed chunk write is retried twice (250 ms
   apart) before the transfer is called off, so a transient hiccup does not waste
   the kernel exploit that just succeeded. It selects nothing: the page is
   already built for one chain.

The payload queue runs in order: `[1/3] elfldr-check.js`, `[2/3] poops.js`
(or `relapse.js`), then `[3/3] autoload.js`. Each payload runs directly in the page
context without wrappers.

Relapse ends every run with an explicit cleanup verdict, the equivalent of
poops' own verdict banner (Relapse upstream has none). `run()` checks the
result of the AIO group cleanup before changing privileges: a failed defuse
means armed waiters are still live in the kernel, so the exploit stops instead
of escalating or loading payloads over them. `rescue()` then aggregates every
cleanup step — the AIO defuse, the oid restoration (verified through sysctl
even when the fast kernel write path never came up), the crossed-pipe
disarmament and the parked-worker release — and prints one verdict line:
`Cleanup: verified the kernel state was restored`, or
`Cleanup: did not verify the kernel state: REBOOT the console`. A run whose
cleanup did not verify refuses to publish a krw handle, so the autoload payload
sends nothing, and the page's orchestrator latches it as dirty. Pre-kernel
failures (a refused prefetch, missing loader hooks) vouch for themselves with
`the kernel was never touched`, which keeps them retryable.

The installation flow is choose, then cache:

1. The installer page loads with no `?exploit=`. On firmware that supports both
   chains it shows the prompt, records nothing, and — importantly — registers no
   AppCache handlers, so nothing downloads behind the buttons.
2. The server withholds `manifest="/cache.appcache"` from the entry page until the
   request carries a supported `?exploit=`, because AppCache starts on that
   attribute and JS runs too late to stop it. Firmware with only one chain needs
   no question, so it is served with the attribute immediately.
3. Choosing records `localStorage.wamp_pending` and reloads with the choice. That
   reload is what starts the cache.
4. Once the cache completes, the page checks the `__complete__` marker and calls
   `/install`. Only on success is `wamp_pending` promoted to `wamp_exploit` and
   cleared.

Two keys, so the one the pointer reads means "an install completed". A choice is
never written over the installed one on the way in, so a failed install leaves the
previous autoloader intact and launchable; only a finished `/install` changes what
is installed. This is also what makes "Currently installed: X" in the prompt
truthful rather than "whatever was last clicked".

Both chain pages are cached once caching starts, so switching later costs nothing
and never re-downloads anything.

The server's part is decided strictly per request, from the query string and the
User-Agent, without maintaining server-side state or remembered choices.

**Both chain pages are always cached (~9.4 MB uncompressed).** The cached bytes
therefore do not depend on the choice, so switching chains changes one storage key
and touches nothing in the AppCache — there is no cache to invalidate. This is
deliberate and load bearing: caching both pages at once makes subsequent chain
switches instant and offline, with zero network or cache invalidation risk.

The server's only selection logic is deciding per request whether to include the
`manifest="/cache.appcache"` attribute on `/index.html`. It stores no selection state
in memory or C variables.

The upstream firmware table rejects unsupported firmware before running WebKit.
Supported versions are the remote-loader offset tables in the 7.00–13.60 range.
Poops works without an active network interface; Relapse needs a connected local
network interface, but no Internet access.

## Build

`Makefile` calls the upstream builders without transforming their output:

- `make page`: verify/download dependencies, then call `tools/build_standalone.py`
  once per chain with `payloads/elfldr-check.js`, that chain's exploit, then
  `payloads/autoload.js::<payload_elf>`, plus
  `--elfldr` and `--embed <payload_elf>=<file>`. Outputs: `build/autoloader/{poops,relapse}.html`.
  The exploits are paths into the vendored upstream tree, resolved relative to `third_party/ps5-webkit-remote-loader`.
- `make all`: stage the installer page, stable pointer and generated HTML; generate
  a compressed C registry and AppCache manifest; compile `installer.elf` with the
  PS5 SDK. Both installers compile remote-loader's `installer/common` sources;
  product-specific main loops and HTTP routing stay in their own repositories.
  Docker provides the SDK and libmicrohttpd from remote-loader's Docker recipe.
- `make host HOST_PAYLOAD=<installer.elf>`: build standalone setup pages for both
  chains (Relapse and Poops) embedding that installer, then package them via
  remote-loader's `tools/build_host.py` into `wamphyre-autoloader-host.py`. At runtime,
  the host serves Relapse by default and automatically routes firmwares incompatible
  with Relapse (9.05, 11.40) to Poops.
  Use a versioned ELF path outside the native `installer.elf` target when building
  the host on a machine without the SDK.
- `make dev`: serve the generated chain pages on localhost:8123.
- `make clean`: remove generated pages, registry and unversioned artifacts; retain
  verified downloads in `build/deps/` for offline rebuilds.

`PAGE_CSS` and `PAGE_JS` default to `frontend/autoloader/style.css` and `app.js`,
providing the log panel, progress bar, and status footer on both chain pages and the
PC setup page. The script moves the existing console into the panel and observes
its log lines for progress; it never wraps the exploit or replaces its APIs.
Completion waits for the queue summary, including payload cleanup. An existing
ELF loader is shown as already running, and failures stay visible in the log.
`tools/gen_version.py --page-config` supplies the footer's version and build time
as an inline startup script. No additional network resources are needed.

The same script also runs the **retry orchestrator**. It tracks how far the chain
has progressed from the log lines (pre-kernel, kernel payload, autoload) and
applies one rule above all: never interrupt a kernel exploit in flight, because
tearing down the WebProcess mid-race is an uncontrolled teardown of exactly the
kernel state the exploits carefully put back. What it does instead:

* Before the kernel payload starts, a wedged page (no log output for 90 s, or a
  pre-kernel error with no follow-up for 20 s) reloads automatically — at that
  point nothing has touched the kernel, so a reload is always safe. A reload the
  watchdog scheduled while the page was silent is cancelled — and its spent
  retry attempt refunded — the moment the kernel payload starts, so a countdown
  left over from a quiet WebKit stage can never fire mid-exploit.
* After the queue finishes, a *clean* failure triggers an automatic page reload
  with a visible countdown, up to 3 times per browser session with 5/10/20 s
  backoff — but only when the payload itself left an explicit clean verdict
  (poops' verdict banner and lost-race summary, or Relapse's cleanup verdict,
  which only prints after rescue() verified every restoration). A kernel-phase
  failure without one is treated as dirty: nobody vouched for the kernel state,
  so silence is not cleanliness. Poops' own session latch permits the retry: a
  previous run with a CLEAN verdict clears itself, so the re-run proceeds.
* A *dirty* failure never re-exploits. Log lines that mean the kernel was left
  modified or unverifiable (poops' `REBOOT NOW` verdict and latch refusals,
  cleanup failures, a dead ROP chain, watchdog timeouts, a payload overrun, a
  held krw handle) switch the page to a "Reboot required" state instead: running
  a kernel exploit again on top of a half-modified kernel is what turns a failed
  run into a console panic. The verdict is sticky: even a late
  "Autoload: sent" line cannot turn a dirty run back into a clean one, clear
  the reboot demand, or erase the latch.
* Success markers ("Autoload: sent", an already-running loader) clear the retry
  counter, and a late success even cancels a pending retry countdown — unless
  the run was already dirty, in which case the reboot demand stands.
* A payload that overruns its queue deadline stops the queue instead of moving
  on: the deadline only ends the wait, it does not cancel the payload, so the
  next payload must never start alongside one that may still be executing.

The same script maintains a **kernel-state latch** in sessionStorage — the
page-level equivalent of poops' own session latch, which Relapse lacks. The run
is recorded as `inflight` from the moment the kernel payload starts, and as
`clean` or `dirty` when the queue reports its summary (an "Autoload: sent" line
already proves the kernel exploit finished and put its state back, so it
records `clean` even if the summary never arrives). A page load that finds
`dirty` — the previous run left the kernel modified — or `inflight` — the
previous run was interrupted mid-exploit, so nobody knows the kernel state —
refuses to boot at all: the startup script throws, which is the builder's
documented way to stop the module graph, so the WebKit stage never runs, the
queue never starts, and the page shows a reboot demand instead. sessionStorage
is cleared when the browser session ends, so rebooting the console is exactly
the all-clear the latch waits for. This closes the gap that actually crashes
consoles: firing Relapse's AIO use-after-free a second time over a kernel the
previous run may have left half-modified.

The same script also shows a **launch consent screen** before any of that
starts. The builder awaits each startup script before booting the module
graph, and `frontend/autoloader/app.js` runs at that top level — it carries
no IIFE of its own, because a nested async IIFE would detach from the
builder's await and its rejections would stop nothing. An overlay asks the
user to confirm the launch with `Run` or stop with `Exit`, warning that a
console fresh from a power cut or a Rebuild Database should be rebooted once
first: the kernel races are at their most fragile on a busy, just-rebuilt
system, and a panic there is another improper shutdown for a freshly
repaired filesystem. `Run` records `wamp_launch_consent` in sessionStorage —
one choice per browser session, so the automatic retries never re-ask — and
`Exit` stops boot with the builder's documented startup throw, leaving a
final notice and running nothing at all. The kernel-state latch runs first,
so dirty or interrupted sessions are refused without asking.
`tools/test_retry_orchestrator.js` drives the overlay through the fake DOM
with the page script executed exactly like the builder executes it: Run
stores the choice and the chain proceeds, Exit rejects the startup so
nothing runs, the latch refuses before consent is asked, and a remembered
consent never re-asks.

Override `PAGE_CSS` and `PAGE_JS` to pass other files to the upstream HTML builder.
CSS is embedded after the default styles in the
head. Each JavaScript file runs in its own async function before module boot and
the exploit; use top-level `await` or return a promise for work that must finish
first. Multiple files run in argument order, and startup errors stop boot.

```sh
make page PAGE_CSS=path/to/theme.css PAGE_JS=path/to/setup.js
# Or build the upstream plain console:
make page PAGE_CSS= PAGE_JS=
```

The variables accept whitespace-separated lists of paths relative to the working
directory. Startup scripts can prepare the DOM and share state through `window`;
they have no payload `api`. Inline assets needed during offline startup. This
keeps appearance changes in CSS/JS files here instead of rewriting generated HTML
or changing the exploit sources.

`tools/download_deps.sh` downloads the pinned itsPLK elfldr and Payload Manager
release assets plus the **latest** kstuff-lite and ShadowMountPlus releases,
caching verified digest sidecars in `build/deps/` for offline rebuilds, then
stages the default chain under `third_party/ps5-unified-autoloader/payloads/`.
The unified autoloader ELF is **built locally** (`make autoload-elf`) from the
vendored sources — it is no longer downloaded from an upstream release — so it
can embed the default chain: latest kstuff-lite and ShadowMountPlus, the
vendored etaHEN (`payloads/default/`) with its config template, and Payload
Manager as the manager UI. kexp is the binary bundled by remote-loader. The
vendored trees are plain directories (this fork does not use git submodules):
remote-loader's nested copy of this repository is not a build input.

`build_release.sh` pins `BUILD_VERSION` once across Docker, HTML/cache generation,
and PC host packaging. The installer keeps its plain name, `installer.elf` — the
version lives inside the binary (`WAMP_FULL_VERSION`) and in the
`/app/<version>/` cache layout it installs — while the PC host is written
versioned and the host pages embed the installer under a versioned virtual
name automatically. GitHub Actions also packages the Python host as a
Windows executable.

Remote-loader changes live on `refactor/minimal-autoloader`: `--embed URL=FILE`
adds inline fetch resources, `--elfldr [URL=]FILE` overrides the loader binary without
editing generated HTML, and the host builder accepts `--page` and `--name`.
Its probe verifies embedded file sizes and input digests, including external assets.

The target payload ELF (`ps5-unified-autoloader` for offline autoloader pages, or
the installer ELF for the PC setup host) is embedded via `--embed`.

## Offline installation

The installer serves on `127.0.0.1:18181` only. On dual-chain firmwares, its browser
page prompts the user to select Poops or Relapse before starting caching. Choosing
reloads with `?exploit=<chain>`, allowing the HTTP server to include the manifest
attribute. The page displays AppCache download progress and calls `/install` once
caching completes (`cached`, `noupdate`, or `updateready`). Upon successful install,
`wamp_pending` is promoted to `wamp_exploit` in `localStorage`. The installer validates
the version marker before creating the shortcut. Cache errors leave the installer
running and offer a user-confirmed WebKit-data clear; the native installer then
reopens the browser to retry.

The cache layout is:

```text
/index.html                  installer/cache entry
/logo.svg                    installer logo asset
/cache.appcache              generated manifest
/app/index.html              stable homescreen pointer
/app/<version>/poops.html    chain page: elfldr-check.js, poops.js, then autoload.js
/app/<version>/relapse.html  chain page: elfldr-check.js, relapse.js, then autoload.js
/app/<version>/__complete__  version marker, last in CACHE
```

The pointer checks the marker before navigating, then sends the user to the chain
page they chose, so partial cache downloads cannot start the app. The HTTP server
serves the standalone chain pages verbatim. It withholds the installer's manifest
attribute until a supported choice is present, as described above.

`SIMULATE=1|2` and `tools/build_cache_corruption_test_elfs.sh` are available for
hardware testing of failed-cache repair.

## Verification

`make test-native` runs remote-loader's common native helper tests on Linux (or
inside the SDK container). PS5 services are stubbed and all `/user` filesystem
operations are redirected into a temporary tree. The tests cover installation
and updates with two app configurations, embedded resources, service errors,
notifications, browser launch, foreground-user cleanup, long-log truncation and
raw DEFLATE. Native ELF compilation still uses the PS5 SDK.

`make test` runs the six offline suites. `tools/test_elfldr_check.js` drives the
real check payload through the upstream queue, verifying accepted/refused sockets,
the mid-startup probe window, the Relapse network preflight (including the poops
chain never asking and the check stepping aside without the syscall stub),
descriptor cleanup, and skipping the remaining payloads on a stop or unexpected
probe failure. `tools/test_payload_queue.js` covers the queue's deadline
handling: a payload that overruns its timeout stops the queue instead of
running the next payload alongside one that may still be executing.
`tools/test_autoload_payload.js` covers
the third payload: ELF staging into the mapping, the hand-off to elfldr,
short socket writes, chunk write retries, the missing-`krw` refusal and cleanup on
failure. `tools/test_retry_orchestrator.js` drives the page script through a fake
DOM with a controllable clock: clean failures auto-retry within the budget, every
dirty marker demands a reboot and never reloads, the pre-kernel watchdog recovers a
silent page, the kernel phase is never interrupted (a watchdog reload pending at
the kernel payload's start is cancelled and refunded), a late success never
rescues a dirty verdict, the kernel-state latch gates reloads after dirty and
interrupted runs, and a kernel-phase failure needs an explicit clean verdict to
be retryable. `tools/test_installer.js`
checks the installer's cache events, the marker gate, choice gating in both
orders, error handling, repair confirmation and the pointer.
`tools/test_selection_flow.js` checks that a pick is stored on the origin and that
the pointer routes to the matching chain page, that lone-chain firmware neither
prompts nor leaves the choice unset, and that both chain pages are staged and
cached so a switch never invalidates anything.

Upstream `third_party/ps5-webkit-remote-loader/tools/probe_standalone.js` and
`tools/boot_probe.js` check the generated HTML, inline resources, modules, firmware
offsets and boot order. `SIMULATE=1|2` builds and
`tools/build_cache_corruption_test_elfs.sh` cover failed-cache repair.

None of this can establish exploit reliability; that needs a PS5 hardware run.
