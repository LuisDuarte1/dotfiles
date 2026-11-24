import threading, time, re, shutil, os, signal as _signal, tempfile
import socket, json, base64, io, contextlib, traceback, codecs

_HAVE_SETSID = shutil.which('setsid') is not None

# We own SIGINT because xonsh's per-pipeline handler recurses into itself: interrupt
# only a running snippet, never the jobs, and never while idle.
_RUNNING = threading.Event()

def _on_sigint(signum, frame):
    if _RUNNING.is_set():
        raise KeyboardInterrupt

def _grab_sigint():
    try:
        _signal.signal(_signal.SIGINT, _on_sigint)
    except Exception:
        pass

_grab_sigint()

class _Job:
    def __init__(self, jid, cmd, cwd=None):
        self.id = jid; self.cmd = cmd; self.done = False
        self.returncode = None; self._cursor = 0
        self._path = tempfile.mktemp(prefix='bgdo_', suffix='.log')
        open(self._path, 'w').close()
        full = cmd if cwd is None else 'cd ' + cwd + ' && ' + cmd
        wrapped = '( ' + full + " ) > '" + self._path + "' 2>&1"
        if _HAVE_SETSID:
            self.pipe = !(setsid bash -c @(wrapped))
        else:
            self.pipe = !(bash -c @(wrapped))
        self.proc = getattr(self.pipe, 'proc', None)
        # Starting the pipeline hijacked SIGINT (xonsh PopenThread) — take it back,
        # or the next timeout SIGINT recurses inside xonsh and signals this job.
        _grab_sigint()
        self._t = threading.Thread(target=self._watch, daemon=True); self._t.start()
    def _watch(self):
        while True:
            rc = None
            try:
                rc = self.proc.poll() if self.proc is not None else None
            except Exception:
                rc = None
            if rc is not None or self.proc is None:
                self.returncode = rc; break
            time.sleep(0.03)
        self.done = True
    def _all_lines(self):
        try:
            data = open(self._path).read()
        except FileNotFoundError:
            return []
        lines = data.split('\n')
        if lines and lines[-1] == '':
            lines.pop()
        return lines
    def snapshot(self):
        return {'id': self.id, 'cmd': self.cmd, 'running': not self.done,
                'returncode': self.returncode, 'lines': len(self._all_lines()),
                'path': self._path}

_JOBS_FILE = (os.environ.get('BG_DO_SOCK') or tempfile.mktemp(prefix='bgdo_')) + '.jobs'

def _register(jid, pid, path, cmd):
    # Sidecar registry: even a force-killed engine leaves the ids, pids and logs
    # behind, so the next call can still tell the agent what is still running.
    try:
        with open(_JOBS_FILE, 'a') as fh:
            fh.write(json.dumps({'id': jid, 'pid': pid, 'log': path, 'cmd': cmd}) + '\n')
    except Exception:
        pass

def _tail(path, n):
    try:
        with open(path, 'rb') as fh:
            fh.seek(0, 2); size = fh.tell(); fh.seek(max(0, size - 65536)); data = fh.read()
    except OSError:
        return []
    lines = data.decode('utf-8', 'replace').split('\n')
    if lines and lines[-1] == '': lines.pop()
    if size > 65536 and lines: lines.pop(0)
    return [ln[:2000] for ln in lines[-n:]]

class _Watch:
    # One-shot: fires on the first matching line, or on exit. It reads the log by byte
    # offset, so a long build is scanned once rather than reread on every tick.
    def __init__(self, job, rx):
        self.job = job; self.rx = rx; self.pos = 0; self.part = ''
        self.dec = codecs.getincrementaldecoder('utf-8')('replace')
    def scan(self, final):
        try:
            fh = open(self.job._path, 'rb')
        except OSError:
            return None
        with fh:
            fh.seek(self.pos)
            while True:
                data = fh.read(1 << 20); self.pos += len(data)
                lines = (self.part + self.dec.decode(data, final and not data)).split('\n')
                self.part = lines.pop()[-65536:]
                for ln in lines:
                    if self.rx.search(ln): return ln[:2000]
                if not data: break
        if self.part and self.rx.search(self.part): return self.part[:2000]
        return None
    def check(self):
        done = self.job.done
        line = self.scan(done) if self.rx is not None else None
        if line is None and not done: return None
        j = self.job
        return {'event': 'notify', 'id': j.id, 'cmd': j.cmd, 'reason': 'exit' if line is None else 'match',
                'returncode': j.returncode if j.done else None, 'line': line, 'tail': _tail(j._path, 10)}

_WATCH_LOCK = threading.Lock()

