from __future__ import annotations

import ctypes
import hashlib
import hmac
import json
import logging
import os
import secrets
import signal
import sys
import threading
from dataclasses import asdict, dataclass
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from urllib.parse import urlparse

import chess
import chess.engine
import chess.pgn
import requests


ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "index.html"
STORE = ROOT / "saved_positions.json"
SETTINGS_STORE = ROOT / "settings.json"
ADMIN_TOKEN_FILE = ROOT / "admin_token.txt"
DEFAULT_USER_SETTINGS = {"engine_path": "", "depth": 46}
# Cap how many analyses can run at once so a malicious/careless visitor can't
# queue unlimited Stockfish processes on a publicly reachable server.
MAX_CONCURRENT_JOBS = 6
# ...and cap how many of those any single (anonymous) user can hold at once,
# so one person can't starve everyone else out of the shared pool.
MAX_JOBS_PER_USER = 4
# How long we'll wait for a freshly-launched executable to answer the UCI
# handshake before deciding it isn't a real chess engine.
ENGINE_VERIFY_TIMEOUT = 5.0
ANALYSIS_JOBS: dict[str, dict] = {}
ANALYSIS_CANCEL: dict[str, threading.Event] = {}
ANALYSIS_LOCK = threading.Lock()
LOGGER = logging.getLogger(__name__)

# Caps so a single analysis job (or a handful of them) never tries to claim
# every core/every byte of RAM on the machine.
MAX_TOTAL_THREADS = 32
MAX_TOTAL_HASH_MB = 8192
FALLBACK_TOTAL_HASH_MB = 2048


def _total_system_memory_mb() -> int:
    """Best-effort total physical RAM in MB. Falls back to a safe default."""
    try:
        if sys.platform == "win32":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.ullTotalPhys / (1024 * 1024))
        else:
            page_size = os.sysconf("SC_PAGE_SIZE")
            page_count = os.sysconf("SC_PHYS_PAGES")
            return int(page_size * page_count / (1024 * 1024))
    except (AttributeError, ValueError, OSError):
        pass
    return FALLBACK_TOTAL_HASH_MB * 4


