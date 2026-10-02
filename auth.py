"""Accounts, TOTP two-factor login, server-side sessions, per-user generation ownership and credits.

Security posture:
- Passwords stored as salted scrypt hashes; TOTP (RFC 6238) is a mandatory second step.
- A password-only login yields a short-lived *pending* token, never a session.
- Sessions are random server-side ids (only their SHA-256 is stored) so disabling a user or
  resetting their 2FA revokes access immediately.
- A TOTP time-step can be used once (replay-proof); logins are rate-limited per IP and per user.
- Every SQL statement is parameterised; every user-controlled value is html-escaped on output.
- Generation ownership lives in `gen_owner`; legacy folders without a row are admin-only.
- Credits are integer micro-USD. A job reserves its estimate in ONE atomic UPDATE guarded by the balance
  (no overdraw under concurrency) and is settled exactly once when it finishes; admins are unmetered.
"""

import base64
import hashlib
import hmac
import html
import os
import re
import secrets
import sqlite3
import struct
import threading
import time
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from contextlib import contextmanager
from pathlib import Path

try:                                     # QR rendering is optional — the setup page always shows the manual key
    import segno
except Exception:
    segno = None

DATA_DIR = Path(os.environ.get("VIDEOGEN_DATA_DIR") or Path(__file__).resolve().parent)   # users.db + generations/ live here
DB_PATH = DATA_DIR / "users.db"
MICRO = 1_000_000                            # credits are stored as integer micro-USD
MAX_CREDIT_USD = 10_000
ENGINE_IDS: list[str] = []                   # filled by server.py from its ENGINES registry
USERNAME_RE = re.compile(r"^[a-z0-9_.-]{3,32}$")
CHILD_SUFFIX_RE = re.compile(r"-c\d+$")      # story clips are "<story id>-c01" — they inherit the story owner
PW_MIN, PW_MAX = 10, 128
SESSION_TTL = 7 * 24 * 3600
PENDING_TTL = 300
ENROLL_TTL = 24 * 3600
TOTP_PERIOD = 30
MAX_STEP2_FAILS = 5                          # wrong codes before the password step must be redone
IP_MAX_FAILS, IP_WINDOW = 10, 300
USER_MAX_FAILS, USER_WINDOW = 5, 900
STRIKE_LIMIT, STRIKE_WINDOW = 3, 24 * 3600   # blocked inputs in 24 h before a user is suspended
ACTIVE_GAP = 45                              # seconds: activity pings closer together than this count as continuous use
MAX_DAILY_MINUTES, MAX_BONUS_MINUTES = 24 * 60, 240

_FAILS: dict[tuple, list] = {}
_FAILS_LOCK = threading.Lock()
_DUMMY_HASH = ""                             # verified against for unknown users so timing doesn't reveal them


