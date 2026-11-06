/**
 * N36: the Landlock helper, a small Python program run as `python3 -I -S -c <HELPER> <spec-json> -- <argv…>`.
 *
 * Why Python (ctypes) and not a native helper: it needs no compiler and ships no binaries, so it works on any Linux
 * with python3 behind a corporate firewall, and the reviewer reads every line of it here. The rule logic follows Qwen
 * Code's qwen-landlock-run.c (Apache-2.0, Copyright 2026 Qwen Team): ABI negotiation, file-only access masks for
 * non-directories, no_new_privs before restrict_self, parent-death signal. See docs/THIRD_PARTY.md.
 * Modified by Tugline contributors, 2026-10-31: reimplemented in Python; read grants exclude credential stores
 * (Qwen grants read on "/"); TCP connect/bind are restricted to the proxy port on ABI >= 4 (Qwen requires
 * network "open"); seccomp closes UDP/raw sockets (and all IP sockets with network "none"), and io_uring; ABI >= 6
 * scopes signals and abstract unix sockets; the helper stays as a child subreaper and kills every descendant when the
 * command ends or the harness goes away (Qwen execs the payload directly, so its grandchildren can outlive it).
 *
 * Spec (JSON, argv[1], or @file: read and deleted first): {
 *   ro: [paths], rw: [paths], file_rights_only: true,
 *   net: null | {connect: [ports]}      null = TCP unrestricted (network "host")
 *   ip: "all" | "tcp" | "none"          seccomp: "none" = no IP sockets, "tcp" = TCP only (no UDP/raw)
 *   unix: "deny" | "allow"             seccomp: "deny" = no socket(AF_UNIX) (host daemon sockets; WS17 review F2)
 *   max_abi: int, min_abi: int (default 3, Qwen's floor), ppid: int, require_net: bool,
 *   pty: bool                           run the command on a pseudo-terminal allocated before confinement
 * }
 * --probe prints {"abi": n} after applying a trivial ruleset (proves enforcement works here).
 * Exit codes: 125 = the sandbox could not be set up (nothing ran); otherwise the command's.
 */
