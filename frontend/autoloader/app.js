// Presentation + reliability layer: runs through the standalone builder's
// awaited --js hook. Keep the actual console, payloads and exploit in this
// document.
//
// Retry orchestrator: the payload queue runs exactly once per page load. This
// script watches the same log lines it uses for the progress bar and, when a
// run fails *cleanly* (nothing armed in the kernel, no verdict demanding a
// reboot), reloads the page so the whole chain re-runs without a manual
// reload. When a failure leaves the kernel modified or in an unknown state it
// refuses to re-exploit and asks for a reboot instead: re-running a kernel
// exploit on top of a half-modified kernel is what turns a failed run into a
// console panic. It also watches for a wedged WebKit stage (no log output
// before any kernel contact) and recovers that with a reload too.
//
// Kernel-state latch: the same log watching records each run's outcome in
// sessionStorage ('inflight' while the kernel payload runs, 'clean' or 'dirty'
// at the queue summary). Relapse has no latch of its own -- poops does -- so
// the page provides one for both chains: a load that finds 'dirty' or
// 'inflight' refuses to boot at all and demands a reboot, because firing the
// kernel exploit again over an unknown kernel state is the classic crash.
// Rebooting the console clears sessionStorage, which is exactly the all-clear.
//
// Hand-over honesty: if the autoload transfer died part-way, the loader stays
// up with nothing loaded. The failed run is remembered in sessionStorage too
// ('wamp_elf_partial'), and the next load's "already running" stop then says
// the truth -- reboot required, nothing was loaded -- instead of the old
// "Nothing to do", which stood next to a loader holding a port no reload
// could ever deliver into. A delivered autoload clears the marker.
//
// Launch consent: the builder awaits this file before booting the module
// graph, so nothing runs -- not even the WebKit stage -- until it finishes.
// That wait is used for one informed-choice screen: an overlay asks the user
// to confirm the launch, warning that a console fresh from a power cut or a
// Rebuild Database should be rebooted once first (a kernel panic there is
// another improper shutdown, and on a freshly repaired filesystem that is
// the path to a rebuild loop or a reformat). Run remembers the choice for
// the browser session, so the automatic retries never re-ask; Exit stops the
// boot with the builder's documented throw, leaving a final notice in place
// of the buttons. The latch above runs first, so a dirty or interrupted
// session is refused without asking.
//
// This file runs as one of the builder's awaited startup scripts: its top
// level IS the async function the builder wraps it in, which is why there is
// no IIFE around it -- a nested async IIFE would detach from the builder's
// await, and its rejections would stop nothing. Top-level `await` suspends
// the builder until the choice is made; a top-level `throw` rejects it and
// is the documented way to refuse boot; a top-level `return` exits cleanly
// (the loader guard below uses exactly that).
'use strict';
var output = document.getElementById('console');
if (!output || document.getElementById('loader')) return;

function element(tag, id, parent, text) {
  var node = document.createElement(tag);
  node.id = id;
  if (text) node.textContent = text;
  parent.appendChild(node);
  return node;
}

var loader = element('main', 'loader', document.body);
var wrapper = element('div', 'logWrapper', loader);
wrapper.appendChild(output);
var progress = element('div', 'progressContainer', loader);
progress.setAttribute('role', 'progressbar');
progress.setAttribute('aria-valuemin', '0');
progress.setAttribute('aria-valuemax', '100');
var bar = element('div', 'progressBar', progress);
var label = element('div', 'progressLabel', progress);
var config = window.WAMP_PAGE || {};
if (config.version) {
  document.title = 'Wamphyre Autoloader v' + config.version + ' by Wamphyre' +
    (config.buildTime ? ' (built ' + config.buildTime + ')' : '');
}
var footer = element('div', 'footer', document.body);
element('div', 'buildInfo', footer, 'Wamphyre Autoloader' +
  (config.version ? ' v' + config.version : '') + ' by Wamphyre' +
  (config.buildTime ? ' (built ' + config.buildTime + ')' : ''));
var source = element('div', 'sourceInfo', footer, 'Wamphyre Autoloader, a fork of PLK\'s WebKit Autoloader: ');
var link = element('a', 'sourceLink', source, 'github.com/Wamphyre/wamphyre-autoloader');
link.href = 'https://github.com/Wamphyre/wamphyre-autoloader';