# ── storage ────────────────────────────────────────────────────────────────────────────────
@contextmanager
def _tx():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    new = not DB_PATH.exists()
    with _tx() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
          role TEXT NOT NULL DEFAULT 'user', pw_hash TEXT, totp_secret TEXT NOT NULL,
          last_totp_step INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
          enroll_hash TEXT, enroll_expires INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(
          sid_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pending(
          pid_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL,
          fails INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS gen_owner(gen_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS credit_ledger(
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, delta INTEGER NOT NULL,
          balance_after INTEGER NOT NULL, reason TEXT NOT NULL, actor INTEGER, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, engine TEXT NOT NULL,
          provider_micro INTEGER NOT NULL, charged_micro INTEGER NOT NULL, created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS usage_by_user_time ON usage_events(user_id, created);
        CREATE TABLE IF NOT EXISTS safety_events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, category TEXT NOT NULL,
          source TEXT NOT NULL, excerpt TEXT NOT NULL, strike INTEGER NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0,
          created INTEGER NOT NULL);
        """)
        have = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
        for col, ddl in (("balance", "INTEGER NOT NULL DEFAULT 0"), ("daily_cap", "INTEGER NOT NULL DEFAULT 0"),
                         ("engines", "TEXT NOT NULL DEFAULT ''"), ("spend_day", "TEXT NOT NULL DEFAULT ''"),
                         ("spent_today", "INTEGER NOT NULL DEFAULT 0"),
                         ("disabled_reason", "TEXT NOT NULL DEFAULT ''"),
                         ("daily_minutes", "INTEGER NOT NULL DEFAULT 0"), ("time_day", "TEXT NOT NULL DEFAULT ''"),
                         ("used_seconds", "INTEGER NOT NULL DEFAULT 0"), ("bonus_seconds", "INTEGER NOT NULL DEFAULT 0"),
                         ("last_active", "INTEGER NOT NULL DEFAULT 0")):
            if col not in have:                      # additive migration for databases created before credits
                c.execute(f"ALTER TABLE users ADD COLUMN {col} {ddl}")
    if new:
        os.chmod(DB_PATH, 0o600)


def _sha(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ── passwords ──────────────────────────────────────────────────────────────────────────────
def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    global _DUMMY_HASH
    if not stored:                           # unknown / not-enrolled user: burn the same CPU, then fail
        _DUMMY_HASH = _DUMMY_HASH or hash_password("dummy-password")
        verify_password(pw, _DUMMY_HASH)
        return False
    try:
        _, salt, digest = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got.hex(), digest)
    except Exception:
        return False


def password_error(pw: str) -> str:
    if not PW_MIN <= len(pw) <= PW_MAX:
        return f"Password must be {PW_MIN}-{PW_MAX} characters."
    return ""


# ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ─────────────────────────────────────────────────
def new_totp_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode()


def totp_code(secret_b32: str, counter: int) -> str:
    digest = hmac.new(base64.b32decode(secret_b32), struct.pack(">Q", counter), "sha1").digest()
    off = digest[-1] & 0x0F
    num = struct.unpack(">I", digest[off:off + 4])[0] & 0x7FFFFFFF
    return f"{num % 10 ** 6:06d}"


def totp_match(secret_b32: str, code: str, after_step: int = -1, now: float | None = None):
    """Return the matched time-step (±1 step of drift allowed, must be newer than after_step) or None."""
    if not re.fullmatch(r"\d{6}", code or ""):
        return None
    step = int((now if now is not None else time.time()) // TOTP_PERIOD)
    hit = None
    for cand in (step - 1, step, step + 1):          # no early exit — constant work per attempt
        if cand > after_step and hmac.compare_digest(totp_code(secret_b32, cand), code):
            hit = cand
    return hit


# ── rate limiting (in-memory; resets on restart) ───────────────────────────────────────────
def _limited(key: tuple, max_fails: int, window: int) -> bool:
    now = time.time()
    with _FAILS_LOCK:
        recent = [t for t in _FAILS.get(key, []) if now - t < window]
        _FAILS[key] = recent
        return len(recent) >= max_fails


def _fail(*keys: tuple) -> None:
    with _FAILS_LOCK:
        for k in keys:
            _FAILS.setdefault(k, []).append(time.time())


def _clear(key: tuple) -> None:
    with _FAILS_LOCK:
        _FAILS.pop(key, None)


UPLOAD_MAX, UPLOAD_WINDOW = 30, 3600           # picture safety checks per user per hour (each one costs money)


def upload_limited(uid: int) -> bool:
    """True when the user has used up their hourly picture checks; otherwise counts this one."""
    if _limited(("img", uid), UPLOAD_MAX, UPLOAD_WINDOW):
        return True
    _fail(("img", uid))
    return False


def _throttled(ip: str, username: str) -> bool:
    return _limited(("ip", ip), IP_MAX_FAILS, IP_WINDOW) or _limited(("user", username), USER_MAX_FAILS, USER_WINDOW)


# ── users & enrollment ─────────────────────────────────────────────────────────────────────
def _issue_enrollment(c, uid: int) -> str:
    """New one-time enrollment token + fresh TOTP secret; wipes the password and revokes access."""
    token = secrets.token_urlsafe(32)
    c.execute("UPDATE users SET totp_secret=?, enroll_hash=?, enroll_expires=?, pw_hash=NULL, last_totp_step=0 "
              "WHERE id=?", (new_totp_secret(), _sha(token), int(time.time()) + ENROLL_TTL, uid))
    c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
    c.execute("DELETE FROM pending WHERE user_id=?", (uid,))
    return token


def create_user(username: str, role: str = "user") -> tuple[int, str]:
    username = (username or "").strip().lower()
    if not USERNAME_RE.match(username):
        raise ValueError("Username must be 3-32 chars: a-z, 0-9, dot, dash, underscore.")
    if role not in ("user", "admin"):
        raise ValueError("Invalid role.")
    try:
        with _tx() as c:
            cur = c.execute("INSERT INTO users(username, role, totp_secret, created) VALUES(?,?,?,?)",
                            (username, role, new_totp_secret(), int(time.time())))
            return cur.lastrowid, _issue_enrollment(c, cur.lastrowid)
    except sqlite3.IntegrityError:
        raise ValueError("That username already exists.")


def reset_user(uid: int) -> str | None:
    with _tx() as c:
        if not c.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
            return None
        return _issue_enrollment(c, uid)


def set_disabled(uid: int, disabled: bool, reason: str = "") -> None:
    with _tx() as c:
        c.execute("UPDATE users SET disabled=?, disabled_reason=? WHERE id=?",
                  (1 if disabled else 0, reason if disabled else "", uid))
        if disabled:
            c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            c.execute("DELETE FROM pending WHERE user_id=?", (uid,))
        else:                                    # admin re-enabled: past strikes are reviewed, start clean
            c.execute("UPDATE safety_events SET reviewed=1 WHERE user_id=?", (uid,))


def record_violation(user: dict, category: str, source: str, text: str, strike: bool = True,
                     immediate: bool = False) -> bool:
    """Log a blocked input. Suspends a (non-admin) user at STRIKE_LIMIT strikes in 24 h, or at once if
    `immediate`. Returns True if the account was suspended by this event."""
    excerpt = re.sub(r"[\x00-\x1f\x7f]+", " ", text or "")[:80]
    now = int(time.time())
    with _tx() as c:
        c.execute("INSERT INTO safety_events(user_id, category, source, excerpt, strike, created) VALUES(?,?,?,?,?,?)",
                  (user["id"], category, source, excerpt, 1 if strike else 0, now))
        if user["role"] != "user" or not strike:
            return False
        n = c.execute("SELECT COUNT(*) FROM safety_events WHERE user_id=? AND strike=1 AND reviewed=0 AND created>?",
                      (user["id"], now - STRIKE_WINDOW)).fetchone()[0]
        if not (immediate or n >= STRIKE_LIMIT):
            return False
        c.execute("UPDATE users SET disabled=1, disabled_reason='safety' WHERE id=?", (user["id"],))
        c.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
        c.execute("DELETE FROM pending WHERE user_id=?", (user["id"],))
        return True


def recent_violations(limit: int = 25) -> list[dict]:
    with _tx() as c:
        return [dict(r) for r in c.execute(
            "SELECT e.created, u.username, e.category, e.source, e.excerpt, e.strike FROM safety_events e "
            "JOIN users u ON u.id=e.user_id ORDER BY e.id DESC LIMIT ?", (limit,))]


def list_users() -> list[dict]:
    today = date.today().isoformat()
    with _tx() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id, username, role, disabled, disabled_reason, pw_hash IS NOT NULL AS enrolled, balance, "
            "daily_cap, engines, spend_day, spent_today, daily_minutes, time_day, used_seconds, bonus_seconds, "
            "(SELECT COUNT(*) FROM safety_events e WHERE e.user_id=users.id) AS violations "
            "FROM users ORDER BY id")]
    for r in rows:
        r["spent_today"] = r["spent_today"] if r.pop("spend_day") == today else 0
        fresh = r.pop("time_day") == today                       # a new day resets time used and any bonus
        r["used_seconds"] = r["used_seconds"] if fresh else 0
        r["bonus_seconds"] = r["bonus_seconds"] if fresh else 0
    return rows


def bootstrap_admin(force: bool = False) -> str | None:
    """Ensure an enrolled admin can exist. Returns a one-time enrollment token when one was issued."""
    with _tx() as c:
        if not force and c.execute(
                "SELECT 1 FROM users WHERE role='admin' AND disabled=0 AND pw_hash IS NOT NULL").fetchone():
            return None
        row = c.execute("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
        if row:
            c.execute("UPDATE users SET disabled=0 WHERE id=?", (row["id"],))
            return _issue_enrollment(c, row["id"])
    return create_user("admin", "admin")[1]


def enrollment_user(token: str):
    """Pending user for a valid, unexpired enrollment token, else None."""
    if not token or len(token) > 100:
        return None
    with _tx() as c:
        row = c.execute("SELECT id, username, totp_secret FROM users WHERE enroll_hash=? AND enroll_expires>? "
                        "AND disabled=0", (_sha(token), int(time.time()))).fetchone()
        return dict(row) if row else None


def complete_enrollment(token: str, password: str, code: str, ip: str) -> str:
    """Set the password after proving the authenticator works. Returns an error message or ''."""
    if _limited(("ip", ip), IP_MAX_FAILS, IP_WINDOW):
        return "Too many attempts — try again in a few minutes."
    user = enrollment_user(token)
    if not user:
        return "This setup link was already used, replaced by a newer one, or has expired. If you already finished setting up, just sign in; otherwise ask your admin for a new link."
    err = password_error(password)
    if err:
        return err
    step = totp_match(user["totp_secret"], code)
    if step is None:
        _fail(("ip", ip))
        return "That code is wrong. Check your authenticator app and try again."
    with _tx() as c:
        done = c.execute("UPDATE users SET pw_hash=?, enroll_hash=NULL, enroll_expires=0, last_totp_step=? "
                         "WHERE id=? AND enroll_hash=?", (hash_password(password), step, user["id"], _sha(token)))
        if done.rowcount != 1:
            return "This setup link was already used, replaced by a newer one, or has expired. If you already finished setting up, just sign in; otherwise ask your admin for a new link."
    return ""


# ── login (password → pending → TOTP → session) ────────────────────────────────────────────
def login_step1(username: str, password: str, ip: str):
    """Returns (pending_token, error). error ∈ {'', 'invalid', 'limited'}."""
    username = (username or "").strip().lower()[:64]
    if _throttled(ip, username):
        return None, "limited"
    with _tx() as c:
        row = c.execute("SELECT id, pw_hash, disabled FROM users WHERE username=?", (username,)).fetchone()
        ok = verify_password(password or "", row["pw_hash"] if row else "")
        if not (row and ok and not row["disabled"]):
            _fail(("ip", ip), ("user", username))
            return None, "invalid"
        pid = secrets.token_urlsafe(32)
        c.execute("INSERT INTO pending(pid_hash, user_id, expires) VALUES(?,?,?)",
                  (_sha(pid), row["id"], int(time.time()) + PENDING_TTL))
        return pid, ""


def login_step2(pid: str, code: str, ip: str):
    """Returns (session_id, error). error ∈ {'', 'expired', 'wrong', 'limited'}."""
    if not pid:
        return None, "expired"
    now = int(time.time())
    with _tx() as c:
        p = c.execute("SELECT p.user_id, p.fails, u.username, u.totp_secret, u.last_totp_step, u.disabled "
                      "FROM pending p JOIN users u ON u.id=p.user_id WHERE p.pid_hash=? AND p.expires>?",
                      (_sha(pid), now)).fetchone()
        if not p or p["disabled"]:
            return None, "expired"
        if _throttled(ip, p["username"]):
            return None, "limited"
        step = totp_match(p["totp_secret"], code, after_step=p["last_totp_step"])
        # the UPDATE is the atomic replay guard: only one concurrent request can advance the step
        claimed = step is not None and c.execute(
            "UPDATE users SET last_totp_step=? WHERE id=? AND last_totp_step<?",
            (step, p["user_id"], step)).rowcount == 1
        if not claimed:
            _fail(("ip", ip), ("user", p["username"]))
            if p["fails"] + 1 >= MAX_STEP2_FAILS:
                c.execute("DELETE FROM pending WHERE pid_hash=?", (_sha(pid),))
                return None, "expired"
            c.execute("UPDATE pending SET fails=fails+1 WHERE pid_hash=?", (_sha(pid),))
            return None, "wrong"
        c.execute("DELETE FROM pending WHERE pid_hash=?", (_sha(pid),))
        sid = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions(sid_hash, user_id, csrf, expires) VALUES(?,?,?,?)",
                  (_sha(sid), p["user_id"], secrets.token_urlsafe(24), now + SESSION_TTL))
        c.execute("DELETE FROM sessions WHERE expires<?", (now,))
        _clear(("user", p["username"]))
        return sid, ""


def get_session(sid: str):
    """Active session → {'id','username','role','csrf'}; None if missing/expired/disabled."""
    if not sid or len(sid) > 100:
        return None
    with _tx() as c:
        row = c.execute("SELECT u.id, u.username, u.role, s.csrf FROM sessions s JOIN users u ON u.id=s.user_id "
                        "WHERE s.sid_hash=? AND s.expires>? AND u.disabled=0", (_sha(sid), int(time.time()))).fetchone()
        return dict(row) if row else None


def destroy_session(sid: str) -> None:
    with _tx() as c:
        c.execute("DELETE FROM sessions WHERE sid_hash=?", (_sha(sid or ""),))


def csrf_ok(user: dict, token: str) -> bool:
    return bool(user and token) and hmac.compare_digest(user["csrf"], token)


# ── daily screen time (active time, enforced server-side) ──────────────────────────────────────────────────
def _time_state(c, uid: int, today: str):
    """Row with the day rolled over: a new day resets time used, bonus and the activity clock."""
    r = c.execute("SELECT daily_minutes, time_day, used_seconds, bonus_seconds, last_active FROM users WHERE id=?",
                  (uid,)).fetchone()
    if r and r["time_day"] != today:
        c.execute("UPDATE users SET time_day=?, used_seconds=0, bonus_seconds=0, last_active=0 WHERE id=?", (today, uid))
        r = c.execute("SELECT daily_minutes, time_day, used_seconds, bonus_seconds, last_active FROM users WHERE id=?",
                      (uid,)).fetchone()
    return r


def _time_status(r) -> dict:
    limit = r["daily_minutes"] * 60 + (r["bonus_seconds"] if r["daily_minutes"] else 0)
    left = max(0, limit - r["used_seconds"]) if r["daily_minutes"] else None
    return {"limitMin": r["daily_minutes"], "usedSec": r["used_seconds"], "bonusMin": r["bonus_seconds"] // 60,
            "leftSec": left, "up": bool(r["daily_minutes"]) and left == 0}


def time_status(uid: int) -> dict | None:
    with _tx() as c:
        r = _time_state(c, uid, date.today().isoformat())
        return _time_status(r) if r else None


def touch(uid: int) -> dict | None:
    """Record user-driven activity and return the time status. Time accrues only between activity signals that are at
    most ACTIVE_GAP seconds apart, so an idle or backgrounded tab (no pings) does not use up the allowance."""
    now = int(time.time())
    with _tx() as c:
        c.execute("BEGIN IMMEDIATE")
        r = _time_state(c, uid, date.today().isoformat())
        if not r:
            return None
        gap = now - r["last_active"] if r["last_active"] else 0
        add = gap if 0 < gap <= ACTIVE_GAP else 0
        c.execute("UPDATE users SET used_seconds=used_seconds+?, last_active=? WHERE id=?", (add, now, uid))
        r = c.execute("SELECT daily_minutes, time_day, used_seconds, bonus_seconds, last_active FROM users WHERE id=?",
                      (uid,)).fetchone()
        return _time_status(r)


def set_bonus(uid: int, minutes: int) -> bool:
    """Admin: set today's extra minutes on top of the daily allowance (replaces any earlier extra; 0 removes it).
    It only applies to today — a new day resets it."""
    if not 0 <= minutes <= MAX_BONUS_MINUTES:
        return False
    with _tx() as c:
        c.execute("BEGIN IMMEDIATE")
        if not _time_state(c, uid, date.today().isoformat()):
            return False
        return c.execute("UPDATE users SET bonus_seconds=? WHERE id=? AND role='user'",
                         (minutes * 60, uid)).rowcount == 1


def parse_minutes(text: str, maximum: int) -> int | None:
    """Admin-typed whole minutes in [0, maximum] → int, else None."""
    t = (text or "").strip()
    if not t.isdigit() or len(t) > 5:
        return None
    n = int(t)
    return n if n <= maximum else None


# ── credits ────────────────────────────────────────────────────────────────────────────────
def to_micro(usd) -> int:
    return int((Decimal(str(usd)) * MICRO).to_integral_value(ROUND_HALF_UP))


def parse_amount(text: str) -> int | None:
    """Admin-typed dollar amount → micro-USD, or None if not a finite number in [0, MAX_CREDIT_USD]."""
    try:
        val = Decimal((text or "").strip())
    except InvalidOperation:
        return None
    if not val.is_finite() or val < 0 or val > MAX_CREDIT_USD:
        return None
    return to_micro(val)


def usd(micro: int) -> str:
    return f"${micro / MICRO:,.2f}" if abs(micro) >= MICRO // 100 or micro == 0 else f"${micro / MICRO:.4f}"


def _ledger(c, uid: int, delta: int, reason: str, actor: int | None = None) -> None:
    bal = c.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()["balance"]
    c.execute("INSERT INTO credit_ledger(user_id, delta, balance_after, reason, actor, created) VALUES(?,?,?,?,?,?)",
              (uid, delta, bal, reason, actor, int(time.time())))


def account(uid: int) -> dict | None:
    """Current credit state for one user (spent_today is zero once the day has rolled over)."""
    today = date.today().isoformat()
    with _tx() as c:
        r = c.execute("SELECT balance, daily_cap, engines, spend_day, spent_today FROM users WHERE id=?",
                      (uid,)).fetchone()
    if not r:
        return None
    return {"balance": r["balance"], "daily_cap": r["daily_cap"],
            "spent_today": r["spent_today"] if r["spend_day"] == today else 0,
            "engines": [e for e in r["engines"].split(",") if e]}      # empty = all engines


def engine_allowed(user: dict, tier: str) -> bool:
    if user["role"] == "admin":
        return True
    acc = account(user["id"])
    return bool(acc) and (not acc["engines"] or tier in acc["engines"])


def reserve(user: dict, est_usd: float) -> tuple[int, str]:
    """Atomically hold est_usd for a job. Returns (reserved_micro, error); admins are unmetered."""
    micro = to_micro(est_usd)
    if user["role"] == "admin" or micro <= 0:
        return 0, ""
    today = date.today().isoformat()
    with _tx() as c:
        c.execute("BEGIN IMMEDIATE")              # write lock first: check + debit cannot interleave
        r = c.execute("SELECT balance, daily_cap, spend_day, spent_today FROM users WHERE id=? AND disabled=0",
                      (user["id"],)).fetchone()
        if not r:
            return 0, "Account unavailable."
        spent = r["spent_today"] if r["spend_day"] == today else 0
        if r["balance"] < micro:
            return 0, (f"Not enough credits (this needs about {usd(micro)}, you have {usd(r['balance'])}). "
                       "Ask an admin to add credits.")
        if r["daily_cap"] and spent + micro > r["daily_cap"]:
            return 0, (f"Daily spend limit reached ({usd(spent)} of {usd(r['daily_cap'])} used today). "
                       "Try again tomorrow or ask an admin.")
        c.execute("UPDATE users SET balance=balance-?, spend_day=?, spent_today=? WHERE id=?",
                  (micro, today, spent + micro, user["id"]))
        _ledger(c, user["id"], -micro, "reserve")
        return micro, ""


def settle(uid: int, reserved: int, actual: int) -> None:
    """Reconcile a finished job: refund reserved−actual (full refund when actual=0); extra cost is charged."""
    diff = reserved - actual
    if not diff:
        return
    today = date.today().isoformat()
    with _tx() as c:
        c.execute("UPDATE users SET balance=balance+?, "
                  "spent_today=CASE WHEN spend_day=? THEN MAX(spent_today-?,0) ELSE spent_today END WHERE id=?",
                  (diff, today, diff, uid))
        _ledger(c, uid, diff, "settle")


def add_credits(uid: int, micro: int, actor: int) -> bool:
    if micro <= 0:
        return False
    with _tx() as c:
        if c.execute("UPDATE users SET balance=balance+? WHERE id=? AND role='user'", (micro, uid)).rowcount != 1:
            return False
        _ledger(c, uid, micro, "topup", actor)
    return True


def set_limits(uid: int, daily_cap_micro: int, engines: list[str], daily_minutes: int | None = None) -> bool:
    """daily_cap_micro 0 = no cap. engines must be a non-empty subset of ENGINE_IDS (all of them → stored as '').
    daily_minutes (0 = no limit) is the daily screen-time allowance; None leaves it unchanged."""
    chosen = [e for e in ENGINE_IDS if e in engines]
    if not chosen or (daily_minutes is not None and not 0 <= daily_minutes <= MAX_DAILY_MINUTES):
        return False
    stored = "" if len(chosen) == len(ENGINE_IDS) else ",".join(chosen)
    with _tx() as c:
        ok = c.execute("UPDATE users SET daily_cap=?, engines=? WHERE id=? AND role='user'",
                       (daily_cap_micro, stored, uid)).rowcount == 1
        if ok and daily_minutes is not None:
            c.execute("UPDATE users SET daily_minutes=? WHERE id=?", (daily_minutes, uid))
        return ok


# ── usage & profit (admin view) ────────────────────────────────────────────────────────────────────────────
USAGE_LABELS = {"video": "Videos", "chat": "Chat", "image": "Pictures"}


def record_usage(uid: int, kind: str, engine: str, provider_usd: float, charged_micro: int) -> None:
    """One finished, billable action: what it really cost us (provider) and what the user was charged (credits)."""
    with _tx() as c:
        c.execute("INSERT INTO usage_events(user_id, kind, engine, provider_micro, charged_micro, created) VALUES(?,?,?,?,?,?)",
                  (uid, kind, engine, to_micro(provider_usd), int(charged_micro), int(time.time())))


def _period_starts(now: float | None = None) -> dict[str, int]:
    midnight = int(time.mktime(date.fromtimestamp(now if now is not None else time.time()).timetuple()))
    return {"today": midnight, "d7": midnight - 6 * 86400, "d30": midnight - 29 * 86400, "all": 0}


def usage_report(now: float | None = None) -> dict:
    """{'users': {uid: {period: {n, charged, provider}}}, 'total': {period: ...}, 'by_kind': {uid: {kind: {...}}}} in micro-USD.
    Periods: today (since local midnight), d7 / d30 (rolling days incl. today), all."""
    starts = _period_starts(now)
    users: dict = {}
    total = {p: {"n": 0, "charged": 0, "provider": 0} for p in starts}
    by_kind: dict = {}
    with _tx() as c:
        for r in c.execute("SELECT user_id, created, charged_micro, provider_micro FROM usage_events"):
            u = users.setdefault(r["user_id"], {p: {"n": 0, "charged": 0, "provider": 0} for p in starts})
            for p, start in starts.items():
                if r["created"] >= start:
                    for bucket in (u[p], total[p]):
                        bucket["n"] += 1
                        bucket["charged"] += r["charged_micro"]
                        bucket["provider"] += r["provider_micro"]
        for r in c.execute("SELECT user_id, kind, COUNT(*) n, SUM(charged_micro) ch, SUM(provider_micro) pr FROM usage_events "
                           "WHERE created>=? GROUP BY user_id, kind", (starts["d30"],)):
            by_kind.setdefault(r["user_id"], {})[r["kind"]] = {"n": r["n"], "charged": r["ch"], "provider": r["pr"]}
    return {"users": users, "total": total, "by_kind": by_kind}


# ── generation ownership ───────────────────────────────────────────────────────────────────
def claim(gen_id: str, uid: int) -> None:
    with _tx() as c:
        c.execute("INSERT OR REPLACE INTO gen_owner(gen_id, user_id) VALUES(?,?)", (gen_id, uid))


def release(gen_id: str) -> None:
    with _tx() as c:
        c.execute("DELETE FROM gen_owner WHERE gen_id=?", (gen_id,))


def owner_map() -> dict:
    with _tx() as c:
        return {r["gen_id"]: r["user_id"] for r in c.execute("SELECT gen_id, user_id FROM gen_owner")}


def can_access(user: dict, gen_id: str, owners: dict | None = None) -> bool:
    """Admins see everything; users only folders they own. Unowned (legacy) folders are admin-only."""
    if not user:
        return False
    if user["role"] == "admin":
        return True
    owners = owner_map() if owners is None else owners
    owner = owners.get(gen_id, owners.get(CHILD_SUFFIX_RE.sub("", gen_id)))
    return owner == user["id"]


# ── HTML pages (all dynamic values escaped) ────────────────────────────────────────────────
# Pages are served with a CSP that allows no scripts except this one, pinned by hash.
COPY_JS = ("document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){"
           "var i=document.getElementById(b.dataset.copy);i.select();var ok=false;"
           "try{ok=document.execCommand('copy')}catch(e){}"
           "if(!ok&&navigator.clipboard){navigator.clipboard.writeText(i.value)}b.textContent='Copied';});});")
PWD_JS = ("document.querySelectorAll('[data-eye]').forEach(function(b){b.addEventListener('click',function(){"
          "var i=document.getElementById(b.dataset.eye);var show=i.type==='password';i.type=show?'text':'password';"
          "b.setAttribute('aria-label',show?'Hide password':'Show password');b.style.opacity=show?'1':'.6';});});")


def _csp_hash(js: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(js.encode()).digest()).decode() + "'"


COPY_JS_CSP = _csp_hash(COPY_JS)
SCRIPT_SRC = COPY_JS_CSP + " " + _csp_hash(PWD_JS)       # the only inline scripts the pages may run
_E = html.escape
_CSS = """body{font-family:'Instrument Sans',-apple-system,sans-serif;background:#f7f8fa;display:flex;
align-items:flex-start;justify-content:center;margin:0;padding:48px 16px}
.card{background:#fff;padding:32px;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:340px}
.card.wide{max-width:760px}h1{font-size:18px;margin:0 0 16px;color:#0f1419}h2{font-size:15px;margin:24px 0 8px}
input,select{width:100%;padding:10px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;
box-sizing:border-box;margin-bottom:12px}button{padding:10px 14px;border:none;border-radius:8px;background:#177bb5;
color:#fff;font-weight:700;cursor:pointer}form.stack button{width:100%}.err{color:#dc2626;font-size:13px;margin:0 0 12px}
.ok{color:#166534;font-size:13px;margin:0 0 12px;word-break:break-all}table{width:100%;border-collapse:collapse;font-size:14px}
td,th{padding:8px 6px;border-bottom:1px solid #eef0f3;text-align:left}td form{display:inline}
td button{padding:5px 9px;font-size:12px;margin-right:4px}code{background:#f1f5f9;padding:2px 5px;border-radius:4px;
word-break:break-all}.copyrow{display:flex;gap:8px}.copyrow input{margin-bottom:12px;flex:1}.copyrow button{height:40px;white-space:nowrap}.panel{padding:6px 0 12px;max-width:640px}.f{display:block;font-size:13px;font-weight:700;color:#374151;margin:12px 0 5px}.hint{font-size:12.5px;color:#94a3b8;margin:6px 0 6px}.warn{color:#b45309;font-weight:700;font-size:13px}form.stack2{margin:0 0 6px}.row{display:flex;gap:8px}.row input{margin-bottom:0;flex:1}.chk{display:inline-block;margin:0 12px 6px 0;font-size:13px}.chk input{width:auto;margin:0 4px 0 0}details{padding:6px 0}summary{cursor:pointer;font-size:13px;color:#177bb5;font-weight:600}form.inline{display:flex;gap:8px;margin:10px 0}form.inline input{margin-bottom:0;flex:1}.engines{margin:4px 0 10px}.logo{display:block;margin:0 auto 14px;border-radius:12px}table.usage{margin:6px 0 4px;font-size:13px}table.usage th{white-space:nowrap}table.usage td{vertical-align:top}
tr.tot td{background:#f8fafc;border-top:2px solid #e2e8f0}.gain{color:#15803d}.loss{color:#b91c1c}
.muted{color:#64748b;font-size:13px}.qr svg{width:180px;height:180px}"""


_EMBED_CSS = ("html,body{background:transparent}body{display:block;padding:28px 32px 48px}.card{box-shadow:none;border-radius:0;padding:0;"
              "max-width:980px;margin:0}h1{font-size:22px;font-family:'Inter',sans-serif;letter-spacing:-.4px}")


def _data_uri(path: Path) -> str:
    try:
        return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()
    except OSError:
        return ""


_UI = Path(__file__).resolve().parent / "ui"
_LOGO, _FAVICON = _data_uri(_UI / "logo-96.png"), _data_uri(_UI / "favicon.png")


def _page(title: str, body: str, wide: bool = False, embed: bool = False) -> str:
    icon = '<link rel="icon" href="%s">' % _FAVICON if _FAVICON else ""
    logo = '<img class="logo" src="%s" alt="" width="52" height="52">' % _LOGO if _LOGO and not embed else ""
    css = _CSS + (_EMBED_CSS if embed else "")
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,'
            f'initial-scale=1"><title>{_E(title)}</title>{icon}<style>{css}</style></head><body>'
            f'<div class="card{" wide" if wide else ""}">{logo}{body}</div></body></html>')


def _err(msg: str) -> str:
    return f'<p class="err">{_E(msg)}</p>' if msg else ""


BRAND = ("Spark", "Garden")                       # wordmark shown on sign-in pages (blue + amber)
_SPLIT_CSS = """
html,body{height:100%}
body.split{display:flex;flex-direction:row-reverse;align-items:stretch;padding:0;margin:0;background:#fff;color:#0a0f2c;
font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.left{flex:1;min-width:440px;padding:40px 64px;display:flex;flex-direction:column;overflow-y:auto;box-sizing:border-box}
.brand{width:100%;max-width:500px;margin:0 auto;display:flex;align-items:center;gap:12px;font-weight:800;font-size:34px;letter-spacing:-.6px;line-height:1}
.brand img{width:54px;height:54px;border-radius:15px;display:block}
.w1{color:#1355f2}.w2{color:#f5a300}
.mid{width:100%;max-width:500px;margin:auto;padding:28px 0}
h1.hello{font-size:44px;line-height:1.05;font-weight:800;letter-spacing:-1.2px;margin:0 0 10px}
.sub{font-size:19px;color:#4a5470;margin:0 0 26px;line-height:1.4}
label.fl{display:block;font-weight:700;font-size:15px;margin:18px 0 8px}
.field{position:relative}
.field svg.ic{position:absolute;left:17px;top:50%;transform:translateY(-50%);pointer-events:none}
.field input{width:100%;height:54px;padding:0 50px 0 52px;border:1.5px solid #ccd3e0;border-radius:14px;font-size:16px;margin:0;
background:#fff;box-sizing:border-box;font-family:inherit;color:#0a0f2c}
.field input.plain{padding-left:18px}
.field input:focus{outline:none;border-color:#1355f2;box-shadow:0 0 0 4px rgba(19,85,242,.14)}
.eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:transparent;border:none;padding:10px;cursor:pointer;opacity:.6;display:flex}
.cta{width:100%;height:58px;margin-top:24px;border:none;border-radius:999px;background:#1355f2;color:#fff;font-size:19px;font-weight:800;
cursor:pointer;box-shadow:0 10px 24px rgba(19,85,242,.28);font-family:inherit}
.cta:hover{background:#0e47d4}
.cta:focus-visible{outline:3px solid #9db8ff;outline-offset:2px}
.err{color:#d12b2b;background:#fff1f1;border:1px solid #ffd0d0;border-radius:12px;padding:11px 14px;font-size:14.5px;margin:0 0 6px}
.or{display:flex;align-items:center;gap:14px;color:#6b7390;margin:26px 0 16px;font-size:14px}
.or:before,.or:after{content:"";flex:1;height:1px;background:#d9deea}
.alt{text-align:center;font-size:16px}
.alt a{color:#1355f2;text-decoration:underline}
.hero{flex:none;height:100%;aspect-ratio:1122/1402;max-width:56vw;position:relative;overflow:hidden;background:#1d6bff url(/ui/login-hero-v2.jpg) center/cover no-repeat}
.hero .copy{position:absolute;left:0;right:0;top:5%;padding:0 7%;text-align:center;color:#fff;text-shadow:0 2px 14px rgba(8,40,140,.35)}
.hero h2{margin:0;font-size:clamp(26px,4.6vh,54px);line-height:1.06;font-weight:800;letter-spacing:-1px}
.hero p{margin:10px 0 0;font-size:clamp(14px,2.1vh,21px);color:rgba(255,255,255,.93);font-weight:500}
.muted{color:#5b6580;font-size:14px;line-height:1.5}code{background:#f1f5f9;padding:2px 6px;border-radius:5px;word-break:break-all}
.qr svg{width:190px;height:190px}.steps{counter-reset:s}
@media(max-width:860px){.hero{display:none}.left{min-width:0;padding:26px 22px}h1.hello{font-size:36px}}
"""
_IC_USER = ('<svg class="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6b7390" stroke-width="1.8" '
            'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>')
_IC_LOCK = ('<svg class="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6b7390" stroke-width="1.8" '
            'stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/>'
            '<path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>')
_IC_KEY = ('<svg class="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6b7390" stroke-width="1.8" '
           'stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/>'
           '<path d="m9 12 2 2 4-4"/></svg>')
_IC_EYE = ('<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b4666" stroke-width="1.8" '
           'stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/>'
           '<circle cx="12" cy="12" r="3"/></svg>')


def _split_page(title: str, body: str) -> str:
    """Two-panel sign-in layout: form on the left, illustration on the right (hidden on small screens)."""
    icon = '<link rel="icon" href="%s">' % _FAVICON if _FAVICON else ""
    logo = '<img src="%s" alt="">' % _LOGO if _LOGO else ""
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,'
            f'initial-scale=1"><title>{_E(title)}</title>{icon}<style>{_SPLIT_CSS}</style></head><body class="split">'
            f'<main class="left"><div class="brand">{logo}<span><span class="w1">{BRAND[0]}</span>'
            f'<span class="w2">{BRAND[1]}</span></span></div><div class="mid">{body}</div></main>'
            f'<aside class="hero" role="img" aria-label="A penguin floating with balloons beside a castle picture, a story and a movie">'
            f'<div class="copy"><h2>Big ideas start with you.</h2><p>Make pictures, tell stories and bring them to life.</p></div></aside>'
            f'<script>{PWD_JS}</script></body></html>')


def _field(name: str, label: str, placeholder: str, icon: str, kind: str = "text", extra: str = "", eye: bool = False) -> str:
    eye_btn = (f'<button type="button" class="eye" data-eye="{name}" aria-label="Show password">{_IC_EYE}</button>' if eye else "")
    return (f'<label class="fl" for="{name}">{_E(label)}</label><div class="field">{icon}'
            f'<input id="{name}" name="{name}" type="{kind}" placeholder="{_E(placeholder)}" {extra} required>{eye_btn}</div>')


def login_page(error: str = "") -> str:
    return _split_page(f"{BRAND[0]}{BRAND[1]} — Sign in", f"""<h1 class="hello">Ready to create?</h1>
<p class="sub">Sign in to start your next adventure.</p>{_err(error)}
<form method="POST" action="/login">
{_field('username', 'Username', 'Enter your username', _IC_USER, extra='autocomplete="username" autofocus')}
{_field('password', 'Password', 'Enter your password', _IC_LOCK, 'password', 'autocomplete="current-password"', eye=True)}
<button class="cta" type="submit">Let\'s create →</button></form>""")


def totp_page(error: str = "") -> str:
    return _split_page(f"{BRAND[0]}{BRAND[1]} — Verify", f"""<h1 class="hello">One more step</h1>
<p class="sub">Open your authenticator app and type the 6-digit code.</p>{_err(error)}
<form method="POST" action="/login/2fa">
{_field('code', 'Your code', '123456', _IC_KEY, extra='inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" autofocus')}
<button class="cta" type="submit">Verify →</button></form>
<div class="or">or</div><div class="alt"><a href="/login">← Start over</a></div>""")


def enroll_page(token: str, user: dict, error: str = "") -> str:
    uri = f"otpauth://totp/{BRAND[0]}{BRAND[1]}:{user['username']}?secret={user['totp_secret']}&issuer={BRAND[0]}{BRAND[1]}"
    qr = ""
    if segno:
        qr = f'<div class="qr">{segno.make(uri, error="m").svg_inline(scale=4, border=2)}</div>'
    return _split_page(f"{BRAND[0]}{BRAND[1]} — Set up account", f"""<h1 class="hello" style="font-size:36px">Welcome, {_E(user['username'])}!</h1>
<p class="sub" style="margin-bottom:14px">Let's set up your account in two quick steps.</p>
<p class="muted"><b>1.</b> Scan this with an authenticator app (Google Authenticator, Authy, 1Password…).</p>{qr}
<p class="muted">Can't scan? Type this key in the app: <code>{_E(user['totp_secret'])}</code></p>
<p class="muted"><b>2.</b> Choose a password and type the 6-digit code the app shows.</p>{_err(error)}
<form method="POST" action="/enroll/{_E(token)}">
{_field('password', 'New password', f'At least {PW_MIN} characters', _IC_LOCK, 'password', 'autocomplete="new-password"', eye=True)}
{_field('code', 'Code from the app', '123456', _IC_KEY, extra='inputmode="numeric" pattern="[0-9]{6}" maxlength="6"')}
<button class="cta" type="submit">Finish setup →</button></form>""")


def done_page() -> str:
    return _split_page(f"{BRAND[0]}{BRAND[1]} — Ready", """<h1 class="hello">You're all set! 🎉</h1>
<p class="sub">Your account is ready.</p><a class="cta" href="/login" style="display:flex;align-items:center;justify-content:center;text-decoration:none">Sign in →</a>""")


def _usage_cell(p: dict) -> str:
    """Profit (bold, green/red) over paid and real-cost lines for one period."""
    profit = p["charged"] - p["provider"]
    cls = "gain" if profit > 0 else ("loss" if profit < 0 else "muted")
    sign = "+" if profit > 0 else ("−" if profit < 0 else "")
    uses = " · %d uses" % p["n"] if p["n"] else ""
    return (f'<b class="{cls}">{sign}{usd(abs(profit))}</b><br>'
            f'<span class="muted">paid {usd(p["charged"])} · cost {usd(p["provider"])}{uses}</span>')


_EMPTY_USAGE = {"n": 0, "charged": 0, "provider": 0}
_PERIODS = (("today", "Today"), ("d7", "Last 7 days"), ("d30", "Last 30 days"), ("all", "All time"))


def _usage_html(users: list[dict], report: dict) -> str:
    rows = []
    for u in users:
        data = report["users"].get(u["id"])
        cells = "".join(f'<td>{_usage_cell(data[k] if data else _EMPTY_USAGE)}</td>' for k, _ in _PERIODS)
        rows.append(f'<tr><td>{_E(u["username"])}<br><span class="muted">{_E(u["role"])}</span></td>{cells}</tr>')
    totals = "".join(f'<td>{_usage_cell(report["total"][k])}</td>' for k, _ in _PERIODS)
    head = "".join(f"<th>{label}</th>" for _, label in _PERIODS)
    return ('<h2>Usage &amp; profit</h2><p class="muted">Paid = what users were charged in credits (provider cost × price '
            'multiplier). Cost = what the AI providers really billed. Profit = paid − cost. Tracked from when this feature '
            'went live; safety checks, Enhance and Write story (small Anthropic costs) are not included, so true profit is '
            'slightly lower. Admin use shows as cost with nothing paid.</p>'
            f'<table class="usage"><tr><th>User</th>{head}</tr>{"".join(rows)}'
            f'<tr class="tot"><td><b>Everyone</b></td>{totals}</tr></table>')


def _usage_by_type_html(by_kind: dict) -> str:
    if not by_kind:
        return '<div class="hint">No billable use in the last 30 days.</div>'
    rows = "".join(
        f'<tr><td>{_E(USAGE_LABELS.get(k, k))}</td><td>{v["n"]}</td><td>{usd(v["charged"])}</td><td>{usd(v["provider"])}</td>'
        f'<td>{usd(v["charged"] - v["provider"])}</td></tr>' for k, v in sorted(by_kind.items()))
    return ('<table class="usage"><tr><th>Type</th><th>Uses</th><th>Paid</th><th>Cost</th><th>Profit</th></tr>'
            f'{rows}</table>')


def _violations_html() -> str:
    events = recent_violations()
    if not events:
        return ""
    rows = "".join(
        f'<tr><td>{time.strftime("%Y-%m-%d %H:%M", time.localtime(e["created"]))}</td><td>{_E(e["username"])}</td>'
        f'<td>{_E(e["category"])}</td><td>{_E(e["source"])}</td><td><code>{_E(e["excerpt"])}</code></td></tr>'
        for e in events)
    return (f'<h2>Recent blocked inputs</h2><p class="muted">Kept for review. 3 strikes in 24 h suspend an account; '
            f'sexual content involving minors suspends immediately. Enabling a user clears their strikes.</p>'
            f'<table><tr><th>When</th><th>User</th><th>Category</th><th>Where</th><th>Excerpt</th></tr>{rows}</table>')


def admin_page(me: dict, notice: str = "", link: str = "", error: str = "", embed: bool = False) -> str:
    csrf = _E(me["csrf"])
    report = usage_report()
    q = "?embed=1" if embed else ""          # keeps every form post inside the embedded pane
    rows = []
    all_users = list_users()
    for u in all_users:
        state = (("suspended — safety" if u["disabled_reason"] == "safety" else "disabled") if u["disabled"]
                 else ("active" if u["enrolled"] else "awaiting setup"))
        if u["violations"]:
            state += f' <span class="muted">· {u["violations"]} blocked</span>'
        acts, credit_cell, panel = "", "unmetered" if u["role"] == "admin" else "", ""
        if u["id"] != me["id"]:
            def btn(action, label):
                return (f'<form method="POST" action="/admin/users/{u["id"]}/{action}{q}">'
                        f'<input type="hidden" name="csrf" value="{csrf}"><button>{label}</button></form>')
            acts = (btn("enable" if u["disabled"] else "disable", "Enable" if u["disabled"] else "Disable")
                    + btn("reset", "Reset 2FA + password"))
        if u["role"] == "user":
            cap = usd(u["daily_cap"]) if u["daily_cap"] else "no cap"
            bonus_min = u["bonus_seconds"] // 60
            used_min = u["used_seconds"] // 60
            if u["daily_minutes"]:
                total_min = u["daily_minutes"] + bonus_min
                left_min = max(0, total_min * 60 - u["used_seconds"] + 59) // 60
                split = (f'Daily {u["daily_minutes"]} + extra {bonus_min} (today only)' if bonus_min
                         else f'Daily allowance {u["daily_minutes"]} min')
                clock = (f'<b>Time today:</b> {used_min} of {total_min} min used<br>'
                         f'<span class="muted">{split}</span><br>'
                         f'<span class="{"warn" if left_min == 0 else "muted"}">{"Time is up for today" if left_min == 0 else f"{left_min} min left"}</span>')
            else:
                clock = f'<b>Time today:</b> {used_min} min used<br><span class="muted">No daily time limit set</span>'
            credit_cell = (f'<b>{usd(u["balance"])}</b> <span class="muted">credits</span><br>'
                           f'<span class="muted">Spent today {usd(u["spent_today"])} / {cap}</span><br>{clock}')
            allowed = [e for e in u["engines"].split(",") if e] or ENGINE_IDS
            boxes = "".join(f'<label class="chk"><input type="checkbox" name="engine" value="{_E(e)}"'
                            f'{" checked" if e in allowed else ""}> {_E(e)}</label>' for e in ENGINE_IDS)
            act = f'/admin/users/{u["id"]}'
            hid = f'<input type="hidden" name="csrf" value="{csrf}">'
            panel = (f'<tr><td colspan="5"><details><summary>Credits &amp; limits for {_E(u["username"])}</summary>'
                     f'<div class="panel">'
                     f'<form class="stack2" method="POST" action="{act}/credits{q}">{hid}'
                     f'<label class="f" for="amt{u["id"]}">Add credits (USD)</label>'
                     f'<div class="row"><input id="amt{u["id"]}" name="amount" inputmode="decimal" placeholder="e.g. 10" required>'
                     f'<button>Add credits</button></div></form>'
                     f'<form class="stack2" method="POST" action="{act}/time{q}">{hid}'
                     f'<label class="f" for="min{u["id"]}">Extra time for today only (minutes)</label>'
                     f'<div class="row"><input id="min{u["id"]}" name="minutes" inputmode="numeric" value="{bonus_min}" required>'
                     f'<button>Save extra time</button></div>'
                     f'<div class="hint">Sets today\'s extra time on top of the daily allowance — it replaces what is there now, '
                     f'0 removes it, and it resets tomorrow. Needs a daily screen time below.</div></form>'
                     f'<form class="stack2" method="POST" action="{act}/limits{q}">{hid}'
                     f'<label class="f" for="cap{u["id"]}">Daily spend limit (USD) — 0 means no limit</label>'
                     f'<input id="cap{u["id"]}" name="daily_cap" inputmode="decimal" value="{u["daily_cap"] / MICRO:g}">'
                     f'<label class="f" for="dm{u["id"]}">Daily screen time (minutes) — 0 means no limit</label>'
                     f'<input id="dm{u["id"]}" name="daily_minutes" inputmode="numeric" value="{u["daily_minutes"]}">'
                     f'<div class="f">Allowed engines</div><div class="engines">{boxes}</div>'
                     f'<button>Save limits</button></form>'
                     f'<div class="f">Usage by type (last 30 days)</div>{_usage_by_type_html(report["by_kind"].get(u["id"], {}))}'
                     f'</div></details></td></tr>')
        rows.append(f'<tr><td>{_E(u["username"])}</td><td>{_E(u["role"])}</td><td>{state}</td>'
                    f'<td>{credit_cell}</td><td>{acts}</td></tr>{panel}')
    note = f'<p class="ok">{_E(notice)}</p>' if notice else ""
    if link:
        note += (f'<p class="ok">One-time setup link (shown once, valid 24 h). Copy it and send it to the user '
                 f'privately — they open it to set their password and scan the 2FA QR code.</p>'
                 f'<div class="copyrow"><input id="setup-link" readonly value="{_E(link)}">'
                 f'<button type="button" data-copy="setup-link">Copy link</button></div>'
                 f'<script>{COPY_JS}</script>')
    return _page("SparkGarden — Admin", f"""<h1>Users &amp; credits</h1>{note}{_err(error)}
<table><tr><th>User</th><th>Role</th><th>Status</th><th>Credits</th><th></th></tr>{''.join(rows)}</table>
{_usage_html(all_users, report)}
{_violations_html()}
<h2>Add user</h2><form method="POST" action="/admin/users{q}">
<input type="hidden" name="csrf" value="{csrf}">
<input name="username" placeholder="username" required>
<select name="role"><option value="user">user — sees only their own pictures &amp; videos, metered by credits</option><option value="admin">admin — sees everything, unmetered</option></select>
<button type="submit">Create &amp; get setup link</button></form>
{"" if embed else '<p class="muted"><a href="/">← Back to app</a></p>'}""", wide=True, embed=embed)
