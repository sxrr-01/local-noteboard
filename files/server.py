#!/usr/bin/env python3
"""Noteboard: anonymous notes and replies, stored in a single JSON file.

Zero dependencies (Python 3.8+ standard library only).
Run:  python3 server.py
Env:  HOST (default 0.0.0.0), PORT (default 3000)

Admin actions (delete, pin) require a login. The password lives in plain text
in admin_password.txt next to this file. It is read on every login attempt, so
you can change it without restarting. It is never sent to the browser or served.
"""

import hmac
import json
import os
import re
import secrets
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
DATA_FILE = DATA_DIR / "notes.json"
PASSWORD_FILE = BASE_DIR / "admin_password.txt"
BLACKLIST_FILE = BASE_DIR / "ip_blacklist.txt"
DEFAULT_PASSWORD = "56781234"

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "3000"))

MAX_BODY_BYTES = 64 * 1024
MAX_TITLE = 120
MAX_NOTE = 5000
MAX_REPLY = 3000
MAX_BATCH = 1000

COOKIE_NAME = "nb_session"
SESSION_TTL = 12 * 60 * 60      # seconds
MAX_FAILS = 5                   # wrong passwords before a short lockout
LOCKOUT_SECONDS = 60

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
}

ID_RE = re.compile(r"^[0-9a-f]{32}$")
REPLY_ROUTE = re.compile(r"^/api/notes/([0-9a-f]{32})/replies$")

lock = threading.Lock()           # guards the notes file
session_lock = threading.Lock()   # guards sessions and failure counters
sessions = {}                     # token -> expiry timestamp
failures = {}                     # ip -> [fail_count, locked_until]
ip_lock = threading.Lock()        # guards ip_blacklist.txt

# ---- storage ---------------------------------------------------------------