var percent = 0;
var finished = false;
var sent = false;
var elfFailed = false; // this run already failed to hand over the autoload
function update(next, message, state) {
  percent = Math.max(percent, next);
  bar.style.width = percent + '%';
  label.textContent = message;
  progress.setAttribute('aria-valuenow', String(percent));
  progress.setAttribute('aria-valuetext', message);
  progress.setAttribute('data-state', state || 'running');
}
update(0, 'Starting WebKit exploit...');

// ===================== retry orchestrator =====================
// Phases: boot -> webkit -> userland -> kernel -> post. A reload is only
// ever automatic before the kernel payload starts or after the queue has
// fully finished; never while a kernel exploit is in flight, because
// tearing down the WebProcess mid-race is exactly the uncontrolled teardown
// the exploits try to avoid.
var MAX_RETRIES = 3;
var BACKOFF_SECONDS = [5, 10, 20];
var RETRY_KEY = 'wamp_rt_count';
var KERNEL_STATE_KEY = 'wamp_kernel_state';
var ELF_PARTIAL_KEY = 'wamp_elf_partial';
var WATCHDOG_MS = 90000;  // pre-kernel log silence before an automatic reload
var PRE_ERROR_MS = 20000; // a pre-kernel error with no follow-up before a reload

var phase = 'boot';
var terminal = false;    // the queue reported a summary or a stop
var dirty = false;       // the kernel may be modified: never re-exploit
var cleanVerdict = false; // the payload itself vouched for the kernel state
var locked = false;       // the gate refused this boot: the display is final
var lastLineAt = Date.now();
var lastErrorAt = 0;
var reloadTimer = null;
var countdownEnd = 0;

// Lines that mean the kernel was left modified or unverifiable. Only
// counted from the kernel payload onward; before it, nothing has touched
// the kernel and any error is a safe candidate for a retry.
var DIRTY_PATTERNS = [
  /reboot now/i,
  /reboot the console/i,
  /cleanup[: ]+failed/i,
  /aio cleanup failed/i,
  /aio groups did not defuse/i,
  /oid restore check failed/i,
  /pipe buffer was not cleared/i,
  /leaving both armed/i,
  /could not release aio workers/i,
  /current process unavailable/i,
  /the rop chain died/i,
  /chain is unusable/i,
  /no reply from the rop worker/i,
  /left no verdict/i,
  /latch is already held/i,
  /already holds a krw handle/i,
  /has run for \d+s and has not returned/i
];

// Lines where the payload itself vouched for the kernel state after the
// kernel payload started: poops' verdict banner and its lost-race summary
// (poops records a CLEAN verdict of its own in exactly those cases), and
// Relapse's cleanup verdict, which only prints after rescue() verified
// every restoration. A kernel-phase failure without one of these lines is
// dirty: nobody vouched for the kernel, so silence is not cleanliness.
var CLEAN_PATTERNS = [
  /cleanup reported clean/i,
  /nothing was claimed/i,
  /verified the kernel state was restored/i,
  /the kernel was never touched/i
];

function storageWorks() {
  try {
    sessionStorage.setItem(RETRY_KEY + '_probe', '1');
    sessionStorage.removeItem(RETRY_KEY + '_probe');
    return true;
  } catch (error) {
    return false;
  }
}
var canStore = storageWorks();

// Kernel-state latch, the page-level equivalent of poops' session latch.
// Relapse has no latch of its own: after a dirty run, or after the page dies
// mid-exploit, a fresh load would fire the AIO use-after-free again over a
// kernel whose state nobody knows -- the classic path from a failed run to
// a console panic. The latch records the run's outcome in sessionStorage,
// which the browser clears when the app closes or the console reboots, so
// "reboot the console" is exactly what clears it.
function noteKernelState(value) {
  try { sessionStorage.setItem(KERNEL_STATE_KEY, value); } catch (error) {}
}

// Pre-boot gate: the previous run in this browser session left the kernel
// modified, or was interrupted while the kernel exploit was in flight.
// Refuse to boot at all -- the WebKit stage never runs, the queue never
// starts -- and stop the module graph by throwing, which is the builder's
// documented way for a startup script to refuse.
if (canStore) {
  var previousKernelState = null;
  try { previousKernelState = sessionStorage.getItem(KERNEL_STATE_KEY); } catch (error) {}
  if (previousKernelState === 'dirty' || previousKernelState === 'inflight') {
    locked = true;
    terminal = true;
    finished = true;
    var kernelWhy = previousKernelState === 'dirty'
      ? 'the previous run left the kernel modified or unverifiable'
      : 'the previous run was interrupted while the kernel exploit was in flight';
    // A warn-class line documents the refusal in the log; the display is
    // already final, so the observer must not rewrite it (readLine checks
    // locked first).
    var refusal = document.createElement('div');
    refusal.className = 'log-line log-warn';
    refusal.textContent = '[!] Reboot required: ' + kernelWhy +
      '. Running the kernel exploit again before a reboot is how a failed run turns into a crash.';
    output.appendChild(refusal);
    update(0, 'Reboot required: ' + kernelWhy +
      '. Reboot the console, then launch the autoloader again.', 'error');
    throw new Error('reboot required: ' + kernelWhy);
  }
}

