#!/usr/bin/env python3
"""Minimal Chrome DevTools Protocol (CDP) JS injector for Electron apps.

Pure standard library, no pip installs. It talks to an app's remote debugging
endpoint (the one you get from ``--remote-debugging-port=<n>``), attaches to
every renderer target and evaluates your script inside it. It can also launch
the app for you (auto-detects OpenCode Desktop on Windows).

Ways to change the injected code at any time
--------------------------------------------
* ``--live``       watch your ``-s`` files and re-inject on save (hot reload)
* ``-i/--interactive``  type JS on stdin; it runs immediately in every window

If neither ``-s`` nor ``-e`` is given, every ``.js`` file in the ``scripts``
directory next to this file is loaded automatically (``core.js`` first). That
mode always watches the directory, re-injecting when a file's content changes or
when files are added or removed.

Examples
--------
    python shuaqii.py --list
    python shuaqii.py --launch --restart            # auto-load scripts/*.js
    python shuaqii.py --launch --restart --live -s examples/sample-patch.js
    python shuaqii.py --launch --restart -s examples/sample-patch.js -i
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import queue
import re
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urlparse

# Single source of truth for the shuaqii version. It is shown in the overlay by
# scripts/core.js (via window.__shuaqii.version) and by ``shuaqii.py --version``.
__version__ = "0.0.1"

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Injected before every script run so the renderer-side overlay can label itself.
# ``injected`` doubles as a liveness marker: it lives only as long as the page's
# context, so when it disappears (the app reloaded the renderer) we know to re-inject.
# ``pass`` is a fresh id per injection pass: scripts stamp their registry entry with
# it (see scripts/core.js), and the sweep below evicts entries left behind by an
# earlier pass (e.g. a script file that was just deleted from the scripts dir).
_pass_seq = 0
# Each injector run gets its own id so its pass values never collide with a previous run's:
# the renderer/main registries persist across runs, and sweep() must be able to tell a
# script injected by *this* run from a stale one left by an earlier one.
_RUN_ID = os.urandom(4).hex()


def bootstrap_expression(pass_id):
    return (
        "window.__shuaqii = Object.assign(window.__shuaqii || {}, "
        f"{{ version: {json.dumps(__version__)}, injected: true, pass: {json.dumps(pass_id)} }});"
    )


def sweep_expression(pass_id):
    return (
        "(window.__sqScripts && window.__sqScripts.sweep) "
        f"? window.__sqScripts.sweep({json.dumps(pass_id)}) : 0"
    )


# Main-process equivalents. There is no core.js/registry in the main process, so a main
# script keeps its control object (with a ``dispose``) on ``globalThis.__shuaqiiMain[id]``
# and stamps it with the pass from ``globalThis.__shuaqii``. The sweep then disposes any
# entry left over from an earlier pass — the same "deleting the file unmounts it" behaviour
# the renderer gets from __sqScripts.sweep.
def main_bootstrap_expression(pass_id):
    return (
        "globalThis.__shuaqii = Object.assign(globalThis.__shuaqii || {}, "
        f"{{ pass: {json.dumps(pass_id)} }});"
    )


def main_sweep_expression():
    return (
        "(function () {"
        "  const box = globalThis.__shuaqiiMain;"
        "  const pass = globalThis.__shuaqii && globalThis.__shuaqii.pass;"
        "  if (!box) return 0;"
        "  let removed = 0;"
        "  for (const key of Object.keys(box)) {"
        "    const entry = box[key];"
        "    if (!entry || typeof entry.dispose !== 'function') continue;"
        "    if (entry.pass === pass) continue;"
        "    try { entry.dispose(); } catch (e) {}"
        "    delete box[key];"
        "    removed += 1;"
        "  }"
        "  return removed;"
        "})()"
    )


# True only while our injection is present in the page's current context.
LIVENESS_PROBE = "(window.__shuaqii && window.__shuaqii.injected) === true"

# Once we have talked to the debug port, losing it for this long means the target
# app has exited (or crashed): stop polling and end the script instead of warning
# forever about an unreachable endpoint.
PORT_LOST_GRACE = 3.0

DEFAULT_OPENCODE_PATHS = [
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\@opencode-aidesktop\OpenCode.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\opencode\OpenCode.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\opencode-desktop\OpenCode.exe"),
    os.path.expandvars(r"%PROGRAMFILES%\OpenCode\OpenCode.exe"),
]

# Where scripts are auto-loaded from when neither -s nor -e is given.
SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts")

# Comment marker that opts a script into being injected into the app's Electron main
# process as well as the renderer (a plain Node context, no ``window``), through the Node
# inspector opened by ``--inspect=<port>``. One file can then carry both halves and pick
# its branch based on whether ``window`` exists. See scripts/keep-awake.js.
MAIN_MARKER = "@shuaqii:main"

# Node inspector port used to reach the app's main process.
DEFAULT_INSPECT_PORT = 9229


def log(*args):
    print("[inject]", *args, flush=True)


def warn(*args):
    print("[inject]", *args, file=sys.stderr, flush=True)


def die(msg):
    print(f"[inject] error: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


# --------------------------------------------------------------------------- #
# HTTP: list debug targets
# --------------------------------------------------------------------------- #
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get_targets(host, port, timeout=3.0):
    url = f"http://{host}:{port}/json/list"
    try:
        with _OPENER.open(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ConnectionError(f"cannot reach {url}: {exc}") from exc


# --------------------------------------------------------------------------- #
# Minimal WebSocket client (RFC 6455, text frames, client masking)
# --------------------------------------------------------------------------- #
class WSError(Exception):
    pass


def mask_payload(payload, mask):
    """XOR *payload* with the repeating 4-byte WebSocket *mask*.

    Small frames use a plain loop; larger ones do a single big-int XOR, which runs
    in C instead of a per-byte Python loop.
    """
    n = len(payload)
    if n == 0:
        return b""
    if n < 256:
        return bytes(payload[i] ^ mask[i & 3] for i in range(n))
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


class WebSocket:
    def __init__(self, url):
        parts = urlparse(url)
        self.host = parts.hostname or "127.0.0.1"
        self.port = parts.port or 80
        self.path = parts.path + (f"?{parts.query}" if parts.query else "")
        self.sock = None
        self.buf = b""

    def connect(self, timeout=60.0):
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))

        while b"\r\n\r\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WSError("connection closed during handshake")
            self.buf += chunk
        head, _, rest = self.buf.partition(b"\r\n\r\n")
        self.buf = rest
        status = head.split(b"\r\n", 1)[0].decode("latin-1")
        if "101" not in status:
            raise WSError(f"handshake failed: {status}")
        return self

    def _read_exact(self, n):
        while len(self.buf) < n:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout as exc:
                raise WSError("timed out waiting for data") from exc
            if not chunk:
                raise WSError("connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _read_frame(self):
        b0, b1 = self._read_exact(2)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        mask = self._read_exact(4) if masked else None
        payload = self._read_exact(length) if length else b""
        if mask:
            payload = mask_payload(payload, mask)
        return fin, opcode, payload

    def _send_frame(self, opcode, payload=b""):
        header = bytes([0x80 | opcode])
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = mask_payload(payload, mask)
        self.sock.sendall(header + mask + masked)

    def send_text(self, text):
        self._send_frame(0x1, text.encode("utf-8"))

    def recv_message(self):
        data = b""
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x8:
                raise WSError("closed by peer")
            if opcode == 0x9:  # ping -> pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x1, 0x2):
                data = payload
            elif opcode == 0x0:
                data += payload
            else:
                continue
            if fin:
                return data.decode("utf-8", "replace")

    def close(self):
        try:
            if self.sock:
                self._send_frame(0x8)
        except Exception:  # noqa: BLE001
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:  # noqa: BLE001
            pass


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.seq = 0

    def send(self, method, params=None):
        self.seq += 1
        rid = self.seq
        self.ws.send_text(json.dumps({"id": rid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv_message())
            if msg.get("id") != rid:
                continue
            if "error" in msg:
                raise WSError(msg["error"].get("message", "cdp error"))
            return msg.get("result", {})

    def evaluate(self, expression, return_by_value=False, command_line_api=False):
        params = {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": return_by_value,
            "userGesture": True,
            "allowUnsafeEvalBlockedByCSP": True,
        }
        # Node's inspector only defines ``require`` in the console-like scope when the
        # command line API is enabled; main-process scripts rely on it to load electron.
        if command_line_api:
            params["includeCommandLineAPI"] = True
        return self.send("Runtime.evaluate", params)


# --------------------------------------------------------------------------- #
# script sources (with hot-reload support)
# --------------------------------------------------------------------------- #
class Script:
    def __init__(self, kind, value):
        self.kind = kind
        self.value = value
        if kind == "eval":
            self.name = "<inline>"
            self.code = value
        else:
            self.name = os.path.basename(os.path.abspath(value))
            self.code = ""
            self.reload()

    def reload(self):
        if self.kind == "eval":
            self.code = self.value
            return True
        try:
            with open(os.path.abspath(self.value), "r", encoding="utf-8") as fh:
                self.code = fh.read()
            return True
        except OSError as exc:
            warn(f"cannot read {self.value}: {exc}")
            return False

    def signature(self):
        if self.kind == "eval":
            return ("eval", self.value)
        try:
            st = os.stat(os.path.abspath(self.value))
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return None


def ordered_scripts(directory):
    """Return the .js files in *directory*: core.js first, then alphabetical."""
    try:
        names = sorted(
            (n for n in os.listdir(directory) if n.lower().endswith(".js")),
            key=lambda n: (n.lower() != "core.js", n.lower()),
        )
    except OSError:
        return []
    return [os.path.join(directory, n) for n in names]


def dir_signature(directory):
    """Map each .js path in *directory* to its (mtime_ns, size) stamp."""
    sig = {}
    for path in ordered_scripts(directory):
        try:
            st = os.stat(path)
        except OSError:
            continue
        sig[path] = (st.st_mtime_ns, st.st_size)
    return sig


def file_has_main_marker(path):
    """True when *path* opts into main-process injection (see MAIN_MARKER)."""
    try:
        with open(os.path.abspath(path), "r", encoding="utf-8") as fh:
            return MAIN_MARKER in fh.read()
    except OSError:
        return False


# --------------------------------------------------------------------------- #
# target helpers + persistent sessions
# --------------------------------------------------------------------------- #
def target_label(target):
    title = f'"{target.get("title")}"' if target.get("title") else "(untitled)"
    return f"{title} {target.get('url', '')}".strip()


_SKIP_SCHEMES = (
    "devtools://",
    "chrome://",
    "chrome-extension://",
    "chrome-untrusted://",
    "edge://",
    "about:",
)


def is_injectable(target):
    if target.get("type") not in ("page", "webview"):
        return False
    if not target.get("webSocketDebuggerUrl"):
        return False
    url = target.get("url") or ""
    if url.startswith(_SKIP_SCHEMES):
        return False
    return True


class Session:
    def __init__(self, target):
        self.target = target
        self.id = target.get("id")
        self.label = target_label(target)
        self.ws = WebSocket(target["webSocketDebuggerUrl"]).connect()
        self.cdp = CDP(self.ws)
        try:
            self.cdp.send("Runtime.enable")
        except WSError:
            pass

    def evaluate(self, code, return_by_value=False, command_line_api=False):
        return self.cdp.evaluate(
            code, return_by_value=return_by_value, command_line_api=command_line_api
        )

    def close(self):
        self.ws.close()


def report_exception(name, label, details):
    desc = (details.get("exception") or {}).get("description") or details.get("text")
    warn(f"{name} -> {label} threw: {desc}")


def inject_scripts(session, scripts):
    global _pass_seq
    _pass_seq += 1
    pass_id = f"{_RUN_ID}-{_pass_seq}"
    try:
        session.evaluate(bootstrap_expression(pass_id))
    except WSError as exc:
        raise WSError(f"version bootstrap: {exc}") from exc
    for script in scripts:
        try:
            result = session.evaluate(script.code)
        except WSError as exc:
            raise WSError(f"{script.name}: {exc}") from exc
        details = result.get("exceptionDetails")
        if details:
            report_exception(script.name, session.label, details)
        else:
            log(f"injected {script.name} -> {session.label}")
    # Registry entries not refreshed by this pass belong to scripts that are no
    # longer being injected (e.g. a file deleted from scripts/): unmount them so
    # their overlay lines and timers go away instead of lingering forever.
    try:
        result = session.evaluate(sweep_expression(pass_id), return_by_value=True)
    except WSError as exc:
        warn(f"registry sweep failed for {session.label}: {exc}")
        return
    removed = (result.get("result") or {}).get("value")
    if isinstance(removed, int) and removed > 0:
        log(f"removed {removed} stale script registration(s) from {session.label}")


def is_alive(session):
    """Return True while our injection is still present in *session*'s context."""
    try:
        result = session.evaluate(LIVENESS_PROBE, return_by_value=True)
    except (WSError, OSError):
        return False
    if result.get("exceptionDetails"):
        return False
    return result.get("result", {}).get("value") is True


