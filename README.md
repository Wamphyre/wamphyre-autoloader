<p align="center">
  <img src="./assets/icon.svg" width="128" />
</p>
<h1 align="center">PS5 Wamphyre Autoloader</h1>
&nbsp;
<p align="center">One launch from the homescreen and your console is jailbroken<br>with the payloads you use, already running.<br>Supports firmwares <b>7.00&ndash;13.60</b>.</p>

## Why this fork?

**It just works, every time you boot.** Launch the app and walk away: the WebKit and kernel exploits run, and then your payloads load by themselves — no config files, no USB sticks, no PC, no internet. A fresh console goes straight to a working setup.

**Nothing to configure by default.** With no `autoload.txt` anywhere, the autoloader boots a built-in chain, each step spaced 5 seconds apart:

1. **kstuff-lite** — always the latest release from [EchoStretch/kstuff-lite](https://github.com/EchoStretch/kstuff-lite), built in at build time
2. **ShadowMountPlus** — always the latest release from [drakmor/ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus), built in at build time
3. **etaHEN** — vendored in this repository, with its config template installed on first run (built-in **FTP on port 1337**)
4. **[Payload Manager](https://github.com/itsPLK/ps5-payload-manager)** — as the manager UI for everything else

If you prefer your own chain, drop an `autoload.txt` (see below) — creating one always takes over completely.

**It keeps your console alive.** The damage never comes from a failed kernel exploit — it comes from firing a second attempt over a kernel the first run left half-modified. This fork refuses to do that: only failures the exploit itself verifies as clean are retried (up to 3 times, automatically, with a countdown); anything dirty, interrupted or silent demands a reboot instead, and that refusal is remembered until you reboot. Rebooting is always cheaper than a Rebuild Database.

**Fully offline, no third-party DNS.** After a one-time install from your PC, everything is served from the console itself — there is no external server that can go down, change or disappear behind your back.

## Setup

Pick whichever matches your situation:

**Already jailbroken?** Send `installer.elf` to your PS5 with `elfldr`, or launch it from Payload Manager. The installer caches the autoloader page (choose Poops or Relapse if asked), creates the **Wamphyre Autoloader** app on the homescreen, and exits.

**Not jailbroken yet?** Run `wamphyre-autoloader-host.py` from the [Releases](https://github.com/Wamphyre/wamphyre-autoloader/releases) page (or build it: `make host`) on a PC in your network, point your PS5's DNS at that PC, and open **Settings → User's Guide**. The installer runs from there.

Either way: **reboot once**, then launch **Wamphyre Autoloader** from the homescreen.

## Custom payload chain (`autoload.txt`)

Want your own chain instead of the default one?

- Create a `ps5_autoloader` directory with your `.elf`/`.bin` files and an `autoload.txt` listing them, one filename per line (case-sensitive).
- `!1000` lines wait 1000 ms before the next payload.
- Place it on the root of a USB drive or at `/data/ps5_autoloader` (USB wins).

When a config is found, it replaces the default chain completely, and Payload Manager is not launched automatically — add `pldmgr.elf` to your own list if you want it.

<Details>
<Summary><i>What happens before the exploit runs?</i></Summary>

* **One confirmation screen, every launch.** Before anything runs -- the
  WebKit stage included -- the page asks for confirmation with two buttons.
  If the console just booted after a power cut, or it showed the "not turned
  off properly" notice or a Rebuild Database screen, reboot it once before
  continuing: a kernel exploit on a busy, just-rebuilt system is more likely
  to panic, a panic is another improper shutdown, and on a freshly repaired
  filesystem that is the path to a rebuild loop or a reformat.
* **Run remembers, Exit stops.** `Run` starts the exploit and remembers the
  choice for the browser session, so automatic retries never re-ask. `Exit`
  stops there with nothing executed -- at that point no exploit code has run
  at all.
* The kernel-state latch is still checked first: a session that ended dirty
  or was interrupted is refused without asking.

</Details>

<Details>
<Summary><i>What happens if the exploit fails?</i></Summary>

* **Clean failures retry themselves.** If the chain fails without leaving
  anything modified in the kernel — a lost race that cleaned up after itself,
  a wedged WebKit stage before any kernel contact — the page reloads and
  re-runs the chain, up to 3 times per session with a visible countdown. The
  exploit itself has to vouch for the kernel state with an explicit clean
  verdict; silence is never assumed to be clean.
* **Dirty failures demand a reboot.** If the run leaves the kernel modified or
  unverifiable, the page refuses to re-exploit and tells you to reboot. The
  refusal is remembered until the console is rebooted — that second run over
  an unknown kernel is what turns a failed attempt into a crash.
* **Interrupted runs are treated as dirty.** If the page is closed or dies
  while the kernel exploit is in flight, the next launch also refuses.
* **The kernel sweep shows its own progress.** `checking aio groups: 1/3…3/3`
  means the armed AIO groups are being cleared one group at a time — those
  lines prove it is moving, not frozen. Do not power-cycle while they are
  appearing: the sweep is part of the kernel exploit, and interrupting it is
  exactly the scenario the reboot demand exists for. Transient failures of
  the slow kernel window are retried inside the sweep, so a single dropped
  read/write no longer fails the run.
* **Relapse needs a network connection** (Ethernet or Wi-Fi — no Internet
  access required). The autoloader checks this before starting. Poops has no
  such requirement.

</Details>

<Details>
<Summary><i>How do I update?</i></Summary>

Updating is the same as the initial install — follow the **Setup** steps with
the new release files. The installer re-creates the homescreen app and
refreshes the cached page. Your payloads and `autoload.txt` are never touched.

Installing Wamphyre Autoloader also removes the old upstream `WKAL00001` app
automatically, so you always end up with a single shortcut.

</Details>

<Details>
<Summary><i>Using a custom ELF loader</i></Summary>

The autoloader's elfldr only accepts connections from the PS5 itself. If you
want a loader that accepts payloads from any device, load a normal `elfldr`
through Payload Manager, or add it to your `autoload.txt` — with a sleep line
(like `!4000`) right after it if more payloads follow, so it has time to start
listening.

</Details>

## For developers

Test your own WebKit payloads with [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader) (port 9027). The upstream projects are vendored as plain directories under `third_party/` — no submodules.

### Build from source (no Docker)

The release pipeline (`./build_release.sh`) builds in the `wamphyre-autoloader-sdk` Docker image, but everything also builds against a local [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk) (v0.44). The SDK wraps your system LLVM, so the host needs `llvm-config`, `clang` and `lld` (Debian: `apt install llvm-19 clang-19 lld-19`).

```sh
# 1. SDK at /opt/ps5-payload-sdk (the Makefile default; override with SDK=)
sudo unzip ps5-payload-sdk.zip -d /opt && sudo mv /opt/ps5-payload-sdk* /opt/ps5-payload-sdk

# 2. libmicrohttpd 1.0.1 for the PS5 target (same steps as the loader's build_deps.sh)
export PATH="/opt/ps5-payload-sdk/bin:$PATH"
export CC=prospero-clang AR=prospero-ar RANLIB=prospero-ranlib
wget https://ftp.gnu.org/gnu/libmicrohttpd/libmicrohttpd-1.0.1.tar.gz
tar xf libmicrohttpd-1.0.1.tar.gz && cd libmicrohttpd-1.0.1
./configure --host=x86_64-pc-freebsd12 --disable-shared --enable-static \
            --disable-curl --disable-examples --prefix="/opt/ps5-payload-sdk/target"
make install && cd ..

# 3. Build everything. payload-deps fetches the pinned elfldr and Payload
#    Manager plus the LATEST kstuff-lite and ShadowMountPlus, and the unified
#    autoloader ELF is built locally to embed the default chain (etaHEN is
#    vendored in payloads/default/).
BUILD_TYPE=stable make all
```

Run `make test` for the offline checks, `make page` to regenerate the chain pages, `make dev` for a local preview, and see [ARCHITECTURE.md](ARCHITECTURE.md) for the build and cache layout.

## Credits

* **[PLK](https://github.com/itsPLK)** — the upstream [ps5-webkit-autoloader](https://github.com/itsPLK/ps5-webkit-autoloader), [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader), [elfldr](https://github.com/itsPLK/ps5-elfldr), [Payload Manager](https://github.com/itsPLK/ps5-payload-manager) and the unified autoloader this fork is built on
* **[jordyidk](https://github.com/jordyidk)** & contributors — [slopkit (Poops)](https://github.com/jordyidk/slopkit)
* **[soniciso1](https://github.com/soniciso1)**, **[ntfargo](https://github.com/ntfargo)** & contributors — [Relapse](https://github.com/soniciso1/relapse)
* **[EchoStretch](https://github.com/EchoStretch)** & contributors — [kstuff-lite](https://github.com/EchoStretch/kstuff-lite) (default chain)
* **[drakmor](https://github.com/drakmor)** & contributors — [ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus) (default chain)
* The etaHEN authors & contributors — etaHEN (vendored for the default chain)
* **[john-tornblom](https://github.com/john-tornblom)** — [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk/)
* Everyone else contributing to the PS5 homebrew scene.

## Disclaimer

This tool is provided as-is for research and development purposes only. Use at your own risk. The developers are not responsible for any damage, data loss, or consequences resulting from the use of this software.

## License

This project is licensed under the GPL-3.0 License.