// ===================== launch consent =====================
// The one screen shown before anything runs: the module graph has not
// booted, so nothing has touched the kernel or the WebKit stage. A console
// that just went through a power cut or a Rebuild Database is a busy,
// recovering system -- the kernel races are at their most fragile there,
// a kernel panic is another improper shutdown, and on a freshly repaired
// filesystem that is the path to a rebuild loop or a reformat. Ask once per
// browser session: the automatic retries reload the page, and a reload
// that asked again would break the countdown the verdict system armed.
var CONSENT_KEY = 'wamp_launch_consent';
var consented = false;
if (canStore) {
  try { consented = sessionStorage.getItem(CONSENT_KEY) === '1'; } catch (error) {}
}
if (!consented) {
  update(0, 'Confirm the launch...');
  var launchChoice = await askLaunchConsent();
  if (launchChoice !== 'run') {
    update(0, 'Not launched. Nothing has run -- reboot the console first ' +
      'if it just went through a power cut or a database rebuild, then ' +
      'launch the autoloader again.', 'stopped');
    throw new Error('launch declined: the user stopped the exploit before it started');
  }
  try { sessionStorage.setItem(CONSENT_KEY, '1'); } catch (error) {}
  // The overlay may have been up for minutes; the liveness clock must not
  // read that silence as a wedged page the moment boot starts.
  lastLineAt = Date.now();
  lastErrorAt = 0;
  update(0, 'Starting WebKit exploit...');
}

// The consent overlay. Run resolves 'run' and the caller remembers the
// choice for this browser session; Exit resolves 'exit' and leaves a final
// notice in place of the buttons -- the caller then stops the boot with the
// builder's documented throw, so the module graph (and the exploit with
// it) never runs. The overlay sits above everything and waits for as long
// as the user needs: no watchdog is armed yet, so nothing can reload the
// page out from under the question.
function askLaunchConsent() {
  return new Promise(function (resolve) {
    var overlay = element('div', 'consentOverlay', document.body);
    var panel = element('div', 'consentPanel', overlay);
    element('h2', 'consentTitle', panel, 'Before the exploit runs');
    element('p', 'consentRebootLine', panel,
      'If this console just booted after a power cut, or it showed the ' +
      '"not turned off properly" notice or a Rebuild Database screen, ' +
      'reboot it once before continuing. A kernel exploit on a busy, ' +
      'just-rebuilt system is more likely to panic, a panic is another ' +
      'improper shutdown, and on a freshly repaired filesystem that can ' +
      'end in a rebuild loop or a reformat.');
    element('p', 'consentRunningLine', panel,
      'While the exploit runs, do not close the app and do not power off ' +
      'the console. The "checking aio groups: n/N groups swept" lines are ' +
      'progress, not a freeze.');
    element('p', 'consentChoiceLine', panel,
      'Nothing has run yet. Run starts the exploit now and remembers the ' +
      'choice for this session, so automatic retries will not ask again. ' +
      'Exit stops here.');
    var buttons = element('div', 'consentButtons', panel);
    var run = element('button', 'consentRun', buttons, 'Run');
    var exit = element('button', 'consentExit', buttons, 'Exit');
    run.addEventListener('click', function () {
      document.body.removeChild(overlay);
      resolve('run');
    });
    exit.addEventListener('click', function () {
      overlay.removeChild(panel);
      element('h2', 'consentTitle', overlay, 'Not launched');
      element('p', 'consentDeclinedLine', overlay,
        'Nothing has run -- the exploit never started. Reboot the console ' +
        'first if it just went through a power cut or a database rebuild, ' +
        'then launch the autoloader again.');
      resolve('exit');
    });
  });
}

function retriesUsed() {
  if (!canStore) return MAX_RETRIES;
  try {
    return Math.max(0, parseInt(sessionStorage.getItem(RETRY_KEY) || '0', 10) || 0);
  } catch (error) {
    return MAX_RETRIES;
  }
}