class _BG:
    def __init__(self): self._jobs = {}; self._n = 0; self._watches = []
    def run(self, cmd, cwd=None, name=None):
        # Models guess name= (ignored: ids stay bg-N) and run(name, cmd), which puts the
        # command in cwd; refuse that here rather than start a job that dies on `cd`.
        if cwd is not None and not os.path.isdir(os.path.expanduser(os.path.expandvars(cwd))):
            raise ValueError('bg.run(cmd, cwd=None): cwd %r is not a directory (the command comes first)' % (cwd,))
        self._n += 1; jid = 'bg-%d' % self._n
        j = _Job(jid, cmd, cwd); self._jobs[jid] = j
        pid = getattr(j.proc, 'pid', None)
        # Announce the id as soon as it exists: if the snippet later crashes or is
        # interrupted, the agent still knows what it started and where to look.
        print('[bg] started %s (pid %s) log %s: %s'
              % (jid, pid, j._path, cmd if len(cmd) <= 120 else cmd[:117] + '...'))
        _register(jid, pid, j._path, cmd)
        return jid
    start = run
    def get(self, jid): return self._jobs[jid]
    def output(self, jid, mode='new'):
        j = self._jobs[jid]; lines = j._all_lines()
        if mode == 'all': return list(lines)
        out = lines[j._cursor:]; j._cursor = len(lines); return out
    def lines(self, jid): return self._jobs[jid]._all_lines()
    def tail(self, jid, n=20):
        return '\n'.join(self._jobs[jid]._all_lines()[-n:]) if n > 0 else ''
    def wait_for(self, jid, pattern, timeout=10.0):
        j = self._jobs[jid]
        rx = re.compile(pattern) if isinstance(pattern, str) else pattern
        deadline = time.time() + timeout; seen = 0
        while True:
            cur = j._all_lines()
            while seen < len(cur):
                ln = cur[seen]; seen += 1
                if rx.search(ln): return ln
            if j.done or time.time() > deadline: return None
            time.sleep(0.02)
    def wait(self, jid, timeout=None):
        j = self._jobs[jid]
        deadline = None if timeout is None else time.time() + timeout
        while not j.done:
            if deadline is not None and time.time() > deadline: break
            time.sleep(0.02)
        return j.snapshot()
    def kill(self, jid, sig='TERM'):
        j = self._jobs[jid]; pid = getattr(j.proc, 'pid', None)
        if pid is not None and not j.done:
            signum = getattr(_signal, 'SIG' + sig, _signal.SIGTERM)
            try:
                os.killpg(pid, signum) if _HAVE_SETSID else os.kill(pid, signum)
            except ProcessLookupError:
                pass
        return True
    def list(self): return [j.snapshot() for j in self._jobs.values()]
    def path(self, jid): return self._jobs[jid]._path
    def notify(self, jid, regex=None):
        j = self._jobs[jid]
        rx = None if regex is None else re.compile(regex)
        with _WATCH_LOCK: self._watches.append(_Watch(j, rx))
        on = 'exit' if rx is None else 'exit or a line matching %r' % rx.pattern
        print('[bg] notify %s on %s: end your turn, the message will start the next one' % (jid, on))

bg = _BG()

import sys as _sys
def _bgout(args, stdin=None, stdout=None, stderr=None):
    try:
        data = open(bg.path(args[0])).read()
    except Exception as e:
        (stderr or _sys.stderr).write(str(e) + '\n'); return 1
    (stdout or _sys.stdout).write(data); return 0
aliases['bgout'] = _bgout

_NS = {'bg': bg}

import builtins as _bi, types as _types

# Ban time.sleep in generated code (blind sleeps are an anti-pattern; use
# bg.wait_for / bg.wait). Only the exec namespace is affected, not the engine.
def _blocked_sleep(*a, **k):
    raise RuntimeError("time.sleep is disabled here — wait on events instead: bg.wait_for(id, regex) or bg.wait(id, timeout=...).")
_time_shim = _types.ModuleType('time')
for _n in dir(time):
    try:
        setattr(_time_shim, _n, getattr(time, _n))
    except Exception:
        pass
_time_shim.sleep = _blocked_sleep
_real_import = _bi.__import__
def _guard_import(name, *a, **k):
    return _time_shim if name == 'time' else _real_import(name, *a, **k)
_ns_builtins = dict(vars(_bi)); _ns_builtins['__import__'] = _guard_import
_NS['__builtins__'] = _ns_builtins
_NS['time'] = _time_shim

def _kill_all_jobs():
    for j in list(bg._jobs.values()):
        pid = getattr(j.proc, 'pid', None)
        if pid is not None and not j.done:
            try:
                os.killpg(pid, _signal.SIGKILL) if _HAVE_SETSID else os.kill(pid, _signal.SIGKILL)
            except Exception:
                pass
    try: os.unlink(_JOBS_FILE)
    except Exception: pass

def _jobs_line(after=None):
    parts = []
    for j in bg.list():
        try: n = int(j['id'].rsplit('-', 1)[1])
        except Exception: n = 0
        if after is not None and n <= after: continue
        parts.append('%s %s' % (j['id'], 'running' if j['running'] else 'exit=%s' % j['returncode']))
    return ', '.join(parts)

