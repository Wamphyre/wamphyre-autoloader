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
(function () {
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
    document.title = 'Wamphyre Autoloader v' + config.version + ' by PLK' +
      (config.buildTime ? ' (built ' + config.buildTime + ')' : '');
  }
  var footer = element('div', 'footer', document.body);
  element('div', 'buildInfo', footer, 'Wamphyre Autoloader' +
    (config.version ? ' v' + config.version : '') + ' by PLK' +
    (config.buildTime ? ' (built ' + config.buildTime + ')' : ''));
  var source = element('div', 'sourceInfo', footer, 'This project is free and open source: ');
  var link = element('a', 'sourceLink', source, "a fork of PLK's ps5-webkit-autoloader");
  link.href = 'https://github.com/itsPLK/ps5-webkit-autoloader';

  var percent = 0;
  var finished = false;
  var sent = false;
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
  var WATCHDOG_MS = 90000;  // pre-kernel log silence before an automatic reload
  var PRE_ERROR_MS = 20000; // a pre-kernel error with no follow-up before a reload

  var phase = 'boot';
  var terminal = false;    // the queue reported a summary or a stop
  var dirty = false;       // the kernel may be modified: never re-exploit
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

  function cancelReload() {
    if (reloadTimer !== null) {
      clearInterval(reloadTimer);
      reloadTimer = null;
    }
  }

  function markSuccess() {
    var pending = reloadTimer !== null;
    cancelReload();
    clearRetries();
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
    noteKernelState('clean');
    if (failedCount === 0) {
      markSuccess();
      return;
    }
    scheduleReload(BACKOFF_SECONDS[Math.min(retriesUsed(), BACKOFF_SECONDS.length - 1)]);
  }
  function stopPolicy(text) {
    terminal = true;
    if (/ELF loader is already accepting connections/.test(text)) {
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
    noteKernelState('clean');
    scheduleReload(BACKOFF_SECONDS[Math.min(retriesUsed(), BACKOFF_SECONDS.length - 1)]);
  }

  function trackPhase(text) {
    if (/\[2\/3\]/.test(text)) {
      if (phase !== 'kernel' && phase !== 'post') {
        phase = 'kernel';
        // The kernel exploit is starting: from here until the queue reports a
        // summary, an interrupted run means an unknown kernel state.
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
    if (phase === 'kernel' || phase === 'post') checkDirty(text);
    if (/Autoload: sent \d+ bytes/.test(text)) markSuccess();

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
    if (finished) return;
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
}());