function clearRetries() {
  try { sessionStorage.removeItem(RETRY_KEY); } catch (error) {}
}

// Honesty markers for a run that failed after the kernel payload finished:
// the loader is up, but the autoload did not reach it (or only part of it
// did). A reload would then find the loader already accepting connections
// and be told "nothing to do" -- a lie, because nothing is loaded and a
// reload can never complete the chain. The in-memory flag covers this run;
// the sessionStorage flag survives the automatic retry reload so the next
// load keeps telling the truth. Rebooting clears sessionStorage, which is
// the all-clear.
function noteElfPartial() {
  elfFailed = true;
  try { sessionStorage.setItem(ELF_PARTIAL_KEY, '1'); } catch (error) {}
}
function elfPartialHeld() {
  if (elfFailed) return true;
  try { return sessionStorage.getItem(ELF_PARTIAL_KEY) === '1'; } catch (error) { return false; }
}
function forgetElfPartial() {
  elfFailed = false;
  try { sessionStorage.removeItem(ELF_PARTIAL_KEY); } catch (error) {}
}

function cancelReload() {
  if (reloadTimer !== null) {
    clearInterval(reloadTimer);
    reloadTimer = null;
  }
}

// Cancel a pending reload that the kernel payload's start overtakes, and
// give the retry attempt it consumed back: the countdown spent one when it
// was scheduled, and that reload never fired.
function cancelPendingReload() {
  if (reloadTimer === null) return;
  cancelReload();
  var used = retriesUsed();
  if (used > 0) {
    try {
      if (used > 1) sessionStorage.setItem(RETRY_KEY, String(used - 1));
      else sessionStorage.removeItem(RETRY_KEY);
    } catch (error) {}
  }
}

function markSuccess() {
  // A dirty verdict is sticky: a late success line must never turn a run
  // that left the kernel modified into a clean one, clear its reboot
  // demand, or erase the latch the next launch refuses on.
  if (dirty) {
    noteKernelState('dirty');
    cancelReload();
    return;
  }
  var pending = reloadTimer !== null;
  cancelReload();
  clearRetries();
  forgetElfPartial(); // a delivered autoload supersedes any earlier partial hand-over
  // By the time the ELF transfer completes, the kernel exploit has already
  // finished and put its state back, so this is a clean outcome even if the
  // queue summary never arrives (page dies right after the send).
  noteKernelState('clean');
  if (pending) update(percent, 'Autoload finished.', 'done');
}

// Reload soon, unless the retry budget for this browser session is spent.
function scheduleReload(seconds) {
  if (reloadTimer !== null) return;
  var attempt = retriesUsed() + 1;
  if (!canStore || attempt > MAX_RETRIES) {
    cancelReload();
    update(percent, 'Automatic retry is not available. Reload the page to try again' +
      (dirty ? ' after rebooting the console.' : '.'), 'error');
    return;
  }
  try { sessionStorage.setItem(RETRY_KEY, String(attempt)); } catch (error) {}
  countdownEnd = Date.now() + seconds * 1000;

  function announce() {
    var left = Math.ceil((countdownEnd - Date.now()) / 1000);
    if (left > 0) {
      update(percent, 'Clean failure - automatic retry ' + attempt +
        ' of ' + MAX_RETRIES + ' in ' + left + 's...', 'retry');
      return true;
    }
    return false;
  }

  reloadTimer = setInterval(function () {
    if (announce()) return;
    // A reload the pre-kernel watchdog scheduled must never fire once the
    // kernel payload has started: tearing down the WebProcess mid-race is
    // the one forbidden reload. Reloads the retry policy schedules after
    // the queue's summary are terminal and always proceed.
    if (!terminal && (phase === 'kernel' || phase === 'post')) {
      cancelPendingReload();
      return;
    }
    cancelReload();
    update(percent, 'Reloading...', 'retry');
    try { location.reload(); } catch (error) {}
  }, 250);
  announce();
}