def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_notes():
    if not DATA_FILE.exists():
        return []
    with DATA_FILE.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_notes(notes):
    """Write atomically so a crash never leaves a half-written file."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(notes, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, DATA_FILE)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


# ---- admin password and sessions ------------------------------------------



def ensure_blacklist_file():
    if not BLACKLIST_FILE.exists():
        BLACKLIST_FILE.write_text("", encoding="utf-8")

def log_ip(ip):
    with ip_lock:
        try:
            known = BLACKLIST_FILE.read_text(encoding="utf-8").split()
        except OSError:
            known = []
        if ip not in known:
            with BLACKLIST_FILE.open("a", encoding="utf-8") as f:
                f.write(ip + "\n")

def is_blacklisted(ip):
    with ip_lock:
        try:
            return ip in BLACKLIST_FILE.read_text(encoding="utf-8").split()
        except OSError:
            return False

def ensure_password_file():
    if not PASSWORD_FILE.exists():
        PASSWORD_FILE.write_text(DEFAULT_PASSWORD + "\n", encoding="utf-8")


def read_admin_password():
    try:
        return PASSWORD_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def purge_sessions():
    """Call with session_lock held."""
    now = time.time()
    for token in [t for t, exp in sessions.items() if exp <= now]:
        del sessions[token]


# ---- validation ------------------------------------------------------------

class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def clean_text(value, field, max_len, required=True):
    if not isinstance(value, str):
        raise HttpError(400, f"{field} must be text.")
    value = value.replace("\r\n", "\n").strip()
    if required and not value:
        raise HttpError(400, f"{field} cannot be empty.")
    if len(value) > max_len:
        raise HttpError(400, f"{field} is too long (max {max_len} characters).")
    return value


def clean_ids(value, field):
    if not isinstance(value, list) or len(value) > MAX_BATCH:
        raise HttpError(400, f"{field} must be a list.")
    for item in value:
        if not isinstance(item, str) or not ID_RE.match(item):
            raise HttpError(400, f"{field} contains an invalid id.")
    return set(value)


# ---- request handler -------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "Noteboard/2.0"

    # ---- helpers

    def send_bytes(self, status, body, content_type, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; frame-ancestors 'none'",
        )
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Cache-Control": "no-store"}
        headers.update(extra_headers or {})
        self.send_bytes(status, body, "application/json; charset=utf-8", headers)

    def read_json_body(self):
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            raise HttpError(415, "Content-Type must be application/json.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise HttpError(400, "Invalid Content-Length.")
        if length <= 0:
            raise HttpError(400, "Request body is empty.")
        if length > MAX_BODY_BYTES:
            raise HttpError(413, "Request is too large.")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(400, "Body must be valid JSON.")
        if not isinstance(data, dict):
            raise HttpError(400, "Body must be a JSON object.")
        return data

    def session_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            morsel = SimpleCookie(raw).get(COOKIE_NAME)
        except Exception:
            return None
        return morsel.value if morsel else None

    def is_admin(self):
        token = self.session_token()
        if not token:
            return False
        with session_lock:
            purge_sessions()
            return token in sessions

    def require_admin(self):
        if not self.is_admin():
            raise HttpError(401, "Admin login required.")

    def route(self, fn):
        try:
            if is_blacklisted(self.client_address[0]):
                raise HttpError(403, "Forbidden.")
            fn()
        except HttpError as err:
            self.send_json(err.status, {"error": err.message})
        except Exception as err:  # keep the server alive on unexpected errors
            self.log_error("Unhandled error: %r", err)
            self.send_json(500, {"error": "Server error."})


    # ---- GET

    def do_GET(self):
        self.route(self._get)


    def _get(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/notes":
            with lock:
                notes = load_notes()
            return self.send_json(200, notes)

        if path == "/api/session":
            return self.send_json(200, {"admin": self.is_admin()})

        #if path == "/":
        #    ip = self.client_address[0]
        #    with ip_lock:
        #        try:
        #            known = BLACKLIST_FILE.read_text(encoding="utf-8").split()
        #        except OSError:
        #            known = []
        #        if ip in known:
        #            raise HttpError(403, "Forbidden")
        #    print("test")

        if path in STATIC_FILES:
            filename, content_type = STATIC_FILES[path]
            body = (STATIC_DIR / filename).read_bytes()
            return self.send_bytes(
                200, body, content_type, {"Cache-Control": "no-cache"}
            )

        raise HttpError(404, "Not found.")

    # ---- POST

    def do_POST(self):
        self.route(self._post)

    def _post(self):
        path = self.path.split("?", 1)[0]

        if path == "/api/notes":
            return self._create_note()
        if path == "/api/login":
            return self._login()
        if path == "/api/logout":
            return self._logout()
        if path == "/api/delete":
            return self._delete()
        if path == "/api/pin":
            return self._pin()

        match = REPLY_ROUTE.match(path)
        if match:
            return self._create_reply(match.group(1))

        raise HttpError(404, "Not found.")

    # ---- public actions

    def _create_note(self):
        data = self.read_json_body()
        title = clean_text(data.get("title"), "Title", MAX_TITLE)
        content = clean_text(data.get("content"), "Content", MAX_NOTE)
        note = {
            "id": uuid.uuid4().hex,
            "title": title,
            "content": content,
            "created": now_iso(),
            "pinned": False,
            "replies": [],
        }
        with lock:
            notes = load_notes()
            notes.append(note)
            save_notes(notes)
        self.send_json(201, note)

    def _create_reply(self, note_id):
        data = self.read_json_body()
        content = clean_text(data.get("content"), "Reply", MAX_REPLY)
        reply = {"id": uuid.uuid4().hex, "content": content, "created": now_iso()}
        with lock:
            notes = load_notes()
            note = next((n for n in notes if n["id"] == note_id), None)
            if note is None:
                raise HttpError(404, "Note not found.")
            note["replies"].append(reply)
            save_notes(notes)
        self.send_json(201, reply)

    # ---- admin session


    def _login(self):
        ip = self.client_address[0]
        data = self.read_json_body()
        password = data.get("password")
        if not isinstance(password, str) or not password:
            raise HttpError(400, "Enter the password.")
        now = time.time()
        with session_lock:
            state = failures.get(ip)
            if state and state[1] > now:
                wait = int(state[1] - now) + 1
                raise HttpError(429, f"Zu viele Versuche. Warte {wait} Sekunden.")



        expected = read_admin_password()
        ok = bool(expected) and hmac.compare_digest(
            password.encode("utf-8"), expected.encode("utf-8")
        )

        locked_out = False
        with session_lock:
            if ok:
                failures.pop(ip, None)
                purge_sessions()
                token = secrets.token_urlsafe(32)
                sessions[token] = now + SESSION_TTL
            else:
                count = failures.get(ip, [0, 0])[0] + 1
                if count >= MAX_FAILS:
                    failures[ip] = [0, now + LOCKOUT_SECONDS]
                    locked_out = True
                else:
                    failures[ip] = [count, 0]

        if not ok:
            if locked_out:
                log_ip(ip)
            raise HttpError(401, "Falsches Passwort.")

        cookie = (
            f"{COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; "
            f"Max-Age={SESSION_TTL}"
        )
        self.send_json(200, {"admin": True}, {"Set-Cookie": cookie})

    def _logout(self):
        token = self.session_token()
        if token:
            with session_lock:
                sessions.pop(token, None)
        cookie = f"{COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
        self.send_json(200, {"admin": False}, {"Set-Cookie": cookie})

    # ---- admin actions

    def _delete(self):
        self.require_admin()
        data = self.read_json_body()
        note_ids = clean_ids(data.get("notes", []), "notes")

        reply_items = data.get("replies", [])
        if not isinstance(reply_items, list) or len(reply_items) > MAX_BATCH:
            raise HttpError(400, "replies must be a list.")
        reply_pairs = set()
        for item in reply_items:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("note"), str)
                or not isinstance(item.get("reply"), str)
                or not ID_RE.match(item["note"])
                or not ID_RE.match(item["reply"])
            ):
                raise HttpError(400, "replies contains an invalid entry.")
            reply_pairs.add((item["note"], item["reply"]))

        removed_notes = 0
        removed_replies = 0
        with lock:
            notes = load_notes()
            kept = []
            for note in notes:
                if note["id"] in note_ids:
                    removed_notes += 1
                    continue
                before = len(note["replies"])
                note["replies"] = [
                    r for r in note["replies"]
                    if (note["id"], r["id"]) not in reply_pairs
                ]
                removed_replies += before - len(note["replies"])
                kept.append(note)
            if removed_notes or removed_replies:
                save_notes(kept)

        self.send_json(
            200, {"removed_notes": removed_notes, "removed_replies": removed_replies}
        )

    def _pin(self):
        self.require_admin()
        data = self.read_json_body()
        ids = clean_ids(data.get("ids", []), "ids")
        pinned = data.get("pinned")
        if not isinstance(pinned, bool):
            raise HttpError(400, "pinned must be true or false.")

        changed = 0
        with lock:
            notes = load_notes()
            for note in notes:
                if note["id"] in ids and bool(note.get("pinned")) != pinned:
                    note["pinned"] = pinned
                    changed += 1
            if changed:
                save_notes(notes)

        self.send_json(200, {"changed": changed})


def main():

    ensure_password_file()
    ensure_blacklist_file()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Noteboard running on http://{HOST}:{PORT}")
    print(f"Data file: {DATA_FILE}")
    print(f"Admin password file: {PASSWORD_FILE}")
    print(f"Blacklist file: {BLACKLIST_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