class MainInjector:
    """Injects scripts into an Electron app's main process over its Node inspect port.

    The main process is a plain Node context (no ``window`` and no overlay/registry),
    reached through the inspector that ``--inspect=<port>`` opens; its target appears in
    the debug-target list as ``type: "node"``. Scripts are evaluated directly. A missing
    inspect port is a soft failure: we warn once and keep going, so a renderer-only setup
    still works.
    """

    def __init__(self, host, port, scripts):
        self.host = host
        self.port = port
        self.scripts = scripts
        self.session = None
        self.warned = False

    def _connect(self):
        targets = get_targets(self.host, self.port, timeout=1.0)
        for t in targets:
            if t.get("type") == "node" and t.get("webSocketDebuggerUrl"):
                return Session(t)
        raise ConnectionError("no node target on the inspect port")

    def ensure(self):
        """Connect if needed and inject the scripts. True once the inspector is reached."""
        if self.session is not None:
            return True
        try:
            self.session = self._connect()
        except (ConnectionError, WSError, OSError) as exc:
            if not self.warned:
                warn(
                    f"main-process inspect port {self.host}:{self.port} unreachable ({exc}); "
                    f"launch the app with --inspect={self.port} to run main scripts"
                )
                self.warned = True
            return False
        self.warned = False
        self.inject_all()
        return self.session is not None

    def inject_all(self):
        global _pass_seq
        if self.session is None:
            return
        _pass_seq += 1
        pass_id = f"{_RUN_ID}-{_pass_seq}"
        try:
            self.session.evaluate(main_bootstrap_expression(pass_id), command_line_api=True)
        except (WSError, OSError) as exc:
            warn(f"main bootstrap failed: {exc}")
            self.session = None
            return
        for script in list(self.scripts):
            self._eval(script)
        if self.session is None:
            return
        # Entries from earlier passes belong to files no longer being injected (deleted
        # marker script): dispose them so their timers/servers go away.
        try:
            result = self.session.evaluate(
                main_sweep_expression(), return_by_value=True, command_line_api=True
            )
        except (WSError, OSError) as exc:
            warn(f"main sweep failed: {exc}")
            self.session = None
            return
        removed = (result.get("result") or {}).get("value")
        if isinstance(removed, int) and removed > 0:
            log(f"main process: removed {removed} stale script registration(s)")

    def _eval(self, script):
        try:
            result = self.session.evaluate(script.code, command_line_api=True)
        except (WSError, OSError) as exc:
            warn(f"main inject failed for {script.name}: {exc}")
            self.session = None
            return
        details = result.get("exceptionDetails")
        if details:
            report_exception(script.name, "main process", details)
        else:
            log(f"injected {script.name} -> main process")


