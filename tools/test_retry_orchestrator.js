// Offline checks for the retry orchestrator in frontend/autoloader/app.js.
//
// The orchestrator watches the same log lines as the progress bar, so it is
// driven here through a fake DOM: the MutationObserver callback is captured
// and fed console lines with a controllable clock. What matters is the
// policy: clean failures reload the page automatically and within budget,
// dirty failures never re-exploit, and a wedged pre-kernel stage recovers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('frontend/autoloader/app.js', 'utf8');

function makeElement(tag, id) {
  return {
    tagName: tag, id: id || '', nodeType: 1, children: [], style: {}, attributes: {},
    textContent: '', className: '', parentNode: null,
    setAttribute(key, value) { this.attributes[key] = String(value); },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at >= 0) this.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    get childNodes() { return this.children; },
    get firstElementChild() { return this.children[0] || null; },
  };
}

function makePage(options = {}) {
  const consoleEl = makeElement('div', 'console');
  const body = makeElement('body');
  const observers = [];
  let clock = 1000000;
  let dead = false;
  const intervals = new Map();
  let nextTimerId = 1;
  const store = {};
  if (options.kernelState) store['wamp_kernel_state'] = options.kernelState;

  const sandbox = {
    console,
    Date: { now: () => clock },
    Math, parseInt, String, Number, RegExp, Error,
    document: {
      title: '',
      body,
      createElement: (tag) => makeElement(tag),
      getElementById: (id) => (id === 'console' ? consoleEl : null),
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() {}
    },
    setInterval(fn, ms) {
      const entry = { fn, ms: ms || 0, next: clock + (ms || 0) };
      intervals.set(nextTimerId, entry);
      return nextTimerId++;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout() { throw new Error('unexpected setTimeout in the page script'); },
    clearTimeout() {},
    sessionStorage: {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    location: {
      reloadCalls: 0,
      reload() {
        this.reloadCalls++;
        // A real reload navigates away and no timer ever fires again.
        dead = true;
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  let bootRefused = null;
  try {
    vm.runInContext(source, sandbox);
  } catch (error) {
    bootRefused = error; // the startup gate refuses by throwing, like the builder documents
  }

  function tick(ms) {
    if (dead) {
      clock += ms;
      return;
    }
    const end = clock + ms;
    while (clock < end) {
      clock += Math.min(250, end - clock);
      for (const [id, entry] of [...intervals]) {
        if (entry.next <= clock) {
          entry.next += entry.ms;
          entry.fn();
        }
      }
      if (dead) break;
    }
  }

  // Feed one console line exactly the way site.js writes them.
  function say(text, type) {
    const line = makeElement('div');
    line.textContent = text;
    line.className = 'log-line log-' + (type || 'log');
    line.parentNode = consoleEl;
    consoleEl.children.push(line);
    for (const observer of observers)
      observer.callback([{ target: consoleEl, addedNodes: [line] }]);
    // The page observer never mutates the tree here, so prune manually.
    while (consoleEl.children.length > 80) consoleEl.children.shift();
  }

  function findElement(root, id) {
    if (root.id === id) return root;
    for (const child of root.children || []) {
      const hit = findElement(child, id);
      if (hit) return hit;
    }
    return null;
  }
  const label = () => findElement(body, 'progressLabel').textContent;
  const state = () => {
    const progress = findElement(body, 'progressContainer');
    return (progress && progress.attributes['data-state']) || '';
  };

  return {
    say, tick, label, state, consoleEl,
    reloadCalls: () => sandbox.location.reloadCalls,
    retries: () => sandbox.sessionStorage.getItem('wamp_rt_count'),
    setRetries(n) { if (n === null) sandbox.sessionStorage.removeItem('wamp_rt_count'); else sandbox.sessionStorage.setItem('wamp_rt_count', String(n)); },
    kernelState: () => store['wamp_kernel_state'] || null,
    bootRefused: () => bootRefused,
  };
}

// The full happy path, as the real page logs it.
function runSuccessFlow(page) {
  page.say('[*] Starting WebKit exploit');
  page.say('ARW ready', 'success');
  page.say('=== [1/3] elfldr-check.js ===', 'success');
  page.say('No ELF loader is accepting connections on port 9021. Continuing.', 'info');
  page.say('=== [2/3] poops.js ===', 'success');
  page.say('[*] stage 0: 42 attempts in 84 ms', 'log');
  page.say('=== [3/3] autoload.js ===', 'success');
  page.say('Autoload: sent 123456 bytes of autoload.elf to elfldr.', 'success');
  page.say('=== queue finished: 3/3 completed, 0 failed ===', 'success');
}

(async () => {
  // 1. Success: done, no reload, and the retry counter does not survive.
  {
    const page = makePage();
    page.setRetries(2);
    runSuccessFlow(page);
    page.tick(120000);
    assert.equal(page.state(), 'done');
    assert.match(page.label(), /Autoload finished\./);
    assert.equal(page.reloadCalls(), 0);
    assert.equal(page.retries(), null);
  }

  // 2. Clean failure: automatic countdown, then a reload, and the attempt
  // is counted so a wedged loop cannot spin forever. The failure carries
  // Relapse's explicit cleanup verdict, which is what makes it retryable.
  {
    const page = makePage();
    page.say('[*] Starting WebKit exploit');
    page.say('ARW ready', 'success');
    page.say('=== [1/3] elfldr-check.js ===', 'success');
    page.say('=== [2/3] relapse.js ===', 'success');
    page.say('the exploit stopped before kernel r/w was established', 'error');
    page.say('Cleanup: verified the kernel state was restored', 'success');
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('The exploit did not complete; no ELF was sent.', 'error');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /automatic retry 1 of 3/);
    assert.equal(page.state(), 'retry');
    page.tick(4900);
    assert.equal(page.reloadCalls(), 0, 'the countdown must outlive the first seconds');
    page.tick(300);
    assert.equal(page.reloadCalls(), 1);
    assert.equal(page.retries(), '1');
  }

  // 3. Dirty failure: the kernel was left modified or unverifiable, so the
  // orchestrator must refuse to re-exploit no matter how the queue ends.
  {
    const page = makePage();
    page.say('ARW ready', 'success');
    page.say('=== [2/3] poops.js ===', 'success');
    page.say('REBOOT NOW -- the trigger fired and the teardown did not complete', 'error');
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('Autoload: sent 123456 bytes of autoload.elf to elfldr.', 'success');
    page.say('=== queue finished: 3/3 completed, 0 failed ===', 'success');
    assert.match(page.label(), /Reboot required/);
    assert.equal(page.state(), 'error');
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
  }

  // 4. Every dirty marker means reboot, including the milder wordings.
  for (const [line, type] of [
    ['REBOOT NOW -- the trigger fired and the teardown did not complete', 'error'],
    ['reboot now, from this page.', 'error'],
    ['REBOOT the console.', 'warn'],
    ['cleanup failed: the ROP chain died at chain.run', 'error'],
    ['Cleanup: failed', 'error'],
    ['cleanup: aio cleanup failed (1 skipped, 1 failed)', 'error'],
    ['Kernel: stopped: aio groups did not defuse; not escalating over armed groups', 'error'],
    ['Cleanup: oid restore check failed', 'error'],
    ['Cleanup: oid restore check failed: kernel r/w is not available and the oid state is not the original one', 'error'],
    ['Cleanup: pipe buffer was not cleared', 'error'],
    ['Cleanup: pipe buffer was not cleared: the master pipe fields written before the failure are still in place', 'error'],
    ['Cleanup: could not aim the victim at the master, leaving both armed', 'error'],
    ['Cleanup: could not release aio workers', 'error'],
    ['Cleanup: current process unavailable', 'error'],
    ['the ROP chain died: chain.run', 'error'],
    ['WATCHDOG: no reply from the ROP worker in 15000 ms at ps3_racers', 'error'],
    ['this run left no verdict, so a re-send in this session will refuse', 'warn'],
    ['the poops latch is already held for this session: ps1', 'warn'],
    ['this session already holds a krw handle, so the kernel has already been hit', 'warn'],
    ['payload has run for 600s and has not returned', 'error'],
    ['Cleanup: did not verify the kernel state: REBOOT the console', 'error'],
    ['the exploit finished, but its cleanup did not verify the kernel state -- no payloads will be sent and no krw handle is published. REBOOT the console before running the exploit again.', 'error'],
  ]) {
    const page = makePage();
    page.say('=== [2/3] poops.js ===', 'success');
    page.say(line, type);
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /Reboot required/, 'expected a reboot demand for: ' + line);
    page.tick(60000);
    assert.equal(page.reloadCalls(), 0, 'a dirty run must never reload for: ' + line);
  }

  // 5. Dirty markers only count once the kernel payload has started: the same
  // wording before any kernel contact is a clean, retryable failure.
  {
    const page = makePage();
    page.say('ARW ready', 'success');
    page.say('=== [1/3] elfldr-check.js ===', 'success');
    page.say('Could not check whether the ELF loader is already running', 'error');
    page.say('=== queue stopped: Could not check whether the ELF loader is already running; 2 payload(s) skipped ===', 'error');
    assert.match(page.label(), /automatic retry 1 of 3/);
    page.tick(6000);
    assert.equal(page.reloadCalls(), 1);
  }

  // 6. A wedged pre-kernel stage (no log output at all) recovers by reload.
  {
    const page = makePage();
    page.say('[*] Starting WebKit exploit');
    page.tick(88000);
    assert.equal(page.reloadCalls(), 0, 'the watchdog must wait');
    page.tick(20000);
    assert.equal(page.reloadCalls(), 1);
    assert.equal(page.retries(), '1');
  }

  // 7. The watchdog is silent once the kernel payload has started: killing
  // the page mid-race is the one thing this script must never do.
  {
    const page = makePage();
    page.say('[*] Starting WebKit exploit');
    page.say('ARW ready', 'success');
    page.say('=== [2/3] poops.js ===', 'success');
    page.tick(300000);
    assert.equal(page.reloadCalls(), 0);
  }

  // 8. The retry budget: a fourth clean failure demands a human. The kaslr
  // throw never reaches the kernel, so rescue() still verifies a clean state.
  {
    const page = makePage();
    page.setRetries(3);
    page.say('=== [2/3] relapse.js ===', 'success');
    page.say('the exploit threw: kaslr: no routing reply', 'error');
    page.say('Cleanup: verified the kernel state was restored', 'success');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /Automatic retry is not available/);
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
  }

  // 9. A payload overrun while autoload is in flight is dirty: the hijacked
  // worker is stuck inside a kernel syscall and a reload cannot help. Even a
  // late "sent" must not rescue that verdict -- or the latch behind it.
  {
    const page = makePage();
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('payload has run for 600s and has not returned', 'error');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /Reboot required/);
    page.say('Autoload: sent 123456 bytes of autoload.elf to elfldr.', 'success');
    assert.match(page.label(), /Reboot required/);
    assert.equal(page.kernelState(), 'dirty',
      'a late success must not erase the dirty verdict from the latch');
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
  }

  // 10. A late success after a *clean* failure cancels a pending reload
  // instead of reloading over a transfer that did land. The kernel payload
  // left its cleanup verdict before autoload failed, which is what made the
  // first failure retryable.
  {
    const page = makePage();
    page.say('=== [2/3] relapse.js ===', 'success');
    page.say('Cleanup: verified the kernel state was restored', 'success');
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('ELF transfer failed after 0 bytes.', 'error');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /automatic retry 1 of 3/);
    page.tick(2000);
    page.say('Autoload: sent 123456 bytes of autoload.elf to elfldr.', 'success');
    assert.match(page.label(), /Autoload finished\./);
    assert.equal(page.state(), 'done');
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
    assert.equal(page.retries(), null);
  }

  // 11. An already-running ELF loader is a success, not a retry.
  {
    const page = makePage();
    page.say('=== [1/3] elfldr-check.js ===', 'success');
    page.say('ELF loader is already running. Skipping the kernel exploit and autoload.', 'success');
    page.say('=== queue stopped: ELF loader is already accepting connections on 127.0.0.1:9021; 2 payload(s) skipped ===', 'info');
    assert.match(page.label(), /ELF loader already running/);
    assert.equal(page.state(), 'done');
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
  }

  // 12. The kernel-state latch: 'inflight' while the kernel payload runs,
  // 'clean' once the ELF lands (even before the summary), and 'clean' at a
  // clean queue summary, so the next load's gate passes.
  {
    const page = makePage();
    page.say('[*] Starting WebKit exploit');
    page.say('ARW ready', 'success');
    page.say('=== [1/3] elfldr-check.js ===', 'success');
    page.say('=== [2/3] relapse.js ===', 'success');
    assert.equal(page.kernelState(), 'inflight');
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('Autoload: sent 123456 bytes of autoload.elf to elfldr.', 'success');
    assert.equal(page.kernelState(), 'clean');
    page.say('=== queue finished: 3/3 completed, 0 failed ===', 'success');
    assert.equal(page.kernelState(), 'clean');
  }

  // 13. A clean failure also leaves 'clean': the auto-retry reload is allowed
  // to boot again immediately. The verdict line is what authorises the retry.
  {
    const page = makePage();
    page.say('=== [2/3] relapse.js ===', 'success');
    page.say('the exploit stopped before kernel r/w was established', 'error');
    page.say('Cleanup: verified the kernel state was restored', 'success');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.equal(page.kernelState(), 'clean');
    assert.match(page.label(), /automatic retry 1 of 3/);
  }

  // 14. A dirty run records 'dirty', and a fresh load in the same browser
  // session must refuse to boot at all -- this is Relapse's missing latch.
  {
    const page = makePage();
    page.say('=== [2/3] relapse.js ===', 'success');
    assert.equal(page.kernelState(), 'inflight');
    page.say('Cleanup: failed', 'error');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.equal(page.kernelState(), 'dirty');
    assert.match(page.label(), /Reboot required/);

    const next = makePage({ kernelState: 'dirty' });
    assert(next.bootRefused(), 'the gate must refuse the boot after a dirty run');
    assert.match(next.label(), /Reboot required/);
    assert.equal(next.state(), 'error');
    next.tick(120000);
    assert.equal(next.reloadCalls(), 0, 'a refused boot must never reload');
  }

  // 15. A page that died mid-exploit leaves 'inflight'; the next load
  // refuses, and the refusal display is final.
  {
    const page = makePage({ kernelState: 'inflight' });
    assert(page.bootRefused(), 'the gate must refuse the boot after an interrupted run');
    assert.match(page.label(), /interrupted while the kernel exploit was in flight/);
    assert.equal(page.state(), 'error');
    page.say('anything at all', 'error');
    assert.match(page.label(), /interrupted while the kernel exploit was in flight/);
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
  }

  // 16. The gate passes after a clean previous run and after a session
  // without any kernel work.
  {
    const page = makePage({ kernelState: 'clean' });
    assert.ifError(page.bootRefused());
    runSuccessFlow(page);
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
    assert.equal(page.state(), 'done');

    const fresh = makePage();
    assert.ifError(fresh.bootRefused());
    runSuccessFlow(fresh);
    assert.equal(fresh.state(), 'done');
  }

  // 17. The Relapse network preflight stop is terminal, not retryable, and
  // leaves the latch clean (the kernel was never touched).
  {
    const page = makePage();
    page.say('=== [1/3] elfldr-check.js ===', 'success');
    page.say('Relapse needs a network interface with an address for its KASLR leak, and none is available.', 'error');
    page.say('=== queue stopped: Relapse requires an active network connection; none is available; 2 payload(s) skipped ===', 'error');
    assert.match(page.label(), /needs an active network connection/);
    assert.equal(page.state(), 'error');
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
    assert.equal(page.kernelState(), 'clean');
  }

  // 18. A watchdog reload scheduled while the page was silent must be
  // cancelled -- and its spent attempt refunded -- the moment the kernel
  // payload starts: firing it mid-race is the one forbidden reload.
  {
    const page = makePage();
    page.say('[*] Starting WebKit exploit');
    page.tick(96000); // the watchdog arms its reload, the countdown is pending
    assert.equal(page.reloadCalls(), 0, 'the countdown must be pending');
    assert.equal(page.retries(), '1');
    page.say('=== [2/3] relapse.js ===', 'success'); // the kernel payload starts
    assert.equal(page.retries(), null, 'the cancelled countdown must refund its attempt');
    page.tick(300000); // a long kernel run
    assert.equal(page.reloadCalls(), 0, 'a reload must never fire while the kernel exploit is in flight');
    // The refund left the full budget for a genuine failure afterwards.
    page.say('the exploit stopped before kernel r/w was established', 'error');
    page.say('Cleanup: verified the kernel state was restored', 'success');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /automatic retry 1 of 3/);
    assert.equal(page.retries(), '1');
    assert.equal(page.kernelState(), 'clean');
  }

  // 19. A kernel-phase failure without an explicit clean verdict is dirty:
  // Relapse failures used to fall through to 'clean' and auto-retry over a
  // kernel nobody vouched for.
  {
    const page = makePage();
    page.say('=== [2/3] relapse.js ===', 'success');
    page.say('the exploit stopped before kernel r/w was established', 'error');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /Reboot required/);
    assert.match(page.label(), /without a clean verdict/);
    assert.equal(page.kernelState(), 'dirty');
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
  }

  // 20. A queue stop inside the kernel phase is only retryable with a
  // verdict, for the same reason as a failed summary.
  {
    const page = makePage();
    page.say('=== [2/3] relapse.js ===', 'success');
    page.say('=== queue stopped: relapse.js requested a stop mid-exploit; 1 payload(s) skipped ===', 'error');
    assert.match(page.label(), /Reboot required/);
    assert.equal(page.kernelState(), 'dirty');
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
  }

  // 21. A late success must never rescue a dirty verdict: the run stays a
  // reboot demand in the display AND in the latch, and the retry budget is
  // not consumed.
  {
    const page = makePage();
    page.say('=== [2/3] relapse.js ===', 'success');
    page.say('Cleanup: did not verify the kernel state: REBOOT the console', 'error');
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('Autoload: sent 123456 bytes of autoload.elf to elfldr.', 'success');
    page.say('=== queue finished: 3/3 completed, 0 failed ===', 'success');
    assert.match(page.label(), /Reboot required/);
    assert.equal(page.kernelState(), 'dirty');
    assert.equal(page.retries(), null, 'a dirty run must not consume the retry budget');
    page.tick(120000);
    assert.equal(page.reloadCalls(), 0);
  }

  // 22. Poops' own verdict lines authorise retries: a lost race that cleaned
  // up after itself ("nothing was claimed") and a full pass whose krw
  // publication was skipped ("cleanup reported clean") both leave the latch
  // clean and the retry armed.
  {
    const page = makePage();
    page.say('=== [2/3] poops.js ===', 'success');
    page.say('nothing was claimed: see the rows above for where it stopped', 'warn');
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('The exploit did not complete; no ELF was sent.', 'error');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /automatic retry 1 of 3/);
    assert.equal(page.kernelState(), 'clean');
  }
  {
    const page = makePage();
    page.say('=== [2/3] poops.js ===', 'success');
    page.say('all executed checks passed and cleanup reported clean', 'success');
    page.say('no krw handle to publish: stage 5 never ran', 'warn');
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('The exploit did not complete; no ELF was sent.', 'error');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /automatic retry 1 of 3/);
    assert.equal(page.kernelState(), 'clean');
  }

  // 23. A failure before the kernel was touched vouches for itself
  // explicitly, so a fetch or setup failure stays a retryable clean failure.
  {
    const page = makePage();
    page.say('=== [2/3] relapse.js ===', 'success');
    page.say('could not fetch the elfldr/kexp binaries: the embedded data is corrupt.', 'error');
    page.say('the kernel was never touched, so there is nothing to clean', 'info');
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('The exploit did not complete; no ELF was sent.', 'error');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /automatic retry 1 of 3/);
    assert.equal(page.kernelState(), 'clean');
  }

  // 24. A late error line after the summary must not rewrite the final
  // verdict display; only a late success still matters after the queue ends.
  {
    const page = makePage();
    page.say('=== [2/3] relapse.js ===', 'success');
    page.say('Cleanup: verified the kernel state was restored', 'success');
    page.say('=== [3/3] autoload.js ===', 'success');
    page.say('ELF transfer failed after 0 bytes.', 'error');
    page.say('=== queue finished: 2/3 completed, 1 failed ===', 'error');
    assert.match(page.label(), /automatic retry 1 of 3/);
    page.say('payload threw: a late straggler error', 'error');
    assert.match(page.label(), /automatic retry 1 of 3/, 'a late error must not rewrite the verdict');
    page.tick(6000);
    assert.equal(page.reloadCalls(), 1);
  }

  console.log('Retry orchestrator checks passed: clean failures auto-retry within budget, dirty failures demand a reboot, the pre-kernel watchdog recovers a wedged page, the kernel phase is never interrupted, the kernel-state latch gates every reload, and a kernel-phase failure needs an explicit clean verdict to be retryable.');
})().catch(error => { console.error(error); process.exitCode = 1; });