function finishPolicy(failedCount) {
  terminal = true;
  if (dirty) {
    noteKernelState('dirty');
    cancelReload();
    update(percent, 'Reboot required: the run left the kernel modified or ' +
      'unverifiable. Do not run the exploit again before rebooting.', 'error');
    return;
  }
  if (failedCount === 0) {
    noteKernelState('clean');
    markSuccess();
    return;
  }
  // The queue failed after the kernel payload had started. Re-running the
  // kernel exploit is only safe when the payload itself vouched for the
  // kernel state (an explicit clean verdict, like poops' verdict banner or
  // Relapse's cleanup verdict). Without one, nobody can vouch: treat it as
  // dirty and demand a reboot instead of retrying blindly.
  if ((phase === 'kernel' || phase === 'post') && !cleanVerdict) {
    dirty = true;
    noteKernelState('dirty');
    cancelReload();
    update(percent, 'Reboot required: the run failed without a clean verdict, ' +
      'so nobody can vouch for the kernel state. Do not run the exploit ' +
      'again before rebooting.', 'error');
    return;
  }
  noteKernelState('clean');
  scheduleReload(BACKOFF_SECONDS[Math.min(retriesUsed(), BACKOFF_SECONDS.length - 1)]);
}
function stopPolicy(text) {
  terminal = true;
  if (/ELF loader is already accepting connections/.test(text)) {
    // The stop text proves the loader is up right now. Without a partial
    // hand-over in this browser session that really is nothing-to-do; with
    // one, saying nothing-to-do would hide that the payloads never arrived.
    if (elfPartialHeld()) {
      cancelReload();
      clearRetries();
      noteKernelState('clean');
      update(percent, 'Nothing was loaded: a previous attempt in this browser ' +
        'session did not deliver the autoload to the ELF loader. Reboot the ' +
        'console and launch the autoloader again.', 'error');
      return;
    }
    markSuccess();
    return;
  }
  if (/Relapse requires an active network connection/.test(text)) {
    // A persistent environment problem: retrying cannot fix it.
    noteKernelState('clean');
    cancelReload();
    update(percent, 'Relapse needs an active network connection (Ethernet or ' +
      'Wi-Fi). Connect the console, or switch to the Poops chain.', 'error');
    return;
  }
  if (dirty) {
    noteKernelState('dirty');
    cancelReload();
    update(percent, 'Reboot required: the run left the kernel modified or ' +
      'unverifiable. Do not run the exploit again before rebooting.', 'error');
    return;
  }
  // A stop inside or after the kernel payload is only retryable with an
  // explicit clean verdict, for the same reason as a failed summary.
  if ((phase === 'kernel' || phase === 'post') && !cleanVerdict) {
    dirty = true;
    noteKernelState('dirty');
    cancelReload();
    update(percent, 'Reboot required: the queue stopped without a clean ' +
      'verdict, so nobody can vouch for the kernel state. Do not run the ' +
      'exploit again before rebooting.', 'error');
    return;
  }
  noteKernelState('clean');
  scheduleReload(BACKOFF_SECONDS[Math.min(retriesUsed(), BACKOFF_SECONDS.length - 1)]);
}

function trackPhase(text) {
  if (/\[2\/3\]/.test(text)) {
    if (phase !== 'kernel' && phase !== 'post') {
      // The kernel exploit is starting: from here until the queue reports a
      // summary, an interrupted run means an unknown kernel state. A reload
      // scheduled by the pre-kernel watchdog while the page was silent must
      // never fire mid-exploit, so cancel it and refund its spent attempt.
      if (!terminal) cancelPendingReload();
      phase = 'kernel';
      noteKernelState('inflight');
    }
  } else if (/\[3\/3\]/.test(text)) {
    phase = 'post';
  } else if (/ARW ready/.test(text)) {
    if (phase === 'boot' || phase === 'webkit') phase = 'userland';
  } else if (/Starting WebKit exploit/.test(text)) {
    if (phase === 'boot') phase = 'webkit';
  }
}

function checkDirty(text) {
  if (dirty) return;
  for (var i = 0; i < DIRTY_PATTERNS.length; i++) {
    if (DIRTY_PATTERNS[i].test(text)) {
      dirty = true;
      return;
    }
  }
}

function checkCleanVerdict(text) {
  if (cleanVerdict) return;
  for (var i = 0; i < CLEAN_PATTERNS.length; i++) {
    if (CLEAN_PATTERNS[i].test(text)) {
      cleanVerdict = true;
      return;
    }
  }
}

// Watchdog: before the kernel payload starts, the exploit is chatty (every
// WebKit attempt logs a line), so a silent page means a wedged renderer --
// recover with a reload. Once the kernel payload has started, stay passive:
// the payloads own their timeouts, and killing the page mid-race is unsafe.
setInterval(function () {
  if (terminal || reloadTimer !== null) return;
  if (phase === 'kernel' || phase === 'post') return;
  var now = Date.now();
  if (now - lastLineAt > WATCHDOG_MS ||
      (lastErrorAt && now - lastErrorAt > PRE_ERROR_MS && now - lastLineAt > PRE_ERROR_MS)) {
    scheduleReload(5);
  }
}, 5000);

