<p align="center">
 <img src="./assets/icon.svg" width="128" />
</p>
<h1 align="center">PS5 Wamphyre Autoloader</h1>
&nbsp;
<p align="center">Automatically loads the WebKit exploit and your elf payloads.<br>Supports firmwares <b>7.00&ndash;13.60</b>.</p>
<p align="center">A hardening fork of PLK's <a href="https://github.com/itsPLK/ps5-webkit-autoloader">ps5-webkit-autoloader</a>:
only failures the exploit itself vouches for are retried; dirty or interrupted runs refuse to re-exploit and demand a reboot.</p>

<p align="center">
    <b>Other Autoloaders:</b><br>
    <a href="https://github.com/itsPLK/ps5-y2jb-autoloader">Y2JB</a> |
    <a href="https://github.com/itsPLK/ps5-bdjb-autoloader">BD-JB</a> |
    <a href="https://github.com/itsPLK/ps5-lua-autoloader">Lua</a>
</p>

## Why Wamphyre Autoloader?

The real purpose of this fork is not convenience — it is keeping your console alive. A failed kernel exploit by itself is harmless: you simply try again. The damage starts when a second attempt is fired over a kernel the first run left half-modified. That is what panics the console, and a panic in the middle of a kernel exploit is what ends in a **Rebuild Database** on the next boot — or, in the worst case, a **full format** that takes your games and saves with it.

Wamphyre Autoloader is built to make that path impossible:

- **It refuses to re-exploit a kernel nobody can vouch for.** Every run is watched and its outcome recorded: only a failure the exploit itself verified as clean — or one that never touched the kernel at all — is retried automatically. Anything dirty, interrupted or silent demands a reboot instead, and that refusal is remembered until you reboot. Rebooting is always cheaper than rebuilding.
- **It never interrupts a kernel exploit mid-flight.** Automatic recovery reloads only happen before the kernel is touched, or after the run has fully finished — never during the race. Even a countdown that was already running is cancelled the moment the kernel stage starts.
- **Fully offline, no third-party DNS.** WebKit exploits are usually loaded by pointing your PS5's DNS at some server hosted by someone on the internet — you're putting your trust in whoever runs that server, and if it goes down, changes, or disappears, your setup breaks. After a one-time install from your PC, everything here is served straight from your PS5: there's nothing external to go down or change behind your back.
- **One-time setup, then a homescreen shortcut.** Once it's installed, you don't need a PC or the internet — just launch "Wamphyre Autoloader" from the homescreen and you're done.
- **A sane default chain out of the box.** With nothing configured, a fresh boot goes straight to a working setup: kstuff-lite and ShadowMountPlus (each always built from the latest official release), then etaHEN with its FTP server on port 1337 and the FPS meter off — and Payload Manager on top as the manager UI.
- **Payloads loaded the way you already know.** After the exploit chain runs, your payloads are sent just like in [Y2JB](https://github.com/itsPLK/ps5-y2jb-autoloader) / [BD-JB](https://github.com/itsPLK/ps5-bdjb-autoloader) / [Lua](https://github.com/itsPLK/ps5-lua-autoloader) autoloaders — via the **default chain** above, or a custom `autoload.txt`.

Exactly how each kind of failure is classified — and which ones retry themselves — is described in *"What happens if the exploit fails?"* below.


## Setup Instructions

There are two ways to set up the autoloader, depending on whether you're already jailbroken.

### Already jailbroken? Just load the installer ELF

1. Download `installer.elf` from the [Releases](https://github.com/Wamphyre/wamphyre-autoloader/releases) page, or build it yourself with `make all` (see [Build from source](#build-from-source-no-docker)).
2. Send it to your PS5 with `elfldr`, or launch it from Payload Manager.
3. The installer opens the browser to cache the autoloader page (choose Poops or Relapse if prompted), creates the **Wamphyre Autoloader** app on the homescreen, and exits.
4. **Reboot once**, then launch **Wamphyre Autoloader** from the homescreen.

### Not jailbroken yet

If you aren't jailbroken yet, you'll need to host the exploit locally on your PC for the initial setup:

1. Download `wamphyre-autoloader-host.py` (or the `.exe`) from the [Releases](https://github.com/Wamphyre/wamphyre-autoloader/releases) and run it on a PC on your network.
2. On your PS5, set your network's DNS server to your PC's IP address.
3. Open the **User's Guide** from Settings to run the installer, which adds the **Wamphyre Autoloader** app to your homescreen.
4. **Reboot once**, then launch **Wamphyre Autoloader** from the homescreen.

## How to Use

There are two ways to configure payloads:

### 🟢 Option 1: The default chain (nothing to configure)

If no `autoload.txt` config is found, the autoloader runs its **built-in default chain** before starting **[Payload Manager](https://github.com/itsPLK/ps5-payload-manager)** — a fully-featured PS5 payload manager with a web UI:

1. **kstuff-lite** — always the latest release from [EchoStretch/kstuff-lite](https://github.com/EchoStretch/kstuff-lite), fetched at build time
2. *5 second settle delay*
3. **ShadowMountPlus** — always the latest release from [drakmor/ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus), fetched at build time
4. *5 second settle delay*
5. **etaHEN** — vendored in this repository (`payloads/default/etaHEN.elf`), with its config template installed on first run (built-in **FTP on port 1337**, **FPS meter off**). An existing `/data/etaHEN/config.ini` is never touched.
6. *5 second settle delay*
7. **Payload Manager** — available as the manager UI for everything else

The default chain only runs when no `autoload.txt` exists anywhere: creating one always takes over completely.

> **Note:** If you also enable Payload Manager's own autoload feature with the same payloads, they will be loaded twice. Pick one place to own your startup chain.

---

### ⚙️ Option 2: Manual Config (`autoload.txt`)

For a fixed, automated payload chain, you can configure payloads manually:

- Create a directory named `ps5_autoloader`.
- Inside this directory, place your `.elf` / `.bin` files, and an `autoload.txt` file.
  - In `autoload.txt`, list the files you want to load, one filename per line.
  - Filenames are case-sensitive — ensure each name exactly matches the file.
  - You can add lines like `!1000` to make the loader wait 1000 ms before sending the next payload.
- Put the `ps5_autoloader` directory in one of these locations (priority order - highest first):
  - Root of a USB drive
  - Internal drive: `/data/ps5_autoloader`

> **Note:** When an `autoload.txt` config is found, Payload Manager is **not** launched automatically. If you also want Payload Manager available, place `pldmgr.elf` in your `ps5_autoloader` directory and add it to `autoload.txt`.

## Additional Info

<Details>
<Summary><i>What happens if the exploit fails?</i></Summary>

The autoloader page watches its own run and reacts to failures:

* **Clean failures retry themselves.** If the chain fails without leaving
  anything modified in the kernel — a lost race that cleaned up after itself,
  a transient transfer error, a wedged WebKit stage before any kernel contact —
  the page reloads automatically and re-runs the whole chain — up to 3 times
  per session, with a visible countdown. The exploit has to vouch for that
  with an explicit clean verdict of its own (both chains print one at the end
  of their cleanup), so a failure that says nothing about the kernel state is
  never assumed to be clean. Most one-off failures resolve here without you
  doing anything.
* **Dirty failures demand a reboot.** If the run leaves the kernel modified or in
  an unknown state (the exploit's own cleanup checks fail, or its verdict says
  so), the page refuses to re-exploit and tells you to reboot instead. This
  refusal is remembered: until the console is rebooted, launching the
  autoloader again shows the same reboot demand instead of firing the kernel
  exploit a second time over a kernel nobody can vouch for — that second run is
  what turns a failed attempt into a crash. A late success message can never
  undo this verdict once the run is dirty.
* **Interrupted runs are treated as dirty.** If the page is closed or dies while
  the kernel exploit is in flight, the next launch also refuses and asks for a
  reboot, because the kernel's state after an interrupted run is unknown. A
  payload that hangs is the same: its queue deadline only ends the wait, so the
  queue stops rather than running the next payload alongside one that may
  still be executing.
* If the page freezes before the kernel stage is ever reached, it recovers
  itself with an automatic reload. Once the kernel stage has started, the page
  never interrupts it — even a reload that was already counting down is
  cancelled the moment the kernel exploit starts.
* **The AIO defuse shows its own progress.** During the kernel stage, the
  `checking aio groups: 1/3…3/3` lines mean the armed AIO groups are being
  swept and cleared one group at a time — the sweep can take a few seconds
  per group and those lines are what proves it is moving, not frozen. Do not
  power-cycle the console while they are appearing: the sweep is part of the
  kernel exploit, and interrupting it is exactly the unknown-kernel-state
  scenario the reboot demand exists for. Transient failures of the slow
  kernel window are retried inside the sweep, so a single dropped read/write
  no longer fails the run.
* **Relapse needs a network connection** (Ethernet or Wi-Fi — no Internet
  access required): its kernel-base leak uses a local network interface. The
  autoloader checks this before starting and tells you clearly if it is
  missing, instead of failing with a cryptic error mid-run. Poops has no such
  requirement.

</Details>

<Details>
<Summary><i>How to update the autoloader?</i></Summary>

The autoloader content is cached on the console, so updating is exactly the same as the initial install. Simply follow the **[Setup Instructions](#setup-instructions)** using the new release files. 

The latest installer payload will re-create the homescreen app and refresh the cached page for you. Your payloads and `autoload.txt` on USB / internal storage are never touched.

**Coming from the upstream WebKit Autoloader?** Installing Wamphyre Autoloader removes the old `WKAL00001` app automatically after the new one is installed, so you are always left with a single, protected shortcut.
</Details>

<Details>
<Summary><i>How to use a custom ELF Loader?</i></Summary>

The autoloader uses a custom version of **elfldr** that only accepts connections from the PS5 itself (localhost). This improves security by preventing unauthorized devices on your network from sending payloads to your console.

If you want to use a "normal" ELF Loader that allows sending payloads from any device, you can simply load it through **Payload Manager**.

Alternatively, if you are using a manual config file (`autoload.txt`):
1. Place your custom ELF Loader (e.g. `elfldr.elf`) in the `ps5_autoloader` directory.
2. Add `elfldr.elf` to your `autoload.txt`.
3. **Note**: If you are loading other payloads right after `elfldr.elf` in your `autoload.txt`, add a sleep command immediately after it (like `!4000` to sleep for 4 seconds) to give the new ELF Loader time to start up and listen before subsequent payloads are sent.

Example `autoload.txt`:
```text
# Load custom ELF Loader
elfldr.elf
# Give it 4 seconds to start up (only needed if sending more payloads)
!4000
# Send other payloads
etaHEN.elf
```
</Details>

---

## For developers

If you want to create or test your own WebKit payloads, check out [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader), which this project is based on. It lets you send and run JavaScript payloads directly over the network on port 9027.

The upstream projects this fork builds on (`ps5-webkit-remote-loader`, `ps5-elfldr`, `ps5-unified-autoloader`) are **vendored as plain directories** under `third_party/` — there are no git submodules to initialise.

### Build from source (no Docker)

The release pipeline (`./build_release.sh`) builds inside the
`wamphyre-autoloader-sdk` Docker image, but everything also builds directly
against a local [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk)
(v0.44 was used for the current binaries). The SDK is a set of wrappers around
your system's LLVM, so the host needs `llvm-config`, `clang` and `lld`
(Debian: `apt install llvm-19 clang-19 lld-19`).

```sh
# 1. Get the prebuilt SDK and unzip it at /opt/ps5-payload-sdk (the Makefile
#    default; override any target with SDK=/path/to/ps5-payload-sdk)
sudo unzip ps5-payload-sdk.zip -d /opt && sudo mv /opt/ps5-payload-sdk* /opt/ps5-payload-sdk

# 2. Build libmicrohttpd 1.0.1 for the PS5 target (same steps as the loader's build_deps.sh)
export PATH="/opt/ps5-payload-sdk/bin:$PATH"
export CC=prospero-clang AR=prospero-ar RANLIB=prospero-ranlib
wget https://ftp.gnu.org/gnu/libmicrohttpd/libmicrohttpd-1.0.1.tar.gz
tar xf libmicrohttpd-1.0.1.tar.gz && cd libmicrohttpd-1.0.1
./configure --host=x86_64-pc-freebsd12 --disable-shared --enable-static \
            --disable-curl --disable-examples --prefix="/opt/ps5-payload-sdk/target"
make install && cd ..

# 3. Build everything. `make all` first runs payload-deps, which fetches the
#    pinned elfldr and Payload Manager plus the LATEST kstuff-lite and
#    ShadowMountPlus releases, then builds the unified autoloader ELF locally
#    so it embeds the default chain (etaHEN is vendored in payloads/default/).
BUILD_TYPE=stable make all
```

Release-style artifacts with pinned versions:

```sh
export BUILD_VERSION="$(python3 tools/gen_version.py --print)"
make clean && BUILD_TYPE=stable make all SDK="$HOME/ps5-payload-sdk"
mv installer.elf "wamphyre-autoloader-installer_v${BUILD_VERSION}.elf"
make host HOST_PAYLOAD="wamphyre-autoloader-installer_v${BUILD_VERSION}.elf" SDK="$HOME/ps5-payload-sdk"
mv wamphyre-autoloader-host.py "wamphyre-autoloader-host_v${BUILD_VERSION}.py"
```

Run `make test` for the offline checks (payload, queue, orchestrator, installer,
and exploit-selection flow), `make page` to regenerate the standalone chain pages,
and `make dev` for a local page preview. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the build and cache layout.

## Credits

* **[jordyidk](https://github.com/jordyidk)** & contributors — [slopkit (Poops)](https://github.com/jordyidk/slopkit)
* **[soniciso1](https://github.com/soniciso1)**, **[ntfargo](https://github.com/ntfargo)** & contributors — [Relapse](https://github.com/soniciso1/relapse)
* **[EchoStretch](https://github.com/EchoStretch)** & contributors — [kstuff-lite](https://github.com/EchoStretch/kstuff-lite) (default chain)
* **[drakmor](https://github.com/drakmor)** & contributors — [ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus) (default chain)
* The etaHEN authors & contributors — etaHEN (vendored for the default chain)
* **[john-tornblom](https://github.com/john-tornblom)** — [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk/) and [elfldr](https://github.com/ps5-payload-dev/elfldr)
* See [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader) for runtime and toolchain credits.
* Everyone else contributing to the PS5 homebrew scene.


## Disclaimer

This tool is provided as-is for research and development purposes only. Use at your own risk. The developers are not responsible for any damage, data loss, or consequences resulting from the use of this software.

## License

This project is licensed under the GPL-3.0 License.

## Donate
- [donate to PLK](DONATE.md)

