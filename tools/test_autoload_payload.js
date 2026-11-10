// Offline checks for the third payload: stage the ELF, hand it to elfldr.
//
// payloads/autoload.js runs as payload 3 of 3, after the chain exploit has run
// and published api.krw, so there is no chain selection here to test: the page
// is already built for one chain. What is left is a syscall against a socket and
// a copy into a mapping, all of which can be driven from here with a fake api.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('payloads/autoload.js', 'utf8');

function pointer(low) {
  return { low, hi: 0, add32(n) { return pointer(this.low + n); } };
}

async function run(options = {}) {
  const bytes = new Uint8Array(0x1007);
  bytes.set([0x7f, 0x45, 0x4c, 0x46]);
  for (let i = 4; i < bytes.length; i++) bytes[i] = i & 255;
  const memory = new Map();
  const events = [];
  const sent = [];
  const mapped = pointer(0x30000000);
  const DIRECT_BASE = 0x50000000;
  let next = 0x20000000;
  let connections = 0;
  let closed = 0;
  let unmapped = 0;
  const expectedElf = (options.args && options.args[0]) || 'autoload.elf';
  function byteAt(address) {
    if (options.direct && address >= DIRECT_BASE && address < DIRECT_BASE + bytes.length)
      return bytes[address - DIRECT_BASE];
    return memory.get(address);
  }
  const api = {
    // Payload 3: the exploit already ran, so krw is present unless we are
    // testing the case where it did not.
    krw: options.noKrw ? null : {},
    args: options.args || [],
    log: async () => {},
    p: {
      malloc(size) { const p = pointer(next); next += size; return p; },
      write1(p, n) { memory.set(p.low, n & 255); },
      write4(p, n) { for (let i = 0; i < 4; i++) memory.set(p.low + i, (n >>> (i * 8)) & 255); },
      read4(p) {
        return [0, 1, 2, 3].reduce((v, i) => v | ((byteAt(p.low + i) || 0) << (i * 8)), 0) >>> 0;
      },
      read8(p) {
        if (options.direct && p.low === 0x40000010)
          return { low: options.directBogus ? 0x60000000 : DIRECT_BASE, hi: 0,
            add32(n) { return pointer(this.low + n); } };
        return pointer(0);
      },
      leakval() {
        return options.direct ? pointer(0x40000000) : null;
      },
    },
    chain: { async syscall(n, a, b, c) {
      if (n === 0x61) return pointer(12);
      if (n === 0x62) {
        connections++;
        assert.deepEqual(Array.from({ length: 8 }, (_, i) => memory.get(b.low + i)), [16, 2, 0x23, 0x3d, 127, 0, 0, 1]);
        // The exploit brings elfldr up; options.loaderFails makes it never listen.
        return pointer(options.loaderFails ? -1 : 0);
      }
      if (n === 6) { closed++; return pointer(0); }
      if (n === 0x1dd) { events.push('map'); return pointer(options.mmapFails ? -1 : mapped.low); }
      if (n === 0x49) { unmapped++; return pointer(0); }
      if (n === 4) {
        assert(api.krw, 'the payload must not send an ELF without kernel access');
        if (options.writeFails) return pointer(-1);
        const count = Math.min(c, 113); // Exercise short writes and the final tail.
        for (let i = 0; i < count; i++) sent.push(byteAt(b.low + i));
        return pointer(count);
      }
      throw new Error('Unexpected syscall ' + n);
    } },
  };
  const sandbox = {
    api, console, DataView, Uint8Array,
    setTimeout(fn) { fn(); },
    fetch: async (path) => {
      events.push(path);
      assert.equal(path, expectedElf, 'only the embedded ELF is fetched');
      return {
        ok: !options.fetchFails,
        arrayBuffer: async () => options.badElf ? new ArrayBuffer(8) : bytes.buffer,
      };
    },
  };
  // The page's startup script hands the ELF over through window globals;
  // 'garbage' (no ELF magic) and 'wrongname' must fall back to the fetch.
  if (options.prefetched) {
    sandbox.window = {
      WAMP_PAYLOAD_BYTES: options.prefetched === 'garbage' ? new ArrayBuffer(0x2000) : bytes.buffer,
      WAMP_PAYLOAD_NAME: options.prefetched === 'wrongname' ? 'some-other.elf' : expectedElf,
    };
  }
  vm.createContext(sandbox);
  let error;
  try { await vm.runInContext(`(async function () { ${source}\n})().then(fn => fn(api))`, sandbox); }
  catch (e) { error = e; }
  return { error, events, sent, bytes, closed, unmapped, connections };
}