function readLine(line) {
  if (locked) return; // the boot gate already refused; the display is final
  var text = line.textContent || '';
  var error = /(?:^|\s)log-(?:error|minus)(?:\s|$)/.test(line.className);

  // Orchestrator bookkeeping first: every line proves the page is alive,
  // advances the phase, and may classify the kernel state.
  lastLineAt = Date.now();
  if (error) lastErrorAt = Date.now();
  trackPhase(text);
  if (phase === 'kernel' || phase === 'post') {
    checkDirty(text);
    if (!cleanVerdict) checkCleanVerdict(text);
  }
  if (/Autoload: sent \d+ bytes/.test(text)) markSuccess();
  if (!sent && phase === 'post' && /ELF transfer failed after \d+ bytes/.test(text)) {
    // The loader was connected but the delivery died part-way (elfldr reads
    // exact lengths and discards a short one, so it is running with nothing
    // loaded). The automatic retry reload will stop on the already-running
    // loader; remember the failure so that stop tells the truth instead of
    // "nothing to do".
    noteElfPartial();
  }
  // The display is final once the queue reported its summary or stop; only
  // a late success may still matter (it cancels a pending retry), but late
  // errors must not rewrite the verdict the page already shows.
  if (finished) return;

  var summary = /queue finished: \d+\/\d+ completed, (\d+) failed/.exec(text);
  if (summary) {
    finished = true;
    if (Number(summary[1]) !== 0) update(percent, 'Autoload failed. See the log above.', 'error');
    else update(100, sent ? 'Autoload finished.' : 'Payloads finished.', 'done');
    finishPolicy(Number(summary[1]) || 0);
    return;
  }
  if (/queue stopped:/.test(text)) {
    finished = true;
    if (error) update(percent, 'Stopped. See the log above.', 'error');
    else if (/ELF loader is already accepting connections/.test(text))
      update(100, 'ELF loader already running. Nothing to do.', 'done');
    else update(percent, 'Stopped. See the log above.', 'stopped');
    stopPolicy(text);
    return;
  }
  if (error) {
    update(percent, 'An error occurred. See the log above.', 'error');
    return;
  }
  if (/Autoload: sent \d+ bytes/.test(text)) {
    sent = true;
    update(98, 'Finishing autoload...');
  } else if (/\[3\/3\].*autoload\.js/.test(text)) update(95, 'Loading autoload payload...');
  else if (/payloads loaded|elfldr.*listening/i.test(text)) update(90, 'ELF loader ready...');
  else if (/privileges ready/i.test(text)) update(80, 'Privileges ready...');
  else if (/read and write ready/i.test(text)) update(65, 'Kernel read/write ready...');
  else if (/Starting kernel exploit|\[2\/3\]/i.test(text)) update(40, 'Starting kernel exploit...');
  else if (/\[1\/3\].*elfldr-check\.js/.test(text)) update(35, 'Checking ELF loader...');
  else if (/Worker chain: ready/i.test(text)) update(30, 'WebKit ready...');
  else if (/ARW ready/i.test(text)) update(20, 'Preparing WebKit...');
  else if (/Starting WebKit exploit/i.test(text)) update(10, 'Starting WebKit exploit...');
  else {
    var stage = /\bSTAGE\s*([0-5])\b/i.exec(text);
    if (stage) update(40 + Number(stage[1]) * 10, 'Running kernel exploit...');
  }
}

// Observe the native log instead of replacing writeLog or the module APIs.
// Process only changed lines, including in-place stage updates.
var observer = new MutationObserver(function (records) {
  var changed = [];
  function remember(node) {
    if (node.nodeType !== 1) node = node.parentNode;
    while (node && node.parentNode !== output) node = node.parentNode;
    if (node && changed.indexOf(node) < 0) changed.push(node);
  }
  records.forEach(function (record) {
    if (record.target === output) {
      for (var i = 0; i < record.addedNodes.length; i++) remember(record.addedNodes[i]);
    } else remember(record.target);
  });
  changed.forEach(readLine);
  while (output.children.length > 80) output.removeChild(output.firstElementChild);
  wrapper.scrollTop = wrapper.scrollHeight;
});
observer.observe(output, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
