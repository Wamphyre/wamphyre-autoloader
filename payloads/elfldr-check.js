// First payload: stop before the kernel exploit or autoload when an ELF loader
// already accepts connections on loopback. The runner has prepared WebKit/ROP,
// so this can probe a raw TCP socket without sending any data or needing krw.
const NR = { SOCKET: 0x61, CONNECT: 0x62, CLOSE: 6 };

// A refused connection can mean "no loader" or "the previous run's loader is
// still starting". Re-probe briefly so a mid-startup elfldr is not mistaken
// for a dead one: re-running the kernel exploit while elfldr is coming up is
// exactly the double-exploit case this payload exists to prevent.
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_MS = 400;

// Relapse's very first kernel-side action is a KASLR leak through a routing
// socket, and it hard-fails when no network interface carries an address.
// Mirror upstream's firstInterfaceAddress() here so the queue can stop with a
// precise, non-retryable reason BEFORE the kernel is ever touched, instead of
// burning a full exploit attempt on a guaranteed "kaslr: no interface has an
// address". Poops works without a network interface, so only the relapse
// chain asks.
const SYS_NETGETIFLIST = 0x7d;
const IF_RECORD = 0x3c0;
const IF_IP = 40;

async function relapseHasInterface(api) {
  // Without the syscall stub in this firmware's table the check cannot run;
  // let the exploit decide for itself rather than guess.
  if (!(api.syscalls && api.syscalls[SYS_NETGETIFLIST])) return true;
  const count = (await api.chain.syscall(SYS_NETGETIFLIST, 0, 10)).low | 0;
  if (count <= 0 || count > 256) return false;
  const list = api.p.malloc(IF_RECORD * count, 1);
  if (((await api.chain.syscall(SYS_NETGETIFLIST, list, count)).low | 0) < 0)
    return false;
  for (let i = 0; i < count; i++) {
    let any = false;
    for (let b = 0; b < 4 && !any; b++)
      any = api.p.read1(list.add32(IF_RECORD * i + IF_IP + b)) !== 0;
    if (any) return true;
  }
  return false;
}

return async function (api) {
  const chain = (api.args || []).find((a) => a === 'relapse' || a === 'poops') || null;
  try {
    const addr = api.p.malloc(16, 1);
    for (let i = 0; i < 16; i++) api.p.write1(addr.add32(i), 0);
    // sockaddr_in: length, AF_INET, network-order port 9021, 127.0.0.1.
    [16, 2, 0x23, 0x3d, 127, 0, 0, 1].forEach((v, i) => api.p.write1(addr.add32(i), v));

    let connected = false;
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      const socket = await api.chain.syscall(NR.SOCKET, 2, 1, 0);
      if ((socket.low | 0) === -1) throw new Error('Could not create the ELF loader probe socket.');
      const fd = socket.low | 0;
      try {
        const result = await api.chain.syscall(NR.CONNECT, fd, addr, 16);
        connected = (result.low | 0) === 0;
      } finally {
        // Every descriptor is closed before the loop continues, error or not,
        // so a later attempt can never leak an fd from an earlier one.
        const closed = await api.chain.syscall(NR.CLOSE, fd);
        if ((closed.low | 0) === -1) throw new Error('Could not close the ELF loader probe socket.');
      }
      if (connected) break;
      if (attempt < PROBE_ATTEMPTS)
        await new Promise(resolve => setTimeout(resolve, PROBE_RETRY_MS));
    }

    if (connected) {
      api.stopQueue('ELF loader is already accepting connections on 127.0.0.1:9021');
      await api.log('ELF loader is already running. Skipping the kernel exploit and autoload.', 'success');
      return;
    }

    if (chain === 'relapse' && !(await relapseHasInterface(api))) {
      api.stopQueue('Relapse requires an active network connection; none is available');
      await api.log('Relapse needs a network interface with an address for its KASLR leak, and none is available.', 'error');
      await api.log('Connect the console to your network (Ethernet or Wi-Fi -- no Internet access required) or switch to the Poops chain, then relaunch.', 'info');
      return;
    }
    if (chain === 'relapse')
      await api.log('A network interface with an address is available for Relapse.', 'info');

    await api.log('No ELF loader is accepting connections on port 9021. Continuing.', 'info');
  } catch (error) {
    // An unexpected probe failure is not evidence that it is safe to exploit
    // again. The queue normally continues on errors, so stop it explicitly.
    api.stopQueue('Could not check whether the ELF loader is already running');
    throw error;
  }
};