(async () => {
  // The happy path: the whole ELF arrives intact.
  const ok = await run();
  assert.ifError(ok.error);
  assert.deepEqual(ok.sent, [...ok.bytes]);
  assert.equal(ok.unmapped, 1);
  assert.equal(ok.closed, 1);
  assert.equal(ok.connections, 1);
  assert.deepEqual(ok.events, ['autoload.elf', 'map']);

  // Custom named payload passed via payload args.
  const custom = await run({ args: ['ps5-unified-autoloader-v0.1.5-915a65e.elf'] });
  assert.ifError(custom.error);
  assert.deepEqual(custom.sent, [...custom.bytes]);
  assert.deepEqual(custom.events, ['ps5-unified-autoloader-v0.1.5-915a65e.elf', 'map']);

  // Zero-copy hand-off: a proved backing-store pointer sends straight from the
  // page heap -- no mapping, no 12.9 MB copy, no write4 calls.
  const direct = await run({ direct: true });
  assert.ifError(direct.error);
  assert.deepEqual(direct.sent, [...direct.bytes]);
  assert.equal(direct.unmapped, 0);
  assert.deepEqual(direct.events, ['autoload.elf']);

  // An unprovable pointer (four samples do not match) falls back to the copy.
  const bogus = await run({ direct: true, directBogus: true });
  assert.ifError(bogus.error);
  assert.deepEqual(bogus.sent, [...bogus.bytes]);
  assert.equal(bogus.unmapped, 1);
  assert.deepEqual(bogus.events, ['autoload.elf', 'map']);

  // Prefetched bytes from the page's startup script: no fetch, same delivery.
  const prefetched = await run({ prefetched: true });
  assert.ifError(prefetched.error);
  assert.deepEqual(prefetched.sent, [...prefetched.bytes]);
  assert.deepEqual(prefetched.events, ['map'], 'no fetch when the page prefetched the ELF');

  // Prefetched bytes plus a proved pointer: the whole hand-off touches
  // neither the network nor a mapping.
  const prefetchedDirect = await run({ prefetched: true, direct: true });
  assert.ifError(prefetchedDirect.error);
  assert.deepEqual(prefetchedDirect.sent, [...prefetchedDirect.bytes]);
  assert.deepEqual(prefetchedDirect.events, []);

  // A stale or corrupt prefetch falls back to the fetch path.
  for (const mode of ['garbage', 'wrongname']) {
    const result = await run({ prefetched: mode });
    assert.ifError(result.error);
    assert.deepEqual(result.sent, [...result.bytes]);
    assert.deepEqual(result.events, ['autoload.elf', 'map'],
      'a bad prefetch must fall back to fetching for ' + mode);
  }

  // No kernel access means nothing is sent at all, and nothing is mapped.
  for (const options of [
    { noKrw: true }, { fetchFails: true }, { badElf: true }, { mmapFails: true },
  ]) {
    const result = await run(options);
    assert(result.error, 'expected a failure for ' + JSON.stringify(options));
    assert.equal(result.sent.length, 0);
    assert.equal(result.unmapped, 0);
  }

  // Failures after the ELF is mapped must still clean up.
  for (const options of [{ loaderFails: true }, { writeFails: true }]) {
    const result = await run(options);
    assert(result.error, 'expected a failure for ' + JSON.stringify(options));
    assert.equal(result.sent.length, 0);
    assert.equal(result.unmapped, 1, 'the mapping must be released');
  }

  console.log('Autoload checks passed: ELF staging, hand-off to elfldr, short writes and cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
