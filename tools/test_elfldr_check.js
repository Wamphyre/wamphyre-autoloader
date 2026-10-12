// Exercise the real check payload through the upstream standalone queue runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync('payloads/elfldr-check.js', 'utf8');

function pointer(low) {
  return { low: low >>> 0, hi: low < 0 ? 0xffffffff : 0,
    add32(n) { return pointer(this.low + n); } };
}

(async () => {
  const { runPayloadQueue } = await import(pathToFileURL(path.resolve(
    'third_party/ps5-webkit-remote-loader/src/standalone.js')).href);

  async function run(options = {}) {
    const memory = new Map(), calls = [], logs = [];
    let next = 0x20000000;
    let connects = 0;
    globalThis.window = globalThis;
    globalThis.fw_str = '11.00';
    globalThis.writeLog = (message, type) => logs.push({ message, type });
    const p = {
      malloc(size) { const addr = pointer(next); next += size; return addr; },
      write1(addr, value) { memory.set(addr.low, value); },
      read1(addr) { return memory.get(addr.low) || 0; },
      syscalls: options.syscalls,
    };
    const chain = { async syscall(nr, ...args) {
      calls.push({ nr, args });
      if (nr === 0x7d) {
        if (options.netInterfaces === undefined) throw new Error('netgetiflist was not expected here');
        if (calls.filter(call => call.nr === 0x7d).length === 1)
          return pointer(options.netInterfaces);
        // The fill call: give the first record an address when asked to.
        if (options.netAddress)
          for (let b = 0; b < 4; b++) memory.set(args[0].low + 40 + b, options.netAddress[b]);
        return pointer(options.netInterfaces);
      }
      if (nr === 0x61) {
        assert.deepEqual(args, [2, 1, 0]);
        return pointer(options.socketFails ? -1 : (options.fd ?? 12));
      }
      if (nr === 0x62) {
        assert.equal(args[0], options.fd ?? 12);
        assert.equal(args[2], 16);
        assert.deepEqual(Array.from({ length: 16 }, (_, i) => memory.get(args[1].low + i)),
          [16, 2, 0x23, 0x3d, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
        if (options.connectThrows) throw new Error('connect failed unexpectedly');
        connects++;
        // listenAfter: N makes the Nth connect the first accepted one, to
        // exercise the probe window against a loader that is mid-startup.
        const listening = connects >= (options.listenAfter ?? (options.listening ? 1 : Infinity));
        return pointer(listening ? 0 : -1);
      }
      if (nr === 6) {
        assert.equal(args[0], options.fd ?? 12);
        if (options.closeThrows) throw new Error('close failed unexpectedly');
        return pointer(options.closeFails ? -1 : 0);
      }
      throw new Error('Probe must not send data or run another syscall: ' + nr);
    } };
    const summary = await runPayloadQueue({ p, chain, payloads: [
      { name: 'elfldr-check.js', source, args: options.checkArgs },
      { name: 'kernel.js', source: `return async function (api) {
        if (api.krw) throw new Error('check must run before kernel access');
        api.krw = {}; await api.log('kernel marker');
      };` },
      { name: 'autoload.js', source: `return async function (api) {
        if (!api.krw) throw new Error('kernel must run before autoload');
        await api.log('autoload marker');
      };` },
    ] });
    return { summary, calls, text: logs.map(log => log.message).join('\n') };
  }

  // A successful TCP connect stops both following payloads, sends nothing, and
  // closes its socket even when the returned descriptor is zero.
  for (const fd of [0, 12]) {
    const result = await run({ listening: true, fd });
    assert.equal(result.summary.stopped, true);
    assert.equal(result.summary.run, 1);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.skipped, 2);
    assert.equal(result.summary.ok, true);
    assert(!result.text.includes('kernel marker'));
    assert(!result.text.includes('autoload marker'));
    assert.deepEqual(result.calls.map(call => call.nr), [0x61, 0x62, 6]);
  }

  // Refusal on every probe attempt allows the kernel exploit and autoload to
  // run in order.
  const absent = await run();
  assert.equal(absent.summary.run, 3);
  assert.equal(absent.summary.failed, 0);
  assert(!absent.summary.stopped);
  assert(absent.text.indexOf('kernel marker') < absent.text.indexOf('autoload marker'));
  assert.deepEqual(absent.calls.map(call => call.nr),
    [0x61, 0x62, 6, 0x61, 0x62, 6, 0x61, 0x62, 6]);

  // A loader that is mid-startup accepts within the probe window: the queue
  // stops instead of re-running the kernel exploit over a live loader.
  const late = await run({ listenAfter: 2 });
  assert.equal(late.summary.stopped, true);
  assert.equal(late.summary.run, 1);
  assert.equal(late.summary.failed, 0);
  assert.equal(late.summary.skipped, 2);
  assert(!late.text.includes('kernel marker'));
  assert(!late.text.includes('autoload marker'));
  assert.deepEqual(late.calls.map(call => call.nr), [0x61, 0x62, 6, 0x61, 0x62, 6]);

  // A loader that never appears inside the window behaves exactly like an
  // absent one: the window is short and then the queue proceeds.
  const never = await run({ listenAfter: 4 });
  assert.equal(never.summary.run, 3);
  assert.equal(never.summary.failed, 0);
  assert(!never.summary.stopped);
  assert.deepEqual(never.calls.map(call => call.nr),
    [0x61, 0x62, 6, 0x61, 0x62, 6, 0x61, 0x62, 6]);

  // Relapse chain: no interface with an address means a precise, non-retryable
  // stop before the kernel payload ever runs.
  const noNet = await run({
    checkArgs: ['relapse'], syscalls: { 0x7d: {} }, netInterfaces: 0,
  });
  assert.equal(noNet.summary.stopped, true);
  assert.equal(noNet.summary.run, 1);
  assert.equal(noNet.summary.failed, 0);
  assert.equal(noNet.summary.skipped, 2);
  assert(!noNet.text.includes('kernel marker'));
  assert(!noNet.text.includes('autoload marker'));
  assert(noNet.text.includes('Relapse requires an active network connection; none is available'));
  assert(noNet.text.includes('needs a network interface with an address'));

  // Relapse chain: an interface with an all-zero address is still no address.
  const zeroNet = await run({
    checkArgs: ['relapse'], syscalls: { 0x7d: {} }, netInterfaces: 1,
  });
  assert.equal(zeroNet.summary.stopped, true);
  assert(!zeroNet.text.includes('kernel marker'));

  // Relapse chain: an interface carrying an address lets the queue proceed.
  const withNet = await run({
    checkArgs: ['relapse'], syscalls: { 0x7d: {} }, netInterfaces: 1,
    netAddress: [192, 168, 1, 50],
  });
  assert.equal(withNet.summary.run, 3);
  assert.equal(withNet.summary.failed, 0);
  assert(!withNet.summary.stopped);
  assert(withNet.text.includes('A network interface with an address is available for Relapse.'));

  // Poops chain: the interface preflight never runs.
  const poopsChain = await run({
    checkArgs: ['poops'], syscalls: { 0x7d: {} }, netInterfaces: 0,
  });
  assert.equal(poopsChain.summary.run, 3);
  assert(!poopsChain.calls.some(call => call.nr === 0x7d));

  // No chain argument (a page built before this preflight existed) or no
  // syscall stub: the check steps aside and the exploit decides for itself.
  const noArg = await run({ syscalls: { 0x7d: {} }, netInterfaces: 0 });
  assert.equal(noArg.summary.run, 3);
  const noStub = await run({ checkArgs: ['relapse'], netInterfaces: 0 });
  assert.equal(noStub.summary.run, 3);
  assert(!noStub.calls.some(call => call.nr === 0x7d));

  // An unexpected probe/cleanup failure must not lead to a blind kernel retry.
  for (const options of [{ socketFails: true }, { connectThrows: true },
    { closeThrows: true }, { closeFails: true },
    { listening: true, closeThrows: true }, { listening: true, closeFails: true }]) {
    const result = await run(options);
    assert.equal(result.summary.stopped, true);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.skipped, 2);
    assert(!result.text.includes('kernel marker'));
    assert(!result.text.includes('autoload marker'));
    assert.equal(result.calls.filter(call => call.nr === 6).length, options.socketFails ? 0 : 1);
  }
  console.log('ELF loader check passed: accepted sockets stop the queue; refused sockets continue after a short probe window; a mid-startup loader is detected; no data sent; descriptors closed; unexpected failures stop safely.');
})().catch(error => { console.error(error); process.exitCode = 1; });