def _run_code(code):
    # Run one snippet with stdout+stderr captured at the fd level (so shell/pipeline output returns).
    err = None
    _before = bg._n
    _cap = tempfile.mktemp(prefix='bgcap_')
    _fd = os.open(_cap, os.O_RDWR | os.O_CREAT, 0o600)
    _o, _e = os.dup(1), os.dup(2)
    _grab_sigint(); _RUNNING.set()
    try:
        os.dup2(_fd, 1); os.dup2(_fd, 2)
        try:
            execx(code, 'exec', _NS, _NS)
        except KeyboardInterrupt:
            err = 'Interrupted (timeout)'
        except BaseException:
            err = traceback.format_exc()
        finally:
            try: _sys.stdout.flush()
            except Exception: pass
            try: _sys.stderr.flush()
            except Exception: pass
    finally:
        _RUNNING.clear()
        os.dup2(_o, 1); os.dup2(_e, 2); os.close(_o); os.close(_e); os.close(_fd)
    out = open(_cap).read(); os.remove(_cap)
    # A failed snippet must still hand back the ids: on error list every job, so the
    # agent can poll or kill instead of restarting work that is already running.
    tail = _jobs_line() if err else _jobs_line(_before)
    if tail:
        if out and not out.endswith('\n'): out += '\n'
        out += '[bg] jobs: %s\n' % tail
    return out, err

# The notifier thread and the serve loop both write frames, so every write holds
# _WLOCK and uses sendall: a frame that is cut or interleaved breaks the stream.
_WLOCK = threading.Lock()
_CLIENT = [None]
_QUEUE = []
_SENT_RUNNING = [None]

def _frame(obj):
    return base64.b64encode(json.dumps(obj).encode()) + b'\n'

def _running():
    return sum(1 for j in list(bg._jobs.values()) if not j.done)

# Only the latest count matters, so a change seen with no client is not queued:
# every attach sends the current count instead.
def _send_running():
    with _WLOCK:
        c = _CLIENT[0]; n = _running()
        if c is None or n == _SENT_RUNNING[0]: return
        try:
            c.sendall(_frame({'event': 'jobs', 'running': n})); _SENT_RUNNING[0] = n
        except Exception:
            _CLIENT[0] = None

def _emit(evt):
    with _WLOCK:
        c = _CLIENT[0]
        if c is not None:
            try:
                c.sendall(_frame(evt)); return
            except Exception:
                _CLIENT[0] = None
        _QUEUE.append(evt); del _QUEUE[:-100]

def _attach(conn):
    with _WLOCK:
        try:
            conn.sendall(_frame({'ready': True, 'pid': os.getpid()}))
            while _QUEUE:
                conn.sendall(_frame(_QUEUE[0])); _QUEUE.pop(0)
            n = _running()
            conn.sendall(_frame({'event': 'jobs', 'running': n})); _SENT_RUNNING[0] = n
        except Exception:
            return False
        _CLIENT[0] = conn
        return True

def _detach(conn):
    with _WLOCK:
        if _CLIENT[0] is conn: _CLIENT[0] = None
    try: conn.close()
    except Exception: pass

def _reply(conn, obj):
    with _WLOCK:
        try:
            conn.sendall(_frame(obj)); return True
        except Exception:
            return False

def _notifier():
    while True:
        time.sleep(0.1)
        with _WATCH_LOCK: watches = list(bg._watches)
        for w in watches:
            try:
                evt = w.check()
                if evt is None: continue
                _emit(evt)
                with _WATCH_LOCK: bg._watches.remove(w)
            except Exception:
                pass
        try: _send_running()
        except Exception: pass

# Persistent server: survives client (extension) disconnects so jobs live across
# a pi /reload. Self-exits (killing jobs) if no client reconnects within IDLE.
def _serve():
    path = os.environ['BG_DO_SOCK']
    IDLE = 1800
    try: os.unlink(path)
    except FileNotFoundError: pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path); srv.listen(5)
    while True:
        srv.settimeout(IDLE)
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            _kill_all_jobs(); break
        conn.settimeout(None)
        f = conn.makefile('rb', buffering=0)
        if not _attach(conn):
            _detach(conn); continue
        _exit = False
        while True:
            # Read requests one frame at a time so an interrupt arriving between
            # snippets is swallowed here instead of unwinding the serve loop.
            try:
                raw = f.readline()
            except KeyboardInterrupt:
                continue
            except Exception:
                break
            if not raw: break
            raw = raw.strip()
            if not raw: continue
            try:
                req = json.loads(base64.b64decode(raw))
            except Exception:
                continue
            if req.get('shutdown'):
                _kill_all_jobs(); _exit = True; break
            try:
                out, err = _run_code(req.get('code', ''))
            except KeyboardInterrupt:
                out, err = '', 'Interrupted (timeout)'
            if not _reply(conn, {'out': out, 'err': err}):
                break
        _detach(conn)
        if _exit:
            break
    try: os.unlink(path)
    except Exception: pass

threading.Thread(target=_notifier, daemon=True).start()
_serve()
