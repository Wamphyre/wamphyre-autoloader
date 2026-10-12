// Offline checks for the standalone payload queue's timeout handling.
//
// A payload deadline is a race, not a cancellation: when a payload overruns,
// its promises may still be executing on the hijacked worker. The queue must
// stop instead of running the next payload alongside a live one -- the kernel
// exploit must never start over an autoload that is still transferring, and a
// second exploit stage must never run over the first.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const { runPayloadQueue } = await import(pathToFileURL(path.resolve(
    'third_party/ps5-webkit-remote-loader/src/standalone.js')).href);

  const logs = [];
  globalThis.window = globalThis;
  globalThis.fw_str = '11.00';
  globalThis.writeLog = (message, type) => logs.push({ message, type });

  const chain = { async syscall() { return { low: 0, hi: 0 }; } };
  const p = { syscalls: {} };

  async function run(payloads, options = {}) {
    logs.length = 0;
    const summary = await runPayloadQueue({
      p, chain, payloads,
      payloadTimeoutMs: options.timeoutMs,
    });
    return { summary, text: logs.map(log => log.message).join('\n') };
  }

  // 1. A payload that overruns its deadline stops the queue: the next payload
  // must never start, because the timed-out one may still be executing.
  {
    const { summary, text } = await run([
      { name: 'hangs.js', source: `return async function (api) {
        await api.log('hanging payload started');
        await new Promise(() => {}); // never resolves and keeps no timers alive
      };` },
      { name: 'after.js', source: `return async function (api) {
        await api.log('MUST NOT RUN');
      };` },
    ], { timeoutMs: 40 });

    assert.equal(summary.stopped, true, 'an overrun must stop the queue');
    assert.equal(summary.run, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.ok, false);
    assert.match(summary.reason, /may still be running/);
    assert(text.includes('hanging payload started'));
    assert(text.includes('payload has run for 0.04s and has not returned'));
    assert(text.includes('queue stopped: hangs.js ran for 0.04s without returning and may still be running'));
    assert(!text.includes('MUST NOT RUN'), 'the payload after a timeout must not execute');
    assert(!text.includes('[2/2] after.js'), 'the skipped payload must not be announced');
  }

  // 2. The same stop applies mid-queue: an autoload that hangs after a kernel
  // payload leaves nothing to run, but the queue must still not report a
  // normal finish.
  {
    const { summary, text } = await run([
      { name: 'one.js', source: `return async function (api) { await api.log('first done'); };` },
      { name: 'hangs.js', source: `return async function (api) {
        await api.log('second started');
        await new Promise(() => {});
      };` },
      { name: 'three.js', source: `return async function (api) { await api.log('MUST NOT RUN'); };` },
    ], { timeoutMs: 40 });

    assert.equal(summary.stopped, true);
    assert.equal(summary.run, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 1);
    assert(text.includes('first done'));
    assert(text.includes('second started'));
    assert(!text.includes('MUST NOT RUN'));
    assert(!text.includes('queue finished:'));
  }

  // 3. Control: a payload that completes within its deadline does not stop
  // anything, and a short timeout does not affect later payloads.
  {
    const { summary, text } = await run([
      { name: 'quick.js', source: `return async function (api) { await api.log('quick done'); };` },
      { name: 'also-quick.js', source: `return async function (api) { await api.log('also done'); };` },
    ], { timeoutMs: 2000 });

    assert.equal(summary.stopped, undefined);
    assert.equal(summary.run, 2);
    assert.equal(summary.failed, 0);
    assert(text.includes('quick done'));
    assert(text.includes('also done'));
    assert(text.includes('=== queue finished: 2/2 completed, 0 failed ==='));
  }

  // 4. A payload that throws still lets the queue continue (its execution
  // ended; only a timeout leaves it potentially alive).
  {
    const { summary, text } = await run([
      { name: 'boom.js', source: `return async function (api) {
        await api.log('about to throw');
        throw new Error('deliberate');
      };` },
      { name: 'after.js', source: `return async function (api) { await api.log('still runs'); };` },
    ], { timeoutMs: 2000 });

    assert.equal(summary.stopped, undefined);
    assert.equal(summary.run, 1);
    assert.equal(summary.failed, 1);
    assert(text.includes('still runs'));
  }

  console.log('Payload queue checks passed: a timed-out payload stops the queue instead of letting the next one run alongside a payload that may still be executing.');
})().catch(error => { console.error(error); process.exitCode = 1; });
