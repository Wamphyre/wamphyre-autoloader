// Third payload in each chain page. The exploit runs second and brings up elfldr
// on port 9021, so this only has to stage the ELF and hand it over. No chain
// selection happens here: the page is already built for one chain.
//
// Resources are embedded by remote-loader's builder, so the fetch below is
// served from the page itself and still works after the exploit has taken the
// process over.
const NR = { SOCKET: 0x61, CONNECT: 0x62, WRITE: 4, CLOSE: 6, MMAP: 0x1dd, MUNMAP: 0x49 };

function failed(value) {
  return (value.low | 0) === -1;
}

async function connect(api) {
  const socket = await api.chain.syscall(NR.SOCKET, 2, 1, 0);
  if (failed(socket)) return -1;
  const fd = socket.low | 0;
  const addr = api.p.malloc(16, 1);
  for (let i = 0; i < 16; i++) api.p.write1(addr.add32(i), 0);
  // sockaddr_in: length, AF_INET, port 9021, loopback address.
  [16, 2, 0x23, 0x3d, 127, 0, 0, 1].forEach((v, i) => api.p.write1(addr.add32(i), v));
  try {
    const result = await api.chain.syscall(NR.CONNECT, fd, addr, 16);
    if ((result.low | 0) === 0) return fd;
  } catch (error) {
    await api.chain.syscall(NR.CLOSE, fd);
    throw error;
  }
  await api.chain.syscall(NR.CLOSE, fd);
  return -1;
}

// The ELF already lives in the page heap: the embedded fetch decodes it there.
// If its backing-store pointer can be proved to point at those bytes, elfldr can
// read the socket straight from it -- no 12.9 MB copy into a fresh mapping, no
// 3.2 M write4 calls, and no second 12.9 MB allocation during the hand-off.
// The copy stays as the fallback whenever the pointer cannot be proved.
function directElfAddress(api, bytes) {
  try {
    if (!api.p || typeof api.p.leakval !== "function") return null;
    const object = api.p.leakval(new Uint8Array(bytes));
    if (!object || typeof object.add32 !== "function") return null;
    const data = api.p.read8(object.add32(0x10));
    // Plausible user-space pointer (the WebProcess heap can sit above 4 GB).
    if (!data || data.hi >= 0x8000) return null;
    if (data.hi === 0 && (data.low >>> 0) < 0x10000) return null;
    if ((data.low & 3) !== 0) return null;
    // A wrong field would be a different pointer: four samples must match the
    // bytes we are about to hand over, or the safe copy path runs instead.
    const view = new DataView(bytes);
    const middle = ((bytes.byteLength >>> 1) >>> 2) << 2;
    const last = ((bytes.byteLength - 8) >>> 2) << 2;
    for (const offset of [0, 4, middle, last]) {
      if ((api.p.read4(data.add32(offset)) >>> 0) !== view.getUint32(offset, true))
        return null;
    }
    return data;
  } catch (error) {
    return null;
  }
}

// The page prefetches the ELF before the kernel exploit and hands it over here:
// a network fetch issued after the hijacked worker never returns (the loader
// documents exactly this for its kexp binaries). Pages that still embed the
// ELF keep the fetch path, which is served inline and needs no network.
function prefetchedElfBytes(elfName) {
  try {
    if (typeof window === "undefined" || !window.WAMP_PAYLOAD_BYTES) return null;
    if (window.WAMP_PAYLOAD_NAME && elfName && window.WAMP_PAYLOAD_NAME !== elfName)
      return null;
    const bytes = window.WAMP_PAYLOAD_BYTES;
    if (bytes.byteLength < 0x1000) return null;
    if (new DataView(bytes).getUint32(0, true) !== 0x464c457f) return null;
    return bytes;
  } catch (error) {
    return null;
  }
}

async function loadElf(api) {
  const elfName = (api && Array.isArray(api.args) && api.args[0]) || "autoload.elf";
  let bytes = prefetchedElfBytes(elfName);
  if (!bytes) {
    const response = await fetch(elfName);
    if (!response.ok) throw new Error("Could not load " + elfName + ".");
    bytes = await response.arrayBuffer();
  }
  const view = new DataView(bytes);
  if (bytes.byteLength < 0x1000 || view.getUint32(0, true) !== 0x464c457f)
    throw new Error(elfName + " is not an ELF binary.");
  const size = bytes.byteLength;

  const direct = directElfAddress(api, bytes);
  if (direct) return { name: elfName, base: direct, size, mapped: 0, bytes };

  const mapped = Math.ceil(size / 0x4000) * 0x4000;
  const base = await api.chain.syscall(NR.MMAP, 0, mapped, 3, 0x1002, -1, 0);
  if (failed(base)) throw new Error("Could not map " + elfName + ".");
  try {
    let i = 0;
    for (; i + 4 <= size; i += 4) api.p.write4(base.add32(i), view.getUint32(i, true));
    for (; i < size; i++) api.p.write1(base.add32(i), view.getUint8(i));
    if ((api.p.read4(base) >>> 0) !== 0x464c457f)
      throw new Error(elfName + " copy failed.");
    return { name: elfName, base, size, mapped, bytes };
  } catch (error) {
    await api.chain.syscall(NR.MUNMAP, base, mapped);
    throw error;
  }
}

return async function (api) {
  // Payload three of three, so the exploit has already run. If it did not publish
  // kernel access then nothing was achieved and no ELF should be sent.
  if (!api.krw) throw new Error("The exploit did not complete; no ELF was sent.");

  const elf = await loadElf(api);
  await api.log("Autoload: staging " + elf.name + " (" + elf.size + " bytes, " +
    (elf.mapped ? "mapped copy" : "zero-copy") + ")...", "info");
  let fd = -1;
  try {
    // The exploit brings elfldr up itself; give it a moment to start listening.
    for (let attempt = 0; attempt < 50; attempt++) {
      fd = await connect(api);
      if (fd >= 0) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (fd < 0) throw new Error("The ELF loader did not start on port 9021.");
    let sent = 0;
    while (sent < elf.size) {
      const want = Math.min(0x10000, elf.size - sent);
      // A short write is normal and simply continues; a failed one is retried
      // briefly before the transfer is called off, so a transient hiccup on
      // the loader's socket does not waste the kernel exploit that just
      // succeeded to get this far.
      let count = -1;
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await api.chain.syscall(NR.WRITE, fd, elf.base.add32(sent), want);
        count = result.low | 0;
        if (count > 0 && count <= want) break;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (count <= 0 || count > want) throw new Error("ELF transfer failed after " + sent + " bytes.");
      sent += count;
    }
    await api.log("Autoload: sent " + sent + " bytes of " + elf.name + " to elfldr.", "success");
  } finally {
    try {
      if (fd >= 0) await api.chain.syscall(NR.CLOSE, fd);
    } finally {
      if (elf.mapped) await api.chain.syscall(NR.MUNMAP, elf.base, elf.mapped);
    }
  }
};