def eval_interactively(session, code):
    try:
        result = session.evaluate(code, return_by_value=True)
    except WSError as exc:
        return f"<error: {exc}>"
    details = result.get("exceptionDetails")
    if details:
        return (details.get("exception") or {}).get("description") or details.get("text")
    value = result.get("result", {})
    if "value" in value:
        try:
            return json.dumps(value["value"], ensure_ascii=False)
        except (TypeError, ValueError):
            return repr(value["value"])
    return value.get("description") or value.get("type", "undefined")


# --------------------------------------------------------------------------- #
# launch / restart helpers
# --------------------------------------------------------------------------- #
def find_opencode():
    for path in DEFAULT_OPENCODE_PATHS:
        if path and os.path.isfile(path):
            return path
    return None


def _tasklist(name):
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {name}", "/NH"],
            capture_output=True,
            text=True,
        ).stdout
    except OSError:
        return False
    return name.lower() in out.lower()


def stop_running(exe, wait_seconds=15.0):
    """Kill every running instance of the app so the debug port can bind."""
    name = os.path.basename(exe)
    if not _tasklist(name):
        return False
    log(f"stopping running {name} ...")
    subprocess.run(
        ["taskkill", "/F", "/T", "/IM", name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if not _tasklist(name):
            log(f"{name} stopped")
            return True
        time.sleep(0.25)
    warn(f"{name} still running after {wait_seconds:.0f}s")
    return True


def wait_for_port(host, port, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            get_targets(host, port, timeout=1.0)
            return True
        except ConnectionError:
            time.sleep(0.3)
    return False


def launch_app(exe, port, app_args, user_data_dir=None, inspect_port=None):
    args = [exe, f"--remote-debugging-port={port}"]
    if inspect_port:
        args.append(f"--inspect={inspect_port}")
    if user_data_dir:
        os.makedirs(user_data_dir, exist_ok=True)
        args.append(f"--user-data-dir={user_data_dir}")
    args += app_args
    log("launching:", " ".join(args))
    try:
        return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as exc:
        die(f"launch failed: {exc}")


def print_targets(targets):
    if not targets:
        log("no targets found")
        return
    for t in targets:
        mark = "*" if is_injectable(t) else " "
        print(f"{mark} [{t.get('type')}] {target_label(t)}")
    print("\n(*) injectable target")


def wait_for_first_targets(host, port, seconds):
    deadline = time.time() + seconds
    while True:
        try:
            targets = get_targets(host, port)
        except ConnectionError:
            targets = None
        if targets:
            return targets
        if time.time() > deadline:
            return targets or []
        time.sleep(0.3)


def _stdin_reader(box):
    while True:
        try:
            line = sys.stdin.readline()
        except Exception:  # noqa: BLE001
            line = ""
        if line == "":
            box.put(None)
            return
        box.put(line.rstrip("\r\n"))


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
class _AppendOrdered(argparse.Action):
    """Collect -s/-e values in the exact order they appear on the command line."""

    def __call__(self, parser, namespace, values, option_string=None):
        specs = getattr(namespace, "specs", None)
        if specs is None:
            specs = []
            setattr(namespace, "specs", specs)
        kind = "eval" if option_string in ("-e", "--eval") else "file"
        specs.append((kind, values))


class _AppendMain(argparse.Action):
    """Collect --main values (main-process scripts) in command-line order."""

    def __call__(self, parser, namespace, values, option_string=None):
        specs = getattr(namespace, "main_specs", None)
        if specs is None:
            specs = []
            setattr(namespace, "main_specs", specs)
        specs.append(values)


def build_parser():
    p = argparse.ArgumentParser(
        prog="shuaqii.py",
        description="Minimal CDP JS injector for Electron apps (standard library only).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  python shuaqii.py --list\n"
            "  python shuaqii.py --launch --restart  (auto-loads scripts/*.js and watches the dir)\n"
            "  python shuaqii.py --launch --restart --live -s examples/sample-patch.js\n"
            "  python shuaqii.py -s examples/sample-patch.js -i\n"
        ),
    )
    p.add_argument("-V", "--version", action="version", version=f"%(prog)s {__version__}")
    p.add_argument("-p", "--port", type=int, default=9222, help="remote debugging port (default 9222)")
    p.add_argument("-H", "--host", default="127.0.0.1", help="debug host (default 127.0.0.1)")
    p.add_argument("-s", "--script", action=_AppendOrdered, metavar="FILE", help="JS file to inject (repeatable)")
    p.add_argument("-e", "--eval", action=_AppendOrdered, metavar="CODE", help="inline JS to inject (repeatable)")
    p.add_argument(
        "--main",
        action=_AppendMain,
        metavar="FILE",
        help="JS file to inject into the Electron main process instead of the renderer "
        "(repeatable; needs the app launched with --inspect=<port>)",
    )
    p.add_argument(
        "--inspect-port",
        type=int,
        default=DEFAULT_INSPECT_PORT,
        metavar="N",
        help=f"main-process Node inspect port (default {DEFAULT_INSPECT_PORT})",
    )
    p.add_argument("-u", "--url", default=None, metavar="REGEX", help="only inject targets whose URL matches")
    p.add_argument("-w", "--watch", action="store_true", help="keep running and inject into new windows")
    p.add_argument("-t", "--timeout", type=float, default=0.0, metavar="SEC", help="stop after N seconds")
    p.add_argument("-l", "--list", action="store_true", dest="list_targets", help="list debug targets and exit")
    p.add_argument("--live", action="store_true", help="watch -s files and re-inject on save (hot reload)")
    p.add_argument("-i", "--interactive", action="store_true", help="read JS from stdin and run it in every window")
    p.add_argument(
        "--launch",
        nargs="?",
        const="__auto__",
        default=None,
        metavar="EXE",
        help="launch an Electron app with the debug port (auto-detects OpenCode Desktop if EXE omitted)",
    )
    p.add_argument(
        "--restart",
        action="store_true",
        help="DANGER: kill the running app before --launch. Do NOT use this from inside OpenCode "
        "Desktop (it would kill the host of your session); run it from an external terminal.",
    )
    p.add_argument(
        "--isolated",
        action="store_true",
        help="launch a separate debug copy with its own --user-data-dir (does NOT kill your running app)",
    )
    p.add_argument("--wait", type=float, default=0.0, metavar="SEC", help="seconds to wait for the debug port after --launch (default 25)")
    p.add_argument("app_args", nargs="*", help="extra args for the launched app (put them last)")
    p.set_defaults(specs=[], main_specs=[])
    return p


def main(argv):
    o = build_parser().parse_args(argv)

    if o.list_targets:
        print_targets(wait_for_first_targets(o.host, o.port, o.timeout or 5.0))
        return 0

    interactive = o.interactive
    live = o.live
    restart = o.restart
    launch = o.launch

    # Auto-load picks up scripts from the scripts dir and watches it. It only implies
    # --launch/--restart for a truly bare `python shuaqii.py` (no CLI args at all), the
    # "just make it work" case. When the user passed any flag (e.g. `shuaqii.py -i`),
    # forcing a restart would kill a running app — including the host of the current
    # session — so launch/restart stay opt-in.
    auto_dir = SCRIPTS_DIR if (not o.specs and ordered_scripts(SCRIPTS_DIR)) else None
    if auto_dir:
        live = True
        if not argv:
            restart = True
            launch = "__auto__"
        log(f"will auto-load renderer scripts from {auto_dir}")

    # Whether any script will also be sent to the main process (either explicitly via
    # --main, or opted in with the "@shuaqii:main" marker). Needed before launch so we can
    # pass --inspect when it is.
    def scripts_opt_into_main():
        if auto_dir is not None:
            return any(file_has_main_marker(p) for p in ordered_scripts(auto_dir))
        for kind, value in o.specs:
            marked = MAIN_MARKER in value if kind == "eval" else file_has_main_marker(value)
            if marked:
                return True
        return False

    have_main = bool(o.main_specs) or scripts_opt_into_main()
    if not o.specs and not auto_dir and not have_main and not interactive:
        die(
            f"no .js files in {SCRIPTS_DIR} (use -s <file> or -e <code>), or pass -i"
        )

    watch = o.watch or o.timeout > 0 or live or interactive

    url_filter = re.compile(o.url) if o.url else None

    if launch is not None:
        exe = find_opencode() if launch == "__auto__" else launch
        log(f"launching {exe}")
        if not exe:
            die("could not auto-detect the app; pass an explicit path via --launch <EXE>")
        user_data_dir = None
        if o.isolated:
            user_data_dir = os.path.join(tempfile.gettempdir(), "cdp-inject-opencode-profile")
        elif not restart and _tasklist(os.path.basename(exe)):
            warn(
                "an instance is already running: the new one will quit immediately "
                "(single-instance lock). Use --restart to replace it, or --isolated "
                "for a separate debug copy."
            )
        if restart and not o.isolated:
            warn(
                "--restart is about to terminate OpenCode. If this script runs inside OpenCode "
                "Desktop it will kill its own host/session; prefer running it from an external "
                "terminal or use launch-debug.cmd instead."
            )
            stop_running(exe)
        launch_app(
            exe,
            o.port,
            o.app_args,
            user_data_dir=user_data_dir,
            inspect_port=o.inspect_port if have_main else None,
        )

        ready = o.wait if o.wait > 0 else (25.0 if not o.isolated else 25.0)
        log(f"waiting up to {ready:.0f}s for debug port {o.port} ...")
        if wait_for_port(o.host, o.port, ready):
            log(f"debug port {o.port} is up")
        else:
            warn(f"debug port {o.port} never came up")
            if not watch:
                return 1

    # Load scripts only after the app has been launched and its debug port is up,
    # so reading/parsing the script files never delays startup.
    if auto_dir is not None:
        scripts = [Script("file", path) for path in ordered_scripts(auto_dir)]
    else:
        scripts = [Script(kind, value) for kind, value in o.specs]

    # Main-process scripts are the renderer scripts that opted in with the marker, plus
    # any explicit --main files (main-only).
    main_explicit = [Script("file", path) for path in o.main_specs]

    def build_main_scripts():
        return [s for s in scripts if MAIN_MARKER in s.code] + main_explicit

    main_scripts = build_main_scripts()

    for script in scripts:
        log(f"loaded script {script.name} ({len(script.code)} chars)")
    for script in main_explicit:
        log(f"loaded main script {script.name} ({len(script.code)} chars)")
    also_main = [s for s in scripts if MAIN_MARKER in s.code]
    if also_main:
        log("also injected into the main process: " + ", ".join(s.name for s in also_main))
    if live:
        log("live reload enabled: save a -s file to re-inject it")
        if auto_dir is not None and scripts:
            log(f"watching {auto_dir} for added/removed/changed scripts")

    sessions: dict[str, Session] = {}
    seen_sigs = {i: s.signature() for i, s in enumerate(scripts)}
    dir_sig = dir_signature(auto_dir) if auto_dir is not None else {}
    main_injector = MainInjector(o.host, o.inspect_port, main_scripts) if main_scripts else None
    main_explicit_sigs = {i: s.signature() for i, s in enumerate(main_explicit)}
    injected_once = False
    poll_delay = 0.5
    ever_connected = False
    lost_since = None
    target_gone = False

    inbox = queue.Queue()
    if interactive:
        threading.Thread(target=_stdin_reader, args=(inbox,), daemon=True).start()
        log("interactive: type JS and press Enter (one line = one expression). Ctrl-D/Ctrl-C to quit.")

    start = time.time()
    one_shot_deadline = start + (o.timeout if o.timeout > 0 else 10.0)
    hard_deadline = start + o.timeout if o.timeout > 0 else None

    def drop(sid, exc=None):
        s = sessions.pop(sid, None)
        if s:
            s.close()
        if exc:
            warn(f"dropped session {s.label}: {exc}")

    try:
        while True:
            activity = False
            try:
                targets = get_targets(o.host, o.port)
                ever_connected = True
                lost_since = None
            except ConnectionError as exc:
                targets = []
                if ever_connected:
                    # We were talking to the app and now we cannot: it most likely
                    # exited. Stop after a short grace period instead of warning
                    # on every poll forever.
                    if lost_since is None:
                        lost_since = time.time()
                        warn(str(exc))
                    elif time.time() - lost_since >= PORT_LOST_GRACE:
                        log("debug port is gone; target app appears to have exited, stopping")
                        target_gone = True
                elif watch:
                    warn(str(exc))

            if target_gone:
                break

            if main_injector is not None:
                main_injector.ensure()

            for t in targets:
                sid = t.get("id")
                if not is_injectable(t) or sid in sessions:
                    continue
                if url_filter and not url_filter.search(t.get("url", "")):
                    continue
                try:
                    session = Session(t)
                except (WSError, OSError) as exc:
                    warn(f"attach failed for {target_label(t)}: {exc}")
                    continue
                try:
                    if scripts:
                        inject_scripts(session, scripts)
                except WSError as exc:
                    warn(f"inject failed for {session.label}: {exc}")
                    session.close()
                    continue
                sessions[sid] = session
                injected_once = True
                activity = True

            # A reload (e.g. the app's "Reload" menu item) keeps the debugger target
            # but replaces the page context, dropping our injection; the target stays
            # in ``sessions`` so it would otherwise never be re-injected. Probe for the
            # marker and re-inject into any session that lost it.
            if scripts:
                for sid in list(sessions):
                    session = sessions.get(sid)
                    if session is None or is_alive(session):
                        continue
                    try:
                        inject_scripts(session, scripts)
                    except (WSError, OSError) as exc:
                        drop(sid, exc)
                        continue
                    log(f"re-injected {session.label} (page reloaded)")
                    activity = True

            if live:
                changed = False
                if auto_dir is not None:
                    new_sig = dir_signature(auto_dir)
                    if new_sig != dir_sig:
                        added = sorted(set(new_sig) - set(dir_sig))
                        removed = sorted(set(dir_sig) - set(new_sig))
                        modified = sorted(
                            p for p in set(new_sig) & set(dir_sig) if new_sig[p] != dir_sig[p]
                        )
                        scripts = [Script("file", path) for path in ordered_scripts(auto_dir)]
                        seen_sigs = {i: s.signature() for i, s in enumerate(scripts)}
                        dir_sig = new_sig
                        for path in added:
                            log(f"scripts dir: + {os.path.basename(path)}")
                        for path in modified:
                            log(f"scripts dir: ~ {os.path.basename(path)}")
                        for path in removed:
                            log(f"scripts dir: - {os.path.basename(path)}")
                        changed = True
                        activity = True
                else:
                    for i, script in enumerate(scripts):
                        if script.kind != "file":
                            continue
                        sig = script.signature()
                        if sig is not None and sig != seen_sigs.get(i):
                            if script.reload():
                                seen_sigs[i] = sig
                                changed = True
                                activity = True
                                log(f"reloaded {script.name} ({len(script.code)} chars)")
                if changed:
                    for sid in list(sessions):
                        try:
                            inject_scripts(sessions[sid], scripts)
                        except (WSError, OSError) as exc:
                            drop(sid, exc)

                wanted_main = build_main_scripts()
                if main_injector is None and wanted_main:
                    # A marker script appeared at runtime: open the main channel now.
                    main_injector = MainInjector(o.host, o.inspect_port, wanted_main)
                    activity = True
                if main_injector is not None:
                    # Marker scripts ride along with the renderer set (rebuilt above when
                    # `changed`); explicit --main files are tracked here on their own.
                    main_changed = changed
                    for i, script in enumerate(main_explicit):
                        if script.kind != "file":
                            continue
                        sig = script.signature()
                        if sig is not None and sig != main_explicit_sigs.get(i):
                            if script.reload():
                                main_explicit_sigs[i] = sig
                                main_changed = True
                                log(f"reloaded main script {script.name}")
                    if main_changed:
                        main_injector.scripts = wanted_main
                        main_injector.warned = False
                        activity = True
                        if main_injector.session is not None:
                            main_injector.inject_all()

            if interactive:
                try:
                    while True:
                        line = inbox.get_nowait()
                        if line is None:
                            raise KeyboardInterrupt
                        if not sessions:
                            warn("no windows to run it in")
                            continue
                        for sid in list(sessions):
                            try:
                                out = eval_interactively(sessions[sid], line)
                                print(f"[{sessions[sid].label}] => {out}", flush=True)
                            except (WSError, OSError) as exc:
                                drop(sid, exc)
                        activity = True
                except queue.Empty:
                    pass

            if not watch:
                main_ready = main_injector is None or main_injector.session is not None
                if injected_once and main_ready:
                    break
                if time.time() > one_shot_deadline:
                    warn("no injectable targets found in time")
                    break
            elif hard_deadline is not None and time.time() > hard_deadline:
                log("timeout reached, exiting")
                break

            if watch:
                # Idle targets/changes are cheap to miss briefly: back off to 2s when
                # quiet, snap back to 0.5s on any activity (new window, reload, input).
                poll_delay = 0.5 if activity else min(poll_delay * 1.5, 2.0)
                time.sleep(poll_delay)
            else:
                time.sleep(0.3)
    except KeyboardInterrupt:
        log("interrupted, exiting")
    finally:
        for session in sessions.values():
            session.close()
        if main_injector is not None and main_injector.session is not None:
            main_injector.session.close()

    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