export const LANDLOCK_HELPER_PY = String.raw`
import ctypes, json, os, platform, signal, struct, sys, time
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
libc.prctl.restype = ctypes.c_int
NR_CREATE, NR_ADD, NR_RESTRICT = 444, 445, 446
FS = [1 << i for i in range(16)]
EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = FS[0], FS[1], FS[2], FS[3]
REFER, TRUNCATE, IOCTL_DEV = FS[13], FS[14], FS[15]
FILE_RIGHTS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV
NET_BIND, NET_CONNECT = 1, 2
SCOPE_ABSTRACT_UNIX, SCOPE_SIGNAL = 1, 2

def die(msg):
    sys.stderr.write('Tugline sandbox (landlock): %s\n' % msg)
    sys.stderr.flush()
    os._exit(125)

def kernel_abi():
    r = libc.syscall(NR_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    return r if r > 0 else -ctypes.get_errno()

def fs_mask(abi):
    m = (1 << 13) - 1
    if abi >= 2: m |= REFER
    if abi >= 3: m |= TRUNCATE
    if abi >= 5: m |= IOCTL_DEV
    return m

def create_ruleset(abi, net_handled):
    fs = fs_mask(abi)
    net = (NET_BIND | NET_CONNECT) if (net_handled and abi >= 4) else 0
    scoped = (SCOPE_ABSTRACT_UNIX | SCOPE_SIGNAL) if abi >= 6 else 0
    if abi >= 6: attr = struct.pack('<QQQ', fs, net, scoped)
    elif abi >= 4: attr = struct.pack('<QQ', fs, net)
    else: attr = struct.pack('<Q', fs)
    buf = ctypes.create_string_buffer(attr, len(attr))
    fd = libc.syscall(NR_CREATE, buf, ctypes.c_size_t(len(attr)), ctypes.c_uint32(0))
    if fd < 0: die('cannot create the ruleset: %s' % os.strerror(ctypes.get_errno()))
    return fd, fs, net

def add_path(rfd, path, access):
    try:
        pfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    except OSError:
        return False  # gone since the wrapper listed it: nothing to grant
    try:
        import stat
        if not stat.S_ISDIR(os.fstat(pfd).st_mode): access &= FILE_RIGHTS
        b = ctypes.create_string_buffer(struct.pack('<Qi', access, pfd), 12)
        if libc.syscall(NR_ADD, ctypes.c_int(rfd), ctypes.c_int(1), b, ctypes.c_uint32(0)) != 0:
            die('cannot add a rule for %s: %s' % (path, os.strerror(ctypes.get_errno())))
    finally:
        os.close(pfd)
    return True

def add_port(rfd, port, access):
    b = ctypes.create_string_buffer(struct.pack('<QQ', access, port), 16)
    if libc.syscall(NR_ADD, ctypes.c_int(rfd), ctypes.c_int(2), b, ctypes.c_uint32(0)) != 0:
        die('cannot add a port rule: %s' % os.strerror(ctypes.get_errno()))

ARCH = {'x86_64': (0xC000003E, 41, 425), 'aarch64': (0xC00000B7, 198, 425)}

def seccomp(ip, unix):
    # ip == 'none': no AF_INET/AF_INET6 sockets at all; 'tcp': TCP stream sockets only (no UDP, raw, ICMP, MPTCP,
    # SCTP); 'all': any. Families other than unix, inet and netlink are refused unless ip == 'all'.
    # unix == 'deny': no socket(AF_UNIX) (WS17 review F2: Landlock cannot hide a daemon's socket path, and the Docker
    # socket is host root); socketpair(2) is a different syscall and stays allowed.
    # io_uring is closed whenever a filter is installed (its socket ops bypass a socket() filter); x32 and
    # foreign-arch syscalls are refused.
    if ip == 'all' and unix != 'deny': return
    m = platform.machine()
    if m not in ARCH: die('seccomp filter not available on %s' % m)
    arch, nr_socket, nr_uring = ARCH[m]
    ERRNO = 0x00050000 | 13  # SECCOMP_RET_ERRNO | EACCES
    ALLOW = 0x7fff0000
    LD, JEQ, JGE, RET, AND = 0x20, 0x15, 0x35, 0x06, 0x54
    p = []
    def i(code, jt, jf, k): p.append(struct.pack('<HBBI', code, jt, jf, k & 0xffffffff))
    i(LD, 0, 0, 4)               # 0 arch
    i(JEQ, 1, 0, arch)           # 1 → 3
    i(RET, 0, 0, ERRNO)          # 2 foreign arch
    i(LD, 0, 0, 0)               # 3 nr
    i(JGE, 0, 1, 0x40000000)     # 4 x32
    i(RET, 0, 0, ERRNO)          # 5
    i(JEQ, 0, 1, nr_uring)       # 6
    i(RET, 0, 0, ERRNO)          # 7
    i(JEQ, 1, 0, nr_socket)      # 8 → 10
    i(RET, 0, 0, ALLOW)          # 9 any other syscall
    i(LD, 0, 0, 16)              # 10 args[0] = domain
    i(JEQ, 0, 1, 1)              # 11 AF_UNIX → 12, else 13
    i(RET, 0, 0, ERRNO if unix == 'deny' else ALLOW)  # 12
    i(JEQ, 4, 0, 2)              # 13 AF_INET → 18
    i(JEQ, 3, 0, 10)             # 14 AF_INET6 → 18
    i(JEQ, 0, 1, 16)             # 15 AF_NETLINK (local kernel queries: getaddrinfo, ip) → 16, else 17
    i(RET, 0, 0, ALLOW)          # 16
    # 17 every other family (AF_PACKET, AF_VSOCK to the hypervisor, AF_TIPC, AF_ALG, Bluetooth, …): refused unless
    # the network is unrestricted (review finding 3)
    i(RET, 0, 0, ALLOW if ip == 'all' else ERRNO)
    if ip == 'all':
        i(RET, 0, 0, ALLOW)      # 18
    elif ip == 'none':
        i(RET, 0, 0, ERRNO)      # 18
    else:
        # review finding 3: Landlock's TCP rules cover only TCP sockets, so the protocol must be TCP too:
        # socket(AF_INET, SOCK_STREAM, IPPROTO_MPTCP=262) or IPPROTO_SCTP would connect anywhere
        i(LD, 0, 0, 24)          # 18 args[1] = type
        i(AND, 0, 0, 0xf)        # 19
        i(JEQ, 0, 4, 1)          # 20 SOCK_STREAM → 21, else 25
        i(LD, 0, 0, 32)          # 21 args[2] = protocol
        i(JEQ, 1, 0, 0)          # 22 0 (default: TCP) → 24
        i(JEQ, 0, 1, 6)          # 23 IPPROTO_TCP → 24, else 25
        i(RET, 0, 0, ALLOW)      # 24
        i(RET, 0, 0, ERRNO)      # 25
    prog = b''.join(p)
    filt = ctypes.create_string_buffer(prog, len(prog))
    fprog = struct.pack('<HxxxxxxQ', len(p), ctypes.addressof(filt))
    fbuf = ctypes.create_string_buffer(fprog, len(fprog))
    if libc.prctl(22, 2, fbuf, 0, 0) != 0:
        die('cannot install the seccomp filter: %s' % os.strerror(ctypes.get_errno()))

def descendants():
    kids = {}
    for d in os.listdir('/proc'):
        if not d.isdigit(): continue
        try:
            with open('/proc/%s/stat' % d) as f: s = f.read()
            ppid = int(s.rsplit(')', 1)[1].split()[1])
        except Exception:
            continue
        kids.setdefault(ppid, []).append(int(d))
    out, todo = [], [os.getpid()]
    while todo:
        for c in kids.get(todo.pop(), []):
            out.append(c); todo.append(c)
    return out

def kill_all():
    # Keep scanning for a short while even when nothing is found: a process can be between fork and exit of its
    # parent (setsid(1) forks when called by a group leader), and would reach us as an orphan a moment later.
    quiet, start = 0, time.time()
    while time.time() - start < 5:
        pids = descendants()
        for pid in pids:
            try: os.kill(pid, signal.SIGKILL)
            except OSError: pass
        try:
            while os.waitpid(-1, os.WNOHANG)[0] > 0: pass
        except ChildProcessError:
            pass
        quiet = 0 if pids else quiet + 1
        if quiet >= 3 and time.time() - start > 0.25: return
        time.sleep(0.03)

def main():
    args = sys.argv[1:]
    if args == ['--probe']:
        abi = kernel_abi()
        if abi < 1: die('Landlock is not available: %s' % os.strerror(-abi))
        rfd, _, _ = create_ruleset(abi, False)
        add_path(rfd, '/', EXECUTE | READ_FILE | READ_DIR)
        if libc.prctl(38, 1, 0, 0, 0) != 0: die('no_new_privs failed')
        if libc.syscall(NR_RESTRICT, ctypes.c_int(rfd), ctypes.c_uint32(0)) != 0: die('restrict_self failed')
        print(json.dumps({'abi': abi}))
        return 0
    if len(args) < 3 or args[1] != '--': die('usage: helper <spec> -- <argv>')
    if args[0].startswith('@'):
        with open(args[0][1:]) as f: spec = json.load(f)
        os.unlink(args[0][1:])
    else:
        spec = json.loads(args[0])
    argv = args[2:]
    # tied to the harness: SIGTERM when it goes away (the reaper then kills everything below)
    libc.prctl(1, signal.SIGTERM, 0, 0, 0)
    if spec.get('ppid') and os.getppid() != spec['ppid']: die('the harness exited during setup')
    abi = kernel_abi()
    if abi < 1: die('Landlock is not available in this kernel (%s)' % os.strerror(-abi))
    abi = min(abi, int(spec.get('max_abi') or 99))
    floor = max(3, int(spec.get('min_abi') or 3))  # Qwen's MIN_ABI: never lower, whatever the caller asks
    if abi < floor: die('Landlock ABI %d is below the required %d (truncate(2) is not controlled below ABI 3)' % (abi, floor))
    if spec.get('net') is not None and abi < 4 and spec.get('require_net'):
        die('network not restricted by Landlock (ABI %d < 4) and a sandbox is required: refusing' % abi)
    rfd, fs, net = create_ruleset(abi, spec.get('net') is not None)
    ro_rights = (EXECUTE | READ_FILE | READ_DIR) & fs
    for p in spec.get('ro', []): add_path(rfd, p, ro_rights)
    for p in spec.get('rw', []): add_path(rfd, p, fs)
    if net:
        for port in spec['net'].get('connect', []): add_port(rfd, int(port), NET_CONNECT)
    libc.prctl(36, 1, 0, 0, 0)  # child subreaper: orphans of the command come back to us
    master = slave = -1
    if spec.get('pty'):
        # sandboxed PTY execution: the terminal is allocated here, before the command is confined (it gets no
        # /dev/pts grant, so it cannot open the user's other terminals)
        import fcntl, termios
        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
        a = termios.tcgetattr(slave); a[1] &= ~termios.ONLCR; termios.tcsetattr(slave, termios.TCSANOW, a)
    child = os.fork()
    if child == 0:
        try:
            if slave >= 0:
                import fcntl, termios
                os.setsid(); fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                for fd in (0, 1, 2): os.dup2(slave, fd)
                os.close(master); os.close(slave)
            libc.prctl(1, signal.SIGKILL, 0, 0, 0)
            if libc.prctl(38, 1, 0, 0, 0) != 0: die('no_new_privs failed')
            seccomp(spec.get('ip', 'all'), spec.get('unix', 'deny'))
            if libc.syscall(NR_RESTRICT, ctypes.c_int(rfd), ctypes.c_uint32(0)) != 0:
                die('restrict_self failed: %s' % os.strerror(ctypes.get_errno()))
            os.close(rfd)
            for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, signal.SIG_DFL)
            os.execvp(argv[0], argv)
        except OSError as e:
            sys.stderr.write('%s: %s\n' % (argv[0], e.strerror)); sys.stderr.flush()
            os._exit(127)
        os._exit(125)
    os.close(rfd)
    relay = None
    if master >= 0:
        import threading
        os.close(slave)
        os.write(master, b'\x04')  # input is end-of-file
        def pump():
            while True:
                try: b = os.read(master, 65536)
                except OSError: b = b''
                if not b: return
                os.write(1, b)
        relay = threading.Thread(target=pump, daemon=True); relay.start()
    def stop(sig, _f):
        try: os.kill(child, sig)
        except OSError: pass
        kill_all()
        os._exit(128 + sig)
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, stop)
    code = 1
    while True:
        try:
            pid, st = os.waitpid(-1, 0)
        except ChildProcessError:
            break
        if pid == child:
            code = os.waitstatus_to_exitcode(st)
            code = 128 - code if code < 0 else code
            kill_all()  # the command is done: nothing it started may outlive it
            break
    if relay is not None: relay.join(2)
    return code

sys.exit(main())
`;