def resource_budget() -> tuple[int, int]:
    """Total (threads, hash_mb) budget for Stockfish analysis on this machine.

    Leaves one core free for the OS/UI and uses a quarter of system RAM for
    engine hash tables, both capped so things stay reasonable.
    """
    total_threads = min(MAX_TOTAL_THREADS, max(1, (os.cpu_count() or 2) - 1))
    total_hash_mb = min(MAX_TOTAL_HASH_MB, max(256, _total_system_memory_mb() // 4))
    return total_threads, total_hash_mb


def per_job_resources(active_job_count: int) -> tuple[int, int]:
    """Split the total resource budget across `active_job_count` concurrent jobs."""
    total_threads, total_hash_mb = resource_budget()
    count = max(1, active_job_count)
    threads = max(1, total_threads // count)
    hash_mb = max(64, total_hash_mb // count)
    return threads, hash_mb


def _load_or_create_admin_token() -> str:
    """Return the shared admin secret, creating one on first run.

    Checked, in order: the CHESSDB_ADMIN_TOKEN environment variable, then a
    local admin_token.txt file (generated with a random value if missing).
    Keeping it out of the repo/settings JSON means it never gets served back
    to clients accidentally.
    """
    from_env = os.environ.get("CHESSDB_ADMIN_TOKEN", "").strip()
    if from_env:
        return from_env
    if ADMIN_TOKEN_FILE.exists():
        token = ADMIN_TOKEN_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    ADMIN_TOKEN_FILE.write_text(token, encoding="utf-8")
    return token


ADMIN_TOKEN = _load_or_create_admin_token()


def _migrate_legacy_settings(data: dict) -> dict:
    """Upgrade an old single-shared-engine settings.json to the per-user shape.

    Older versions of this app had one admin-controlled engine_path/depth for
    everyone. If we see that flat shape, keep it around as the "default" that
    brand-new (never-configured) users see pre-filled, but it no longer lives
    outside the per-user `users` map.
    """
    if "users" in data:
        return data
    legacy = {k: data[k] for k in ("engine_path", "depth") if k in data}
    return {"users": {}, "default": {**DEFAULT_USER_SETTINGS, **legacy}}


def _read_settings_store() -> dict:
    if not SETTINGS_STORE.exists():
        return {"users": {}, "default": dict(DEFAULT_USER_SETTINGS)}
    try:
        data = json.loads(SETTINGS_STORE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"users": {}, "default": dict(DEFAULT_USER_SETTINGS)}
    data = _migrate_legacy_settings(data)
    data.setdefault("users", {})
    data.setdefault("default", dict(DEFAULT_USER_SETTINGS))
    return data


def _write_settings_store(store: dict) -> None:
    temporary = SETTINGS_STORE.with_suffix(".tmp")
    temporary.write_text(json.dumps(store, indent=2), encoding="utf-8")
    temporary.replace(SETTINGS_STORE)


def get_user_settings(user_id: str) -> dict:
    """Each (anonymous) user has their own engine path/depth, not a shared one.

    New users are pre-filled with whatever "default" exists (e.g. migrated
    from an older single-admin setup), but saving always writes to their own
    bucket, never back to the shared default.
    """
    store = _read_settings_store()
    bucket = store["users"].get(user_id) if user_id else None
    merged = dict(store["default"])
    if bucket:
        merged.update({k: v for k, v in bucket.items() if k in DEFAULT_USER_SETTINGS})
    return merged


def set_user_settings(user_id: str, settings: dict) -> None:
    store = _read_settings_store()
    store["users"][user_id or "anonymous"] = {
        "engine_path": str(settings.get("engine_path", "")),
        "depth": int(settings.get("depth", DEFAULT_USER_SETTINGS["depth"])),
    }
    _write_settings_store(store)


# Only this exact official Stockfish 19 Windows universal build is trusted.
# A UCI engine can freely spoof its reported name, so the binary digest is the
# identity check; UCI metadata is still checked as an additional sanity check.
TRUSTED_STOCKFISH_SHA256 = "45bc8e4969147db9c2eb533810637994619bff0eacc81ccfd9854394901bcbd0"
_ENGINE_VERIFY_CACHE: dict[str, tuple[bool, str]] = {}
_ENGINE_VERIFY_LOCK = threading.Lock()


def verify_stockfish_executable(path_str: str) -> tuple[bool, str]:
    """Confirm `path_str` is a real Stockfish UCI engine, not just any file.

    Settings are per-user now (each visitor points at their own Stockfish
    install), so we can no longer trust that a configured path is safe just
    because an admin set it. Instead we briefly launch it and check that it
    actually speaks UCI and self-identifies as Stockfish, returning
    (ok, engine_name) on success or (False, reason) on failure.
    """
    cleaned = str(path_str).strip().strip('"')
    if not cleaned:
        return False, "No Stockfish executable path was provided."
    executable = Path(cleaned).expanduser()
    if not executable.is_file():
        return False, f"File not found: {executable}"
    if os.name == "nt" and executable.suffix.lower() != ".exe":
        return False, "On Windows, select the Stockfish .exe file, not a zip file or folder."
    digest = hashlib.sha256()
    try:
        with executable.open("rb") as binary:
            for chunk in iter(lambda: binary.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        return False, f"Could not read the executable: {exc}"
    file_hash = digest.hexdigest()
    with _ENGINE_VERIFY_LOCK:
        cached = _ENGINE_VERIFY_CACHE.get(file_hash)
    if cached:
        return cached
    if not hmac.compare_digest(file_hash, TRUSTED_STOCKFISH_SHA256):
        detail = (
            "The executable's SHA-256 does not match the trusted official "
            "Stockfish 19 Windows x86-64 universal build."
        )
        with _ENGINE_VERIFY_LOCK:
            _ENGINE_VERIFY_CACHE[file_hash] = (False, detail)
        return False, detail

    try:
        with chess.engine.SimpleEngine.popen_uci(
            [str(executable)], timeout=ENGINE_VERIFY_TIMEOUT
        ) as engine:
            name = str(engine.id.get("name", "")).strip()
            author = str(engine.id.get("author", "")).strip()
            required_options = {"Threads", "Hash", "MultiPV", "UCI_Chess960", "UCI_ShowWDL"}
            has_stockfish_options = required_options.issubset(engine.options)
    except (OSError, chess.engine.EngineError) as exc:
        ok, detail = False, f"Could not start this as a UCI chess engine: {exc}"
    else:
        if (
            name.lower() == "stockfish 19"
            and author.lower() == "the stockfish developers (see authors file)"
            and has_stockfish_options
        ):
            ok, detail = True, name or "Stockfish"
        else:
            ok = False
            detail = "The trusted binary did not report the expected Stockfish 19 identity and UCI options."

    with _ENGINE_VERIFY_LOCK:
        _ENGINE_VERIFY_CACHE[file_hash] = (ok, detail)
    return ok, detail


def suspend_process(process_id: int) -> tuple[bool, str | None]:
    """Freeze a process so it stops using CPU while keeping its memory intact.

    This is used to pause a running Stockfish analysis without losing its
    transposition table / search progress, so it can be resumed later with
    ``resume_process``. It is not a substitute for stopping a job: the
    process keeps whatever RAM (Hash) it already allocated while suspended.
    """
    if os.name == "nt":
        ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        open_process.restype = ctypes.c_void_p
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [ctypes.c_void_p]

        handle = open_process(0x0800, False, process_id)  # PROCESS_SUSPEND_RESUME
        if not handle:
            error = ctypes.FormatError(ctypes.get_last_error()).strip()
            return False, f"Could not open Stockfish process to pause it: {error}"
        try:
            status = ntdll.NtSuspendProcess(handle)
            if status != 0:
                return False, f"Pausing Stockfish failed (NTSTATUS {status:#x})"
        finally:
            close_handle(handle)
        return True, None

    try:
        os.kill(process_id, signal.SIGSTOP)
    except OSError as exc:
        return False, f"Could not pause Stockfish process: {exc}"
    return True, None


def resume_process(process_id: int) -> tuple[bool, str | None]:
    """Unfreeze a process previously frozen with ``suspend_process``."""
    if os.name == "nt":
        ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        open_process.restype = ctypes.c_void_p
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [ctypes.c_void_p]

        handle = open_process(0x0800, False, process_id)  # PROCESS_SUSPEND_RESUME
        if not handle:
            error = ctypes.FormatError(ctypes.get_last_error()).strip()
            return False, f"Could not open Stockfish process to resume it: {error}"
        try:
            status = ntdll.NtResumeProcess(handle)
            if status != 0:
                return False, f"Resuming Stockfish failed (NTSTATUS {status:#x})"
        finally:
            close_handle(handle)
        return True, None

    try:
        os.kill(process_id, signal.SIGCONT)
    except OSError as exc:
        return False, f"Could not resume Stockfish process: {exc}"
    return True, None


@dataclass
class SavedPosition:
    fen: str
    move_uci: str
    move_san: str
    pv: list[str]
    evaluation: str
    depth: str
    source: str
    saved_at: str


def read_saved() -> list[dict]:
    if not STORE.exists():
        return []
    items = json.loads(STORE.read_text(encoding="utf-8"))
    for item in items:
        item.setdefault("depth", "")
        item.setdefault("source", "")
    return items


def write_saved(items: list[dict]) -> None:
    temporary = STORE.with_suffix(".tmp")
    temporary.write_text(json.dumps(items, indent=2), encoding="utf-8")
    temporary.replace(STORE)


class Handler(BaseHTTPRequestHandler):
    def _is_admin(self) -> bool:
        token = self.headers.get("X-Admin-Token", "")
        return bool(token) and hmac.compare_digest(token, ADMIN_TOKEN)

    def _user_id(self) -> str:
        """Anonymous per-browser identity, used to scope settings/jobs.

        No accounts: the frontend generates a random id once and resends it
        as a header. Missing/blank falls back to a shared "anonymous" bucket
        (e.g. for direct API testing) rather than erroring out.
        """
        return self.headers.get("X-User-Id", "").strip() or "anonymous"

    def _json(self, status: int, body: object, headers: dict[str, str] | None = None) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(encoded)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            data = INDEX.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/api/saved":
            try:
                self._json(200, read_saved())
            except (OSError, ValueError) as exc:
                self._json(500, {"error": str(exc)})
            return
        if path == "/api/settings":
            settings = get_user_settings(self._user_id())
            if not self._is_admin():
                settings["depth"] = DEFAULT_USER_SETTINGS["depth"]
            self._json(200, settings)
            return
        if path == "/api/admin/verify":
            self._json(200, {"admin": self._is_admin()})
            return
        if path == "/api/analyze":
            user_id = self._user_id()
            with ANALYSIS_LOCK:
                jobs = [{"job_id": job_id, **job} for job_id, job in ANALYSIS_JOBS.items()
                        if job.get("status") in ("running", "paused") and job.get("owner") == user_id]
            self._json(200, jobs)
            return
        if path.startswith("/api/analyze/"):
            job_id = path.rsplit("/", 1)[-1]
            user_id = self._user_id()
            with ANALYSIS_LOCK:
                job = ANALYSIS_JOBS.get(job_id)
            if job is None or job.get("owner") != user_id:
                self._json(404, {"error": "Analysis job not found"})
            else:
                self._json(200, job)
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self._body()
            if path == "/api/saved":
                target = position_key(payload["fen"])
                items = [item for item in read_saved() if position_key(item["fen"]) != target]
                items.append(asdict(SavedPosition(**payload)))
                write_saved(items)
                self._json(200, items)
                return
            if path == "/api/remove":
                if not self._is_admin():
                    self._json(403, {"error": "Admin only"})
                    return
                target = position_key(payload["fen"])
                items = [item for item in read_saved() if position_key(item["fen"]) != target]
                write_saved(items)
                self._json(200, items)
                return
            if path == "/api/engine/verify":
                ok, detail = verify_stockfish_executable(payload.get("engine_path", ""))
                self._json(200, {"ok": ok, "name": detail if ok else None, "error": None if ok else detail})
                return
            if path == "/api/settings":
                engine_path = str(payload.get("engine_path", "")).strip().strip('"')
                stored_settings = get_user_settings(self._user_id())
                is_admin = self._is_admin()
                depth_value = (
                    int(payload.get("depth", stored_settings["depth"]))
                    if is_admin
                    else DEFAULT_USER_SETTINGS["depth"]
                )
                ok, detail = verify_stockfish_executable(engine_path)
                if not ok:
                    self._json(400, {"error": f"That Stockfish executable could not be verified: {detail}"})
                    return
                settings = {
                    "engine_path": engine_path,
                    "depth": depth_value if is_admin else stored_settings["depth"],
                }
                set_user_settings(self._user_id(), settings)
                self._json(200, {"engine_path": engine_path, "depth": depth_value})
                return
            if path == "/api/analyze":
                self._start_analysis(payload)
                return
            if path.startswith("/api/analyze/") and path.endswith("/stop"):
                job_id = path[len("/api/analyze/"):-len("/stop")].strip("/")
                self._stop_analysis(job_id)
                return
            if path.startswith("/api/analyze/") and path.endswith("/pause"):
                job_id = path[len("/api/analyze/"):-len("/pause")].strip("/")
                self._pause_analysis(job_id)
                return
            if path.startswith("/api/analyze/") and path.endswith("/resume"):
                job_id = path[len("/api/analyze/"):-len("/resume")].strip("/")
                self._resume_analysis(job_id)
                return
            if path == "/api/opening":
                self._opening_name(payload)
                return
            if path == "/api/lichess":
                self._cloud_eval(payload)
                return
            self._json(404, {"error": "Not found"})
        except (ValueError, KeyError, OSError, chess.engine.EngineError) as exc:
            self._json(400, {"error": str(exc)})

    def _start_analysis(self, payload: dict) -> None:
        user_id = self._user_id()
        stored_settings = get_user_settings(user_id)
        is_admin = self._is_admin()
        engine_path = str(payload.get("engine_path", stored_settings["engine_path"])).strip().strip('"')
        depth_value = (
            int(payload.get("depth", stored_settings["depth"]))
            if is_admin
            else DEFAULT_USER_SETTINGS["depth"]
        )
        if not engine_path:
            raise ValueError(
                "Set your Stockfish 19 executable path in Position and engine settings before analyzing."
            )
        ok, detail = verify_stockfish_executable(engine_path)
        if not ok:
            raise ValueError(f"That Stockfish executable could not be verified: {detail}")
        set_user_settings(
            user_id,
            {
                "engine_path": engine_path,
                "depth": depth_value if is_admin else stored_settings["depth"],
            },
        )
        effective_payload = {**payload, "engine_path": engine_path, "depth": depth_value}
        job_id = os.urandom(8).hex()
        with ANALYSIS_LOCK:
            active_jobs = [job for job in ANALYSIS_JOBS.values() if job.get("status") in ("running", "paused")]
            if len(active_jobs) >= MAX_CONCURRENT_JOBS:
                self._json(429, {"error": f"Too many analyses running (max {MAX_CONCURRENT_JOBS}). Try again shortly."})
                return
            user_active_jobs = [job for job in active_jobs if job.get("owner") == user_id]
            if len(user_active_jobs) >= MAX_JOBS_PER_USER:
                self._json(429, {
                    "error": f"You already have {MAX_JOBS_PER_USER} analyses running. "
                             "Stop one before starting another.",
                })
                return
            active_count = sum(1 for job in active_jobs if job.get("status") == "running") + 1
            threads, hash_mb = per_job_resources(active_count)
            ANALYSIS_JOBS[job_id] = {
                "status": "running",
                "depth": 0,
                "target_depth": depth_value,
                "fen": payload.get("fen", ""),
                "threads": threads,
                "hash": hash_mb,
                "owner": user_id,
            }
            ANALYSIS_CANCEL[job_id] = threading.Event()
        threading.Thread(target=self._analyze, args=(job_id, effective_payload, threads, hash_mb), daemon=True).start()
        self._json(202, {"job_id": job_id, "threads": threads, "hash": hash_mb})

    def _stop_analysis(self, job_id: str) -> None:
        user_id = self._user_id()
        with ANALYSIS_LOCK:
            job = ANALYSIS_JOBS.get(job_id)
            event = ANALYSIS_CANCEL.get(job_id)
        if job is None or job.get("owner") != user_id or event is None:
            self._json(404, {"error": "Analysis job not found"})
            return
        if job.get("status") == "paused" and job.get("pid") is not None:
            # A suspended engine process can't read the "stop"/"quit" UCI
            # commands, so resume it first or shutdown would hang.
            resume_process(job["pid"])
        event.set()
        self._json(200, {"status": "stopping"})

    def _pause_analysis(self, job_id: str) -> None:
        user_id = self._user_id()
        with ANALYSIS_LOCK:
            job = ANALYSIS_JOBS.get(job_id)
        if job is None or job.get("owner") != user_id:
            self._json(404, {"error": "Analysis job not found"})
            return
        pid = job.get("pid")
        if job.get("status") != "running" or pid is None:
            self._json(409, {"error": "Job is not currently running"})
            return
        ok, error = suspend_process(pid)
        if not ok:
            LOGGER.warning("Analysis job %s: %s", job_id, error)
            self._json(500, {"error": error or "Could not pause analysis"})
            return
        with ANALYSIS_LOCK:
            ANALYSIS_JOBS[job_id]["status"] = "paused"
        self._json(200, {"status": "paused"})

    def _resume_analysis(self, job_id: str) -> None:
        user_id = self._user_id()
        with ANALYSIS_LOCK:
            job = ANALYSIS_JOBS.get(job_id)
        if job is None or job.get("owner") != user_id:
            self._json(404, {"error": "Analysis job not found"})
            return
        pid = job.get("pid")
        if job.get("status") != "paused" or pid is None:
            self._json(409, {"error": "Job is not currently paused"})
            return
        ok, error = resume_process(pid)
        if not ok:
            LOGGER.warning("Analysis job %s: %s", job_id, error)
            self._json(500, {"error": error or "Could not resume analysis"})
            return
        with ANALYSIS_LOCK:
            ANALYSIS_JOBS[job_id]["status"] = "running"
        self._json(200, {"status": "running"})

    def _analyze(self, job_id: str, payload: dict, threads: int, hash_mb: int) -> None:
        def update(**values: object) -> None:
            with ANALYSIS_LOCK:
                ANALYSIS_JOBS[job_id].update(values)

        cancel_event = ANALYSIS_CANCEL[job_id]
        try:
            if cancel_event.is_set():
                update(status="stopped")
                return
            board = chess.Board(payload["fen"])
            engine_path = str(payload.get("engine_path", "")).strip().strip('"')
            if not engine_path:
                raise ValueError(
                    "Select the Stockfish 19 executable. Use the full path to the .exe file."
                )
            executable = Path(engine_path).expanduser()
            if not executable.is_file():
                raise ValueError(
                    f"Stockfish executable was not found:\n{executable}\n"
                    "Select the Stockfish .exe file, not its containing folder."
                )
            if os.name == "nt" and executable.suffix.lower() != ".exe":
                raise ValueError(
                    "On Windows, select the Stockfish .exe executable, "
                    "not a zip file or another file."
                )
            depth = int(payload.get("depth", 24))
            stopped = False
            with chess.engine.SimpleEngine.popen_uci([str(executable)]) as engine:
                update(pid=engine.transport.get_pid())
                engine_options = engine.options
                requested_options = {
                    "Threads": threads,
                    "Hash": hash_mb,
                    "Syzygy50MoveRule": False,
                }
                engine.configure({
                    name: value
                    for name, value in requested_options.items()
                    if name in engine_options
                })
                result = {}
                with engine.analysis(board, chess.engine.Limit(depth=depth)) as analysis:
                    for info in analysis:
                        if cancel_event.is_set():
                            stopped = True
                            break
                        current_depth = int(info.get("depth", 0))
                        update(depth=current_depth, progress=min(99, round(current_depth / depth * 100)))
                        result = info
        except (FileNotFoundError, PermissionError, OSError) as exc:
            update(status="error", error=(
                f"Windows could not start Stockfish:\n{exc}\n"
                "Verify that the selected file is the Stockfish 19 Windows executable."
            ))
            return
        except Exception as exc:
            update(status="error", error=str(exc))
            return
        finally:
            with ANALYSIS_LOCK:
                ANALYSIS_CANCEL.pop(job_id, None)
        if stopped or cancel_event.is_set():
            update(status="stopped")
            return
        if not result.get("pv") or "score" not in result:
            update(status="error", error="Stockfish returned no analysis result.")
            return
        pv = result.get("pv", [])
        temp = board.copy()
        san = []
        for move in pv:
            san.append(temp.san(move))
            temp.push(move)
        score = result["score"].white()
        mate = score.mate()
        if mate is not None:
            score_text = f"#{mate}"
        else:
            centipawns = score.score()
            if centipawns is None:
                update(status="error", error="Stockfish returned an unsupported evaluation score.")
                return
            score_text = f"{centipawns / 100:+.2f}"
        update(status="complete", progress=100, result={
                "move_uci": pv[0].uci() if pv else "",
                "pv": [move.uci() for move in pv],
                "pv_san": san,
                "evaluation": score_text,
                "depth": f"Depth {result.get('depth', depth)}",
            })

    def _cloud_eval(self, payload: dict) -> None:
        response = requests.get(
            "https://lichess.org/api/cloud-eval",
            params={"fen": payload["fen"], "multiPv": 3},
            headers={"Accept": "application/json", "User-Agent": "MyChessDB/0.1"},
            timeout=15,
        )
        if response.status_code == 404:
            self._json(200, {"depth": None, "knodes": None, "lines": []})
            return
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            headers = {"Retry-After": retry_after} if retry_after else None
            message = (
                f"Lichess Cloud is rate-limiting requests. Try again in about {retry_after} seconds."
                if retry_after
                else "Lichess Cloud is rate-limiting requests. Lichess did not provide an exact retry time."
            )
            self._json(429, {"error": message, "retry_after": retry_after}, headers)
            return
        response.raise_for_status()
        data = response.json()
        board = chess.Board(payload["fen"])
        lines = []
        for pv in data.get("pvs", []):
            temp = board.copy()
            uci_moves = pv.get("moves", "").split()
            san_moves = []
            for uci in uci_moves:
                move = chess.Move.from_uci(uci)
                san_moves.append(temp.san(move))
                temp.push(move)
            lines.append({
                "move_uci": uci_moves[0] if uci_moves else "",
                "pv_san": san_moves,
                "evaluation": (
                    f"mate {pv['mate']}"
                    if "mate" in pv
                    else f"{pv.get('cp', 0) / 100:+.2f}"
                ),
            })
        self._json(200, {
            "depth": data.get("depth"),
            "knodes": data.get("knodes"),
            "lines": lines,
        })

    def _opening_name(self, payload: dict) -> None:
        fen = payload.get("fen")
        if not isinstance(fen, str) or not fen.strip():
            self._json(400, {"error": "A FEN position is required"})
            return
        try:
            board = chess.Board(fen)
        except ValueError as exc:
            self._json(400, {"error": f"Invalid FEN: {exc}"})
            return

        try:
            catalog = opening_index()
            moves = payload.get("moves")
            if moves is None:
                opening = catalog.get(position_key(board.fen()))
                result = {**(opening or {"eco": None, "name": None}), "line": ""}
            else:
                if not isinstance(moves, list) or len(moves) > 512:
                    self._json(400, {"error": "Moves must be a list containing at most 512 UCI moves"})
                    return
                replay = chess.Board()
                san_moves = []
                latest_opening = None
                latest_opening_ply = 0
                for ply, uci in enumerate(moves, start=1):
                    if not isinstance(uci, str):
                        self._json(400, {"error": f"Move {ply} must be a UCI string"})
                        return
                    try:
                        move = chess.Move.from_uci(uci)
                    except ValueError:
                        self._json(400, {"error": f"Invalid UCI move at ply {ply}: {uci}"})
                        return
                    if move not in replay.legal_moves:
                        self._json(400, {"error": f"Illegal move at ply {ply}: {uci}"})
                        return
                    san_moves.append(replay.san(move))
                    replay.push(move)
                    opening = catalog.get(position_key(replay.fen()))
                    if opening:
                        latest_opening = opening
                        latest_opening_ply = ply

                if position_key(replay.fen()) != position_key(board.fen()):
                    self._json(400, {"error": "The move sequence does not lead to the supplied FEN"})
                    return
                result = {
                    **(latest_opening or {"eco": None, "name": None}),
                    "line": format_san_line(san_moves),
                    "continuation": san_moves[latest_opening_ply:],
                }
        except (OSError, ValueError) as exc:
            LOGGER.exception("Could not load the local opening catalog")
            self._json(500, {"error": f"Could not load opening names: {exc}"})
            return
        self._json(200, result)

    def _legacy_opening_explorer(self, payload: dict) -> None:
        token = payload.get("token", "").strip()
        if not token:
            raise ValueError(
                "Lichess now requires an API token for Opening Explorer. "
                "Create one at https://lichess.org/account/oauth/token and enter it."
            )
        response = requests.get(
            "https://explorer.lichess.org/lichess",
            params={"fen": payload["fen"]},
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": "MyChessDB/0.1",
            },
            timeout=15,
        )
        if response.status_code == 401:
            raise ValueError(
                "Lichess rejected the token. Check that it is valid and has not been revoked."
            )
        response.raise_for_status()
        data = response.json()
        self._json(200, {"moves": data.get("moves", [])})

    def log_message(self, _format: str, *_args: object) -> None:
        return


def position_key(fen: str) -> str:
    """Ignore move clocks so the same board position matches saved analysis."""
    return " ".join(fen.split()[:4])


def format_san_line(moves: list[str]) -> str:
    """Format SAN moves from the initial position with standard move numbers."""
    formatted = []
    for ply in range(0, len(moves), 2):
        move_number = ply // 2 + 1
        white_move = f"{move_number}. {moves[ply]}"
        if ply + 1 < len(moves):
            formatted.append(f"{white_move} {moves[ply + 1]}")
        else:
            formatted.append(white_move)
    return " ".join(formatted)


@lru_cache(maxsize=1)
def opening_index() -> dict[str, dict[str, str]]:
    """Load the local Lichess opening catalog, indexed by its final position."""
    index: dict[str, dict[str, str]] = {}
    for volume in "abcde":
        path = ROOT / "openings" / f"{volume}.tsv"
        with path.open(encoding="utf-8") as catalog:
            next(catalog, None)
            for line_number, line in enumerate(catalog, start=2):
                fields = line.rstrip("\r\n").split("\t", 2)
                if len(fields) != 3:
                    raise ValueError(f"Malformed opening entry at {path}:{line_number}")
                eco, name, pgn = fields
                game = chess.pgn.read_game(StringIO(pgn))
                if game is None or game.errors:
                    raise ValueError(f"Invalid opening moves at {path}:{line_number}")
                board = game.end().board()
                key = position_key(board.fen())
                index.setdefault(key, {"eco": eco, "name": name})
    return index


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    print("My Chess DB: http://127.0.0.1:8765")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
