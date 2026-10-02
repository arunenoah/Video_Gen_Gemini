"""Auth, 2FA and per-user isolation tests. Run: ./.venv/bin/python3 -m unittest discover -s tests -v"""
import base64
import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth      # noqa: E402
import safety    # noqa: E402
import server    # noqa: E402

from harness import PW, LiveServerCase, _now_step   # noqa: E402


class AuthUnitTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        auth.DB_PATH = Path(self._tmp.name) / "users.db"
        auth._FAILS.clear()
        auth.init_db()
        self._engine_ids = list(auth.ENGINE_IDS)

    def tearDown(self):
        auth.ENGINE_IDS[:] = self._engine_ids                 # some tests narrow the engine registry
        self._tmp.cleanup()

    def _enrolled(self, name="alice", role="user"):
        uid, token = auth.create_user(name, role)
        secret = auth.enrollment_user(token)["totp_secret"]
        err = auth.complete_enrollment(token, PW, auth.totp_code(secret, _now_step()), "1.1.1.1")
        self.assertEqual(err, "")
        return uid, secret

    def test_should_match_rfc6238_vectors(self):
        secret = base64.b32encode(b"12345678901234567890").decode()
        self.assertEqual(auth.totp_code(secret, 59 // 30), "287082")
        self.assertEqual(auth.totp_code(secret, 1111111109 // 30), "081804")

    def test_should_reject_replayed_totp_step(self):
        secret = auth.new_totp_secret()
        step = _now_step()
        code = auth.totp_code(secret, step)
        self.assertEqual(auth.totp_match(secret, code), step)
        self.assertIsNone(auth.totp_match(secret, code, after_step=step))

    def test_should_reject_malformed_totp_codes(self):
        secret = auth.new_totp_secret()
        for bad in ("", "12345", "1234567", "abcdef", " 123456", None):
            self.assertIsNone(auth.totp_match(secret, bad))

    def test_should_verify_scrypt_password_and_reject_wrong_or_empty_hash(self):
        stored = auth.hash_password(PW)
        self.assertTrue(auth.verify_password(PW, stored))
        self.assertFalse(auth.verify_password("wrong-password", stored))
        self.assertFalse(auth.verify_password(PW, ""))
        self.assertFalse(auth.verify_password(PW, "garbage"))

    def test_should_not_issue_session_after_password_only(self):
        self._enrolled()
        pid, err = auth.login_step1("alice", PW, "2.2.2.2")
        self.assertEqual(err, "")
        self.assertIsNone(auth.get_session(pid))            # pending token is not a session

    def test_should_reject_unknown_user_and_wrong_password_identically(self):
        self._enrolled()
        self.assertEqual(auth.login_step1("nobody", PW, "2.2.2.2"), (None, "invalid"))
        self.assertEqual(auth.login_step1("alice", "nope-nope-nope", "2.2.2.2"), (None, "invalid"))

    def test_should_login_with_valid_totp_then_block_code_reuse(self):
        _, secret = self._enrolled()
        pid, _ = auth.login_step1("alice", PW, "3.3.3.3")
        code = auth.totp_code(secret, _now_step() + 1)      # enrollment used the current step
        sid, err = auth.login_step2(pid, code, "3.3.3.3")
        self.assertEqual(err, "")
        self.assertEqual(auth.get_session(sid)["username"], "alice")
        pid2, _ = auth.login_step1("alice", PW, "3.3.3.3")
        self.assertEqual(auth.login_step2(pid2, code, "3.3.3.3")[1], "wrong")

    def test_should_invalidate_pending_after_five_wrong_codes(self):
        self._enrolled()
        pid, _ = auth.login_step1("alice", PW, "4.4.4.4")
        results = [auth.login_step2(pid, "000000", "4.4.4.4")[1] for _ in range(auth.MAX_STEP2_FAILS)]
        self.assertEqual(results[-1], "expired")
        self.assertEqual(auth.login_step2(pid, "000000", "4.4.4.4")[1], "expired")

    def test_should_lock_user_after_repeated_password_failures(self):
        self._enrolled()
        for i in range(auth.USER_MAX_FAILS):
            auth.login_step1("alice", "bad-bad-bad-bad", f"9.9.9.{i}")
        self.assertEqual(auth.login_step1("alice", PW, "9.9.9.99"), (None, "limited"))

    def test_should_revoke_sessions_when_user_disabled_or_reset(self):
        uid, secret = self._enrolled()
        pid, _ = auth.login_step1("alice", PW, "5.5.5.5")
        sid, _ = auth.login_step2(pid, auth.totp_code(secret, _now_step() + 1), "5.5.5.5")
        auth.set_disabled(uid, True)
        self.assertIsNone(auth.get_session(sid))
        self.assertEqual(auth.login_step1("alice", PW, "5.5.5.5"), (None, "invalid"))
        auth.set_disabled(uid, False)
        auth.reset_user(uid)                                 # wipes the password too
        self.assertEqual(auth.login_step1("alice", PW, "5.5.5.5"), (None, "invalid"))

    def test_should_reject_expired_or_reused_enrollment_token(self):
        _, token = auth.create_user("carol")
        secret = auth.enrollment_user(token)["totp_secret"]
        code = auth.totp_code(secret, _now_step())
        self.assertEqual(auth.complete_enrollment(token, "short", code, "6.6.6.6"), auth.password_error("short"))
        self.assertEqual(auth.complete_enrollment(token, PW, code, "6.6.6.6"), "")
        self.assertNotEqual(auth.complete_enrollment(token, PW, code, "6.6.6.6"), "")   # single use

    def test_should_reject_bad_usernames_and_duplicates(self):
        for bad in ("ab", "UPPER space", "a" * 33, "x;drop", "../etc"):
            with self.assertRaises(ValueError):
                auth.create_user(bad)
        auth.create_user("dave")
        with self.assertRaises(ValueError):
            auth.create_user("DAVE")

    def test_should_scope_generation_access_by_owner(self):
        user = {"id": 2, "role": "user"}
        admin = {"id": 1, "role": "admin"}
        auth.claim("story-1", 2)
        auth.claim("story-2", 3)
        self.assertTrue(auth.can_access(user, "story-1"))
        self.assertTrue(auth.can_access(user, "story-1-c01"))        # clip inherits story owner
        self.assertFalse(auth.can_access(user, "story-2"))
        self.assertFalse(auth.can_access(user, "legacy-unowned"))    # legacy = admin only
        self.assertTrue(auth.can_access(admin, "legacy-unowned"))
        self.assertFalse(auth.can_access(None, "story-1"))

    # ── credits ─────────────────────────────────────────────────────────────────
    def test_should_reserve_then_refund_difference_on_settle(self):
        uid, _ = self._enrolled()
        user = {"id": uid, "role": "user"}
        self.assertTrue(auth.add_credits(uid, auth.to_micro(5), actor=1))
        reserved, err = auth.reserve(user, 2.0)
        self.assertEqual((reserved, err), (2_000_000, ""))
        self.assertEqual(auth.account(uid)["balance"], 3_000_000)
        auth.settle(uid, reserved, auth.to_micro(0.5))
        acc = auth.account(uid)
        self.assertEqual((acc["balance"], acc["spent_today"]), (4_500_000, 500_000))

    def test_should_refuse_reserve_when_balance_too_low_and_leave_balance_untouched(self):
        uid, _ = self._enrolled()
        auth.add_credits(uid, auth.to_micro(1), actor=1)
        reserved, err = auth.reserve({"id": uid, "role": "user"}, 1.5)
        self.assertEqual(reserved, 0)
        self.assertIn("Not enough credits", err)
        self.assertEqual(auth.account(uid)["balance"], 1_000_000)

    def test_should_enforce_daily_cap_even_with_enough_balance(self):
        uid, _ = self._enrolled()
        user = {"id": uid, "role": "user"}
        auth.ENGINE_IDS[:] = ["lite", "fast"]
        auth.add_credits(uid, auth.to_micro(100), actor=1)
        self.assertTrue(auth.set_limits(uid, auth.to_micro(3), ["lite", "fast"]))
        self.assertEqual(auth.reserve(user, 2.0)[1], "")
        self.assertIn("Daily spend limit", auth.reserve(user, 2.0)[1])

    def test_should_reset_daily_spend_after_midnight(self):
        uid, _ = self._enrolled()
        auth.add_credits(uid, auth.to_micro(10), actor=1)
        auth.reserve({"id": uid, "role": "user"}, 2.0)
        with auth._tx() as c:
            c.execute("UPDATE users SET spend_day='2000-01-01' WHERE id=?", (uid,))
        self.assertEqual(auth.account(uid)["spent_today"], 0)

    def test_should_never_overdraw_under_concurrent_reserves(self):
        uid, _ = self._enrolled()
        auth.add_credits(uid, auth.to_micro(5), actor=1)
        results = []
        def go():
            results.append(auth.reserve({"id": uid, "role": "user"}, 1.0))
        threads = [threading.Thread(target=go) for _ in range(20)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sum(1 for r, _ in results if r), 5)
        self.assertEqual(auth.account(uid)["balance"], 0)

    def test_should_not_meter_admins(self):
        uid, _ = self._enrolled("root", "admin")
        self.assertEqual(auth.reserve({"id": uid, "role": "admin"}, 50.0), (0, ""))

    def test_should_reject_bad_credit_amounts_and_non_user_targets(self):
        for bad in ("abc", "NaN", "inf", "-1", "10001", "", None):
            self.assertIsNone(auth.parse_amount(bad), bad)
        self.assertEqual(auth.parse_amount("10.50"), 10_500_000)
        admin_id, _ = self._enrolled("root", "admin")
        user_id, _ = self._enrolled("alice")
        self.assertFalse(auth.add_credits(admin_id, 1_000_000, actor=1))
        self.assertFalse(auth.add_credits(user_id, 0, actor=1))
        self.assertFalse(auth.add_credits(user_id, -5, actor=1))

    def test_should_validate_engine_allow_list(self):
        uid, _ = self._enrolled()
        auth.ENGINE_IDS[:] = ["lite", "fast", "grok"]
        user = {"id": uid, "role": "user"}
        self.assertFalse(auth.set_limits(uid, 0, []))
        self.assertFalse(auth.set_limits(uid, 0, ["nonsense"]))
        self.assertTrue(auth.set_limits(uid, 0, ["fast"]))
        self.assertTrue(auth.engine_allowed(user, "fast"))
        self.assertFalse(auth.engine_allowed(user, "grok"))
        self.assertTrue(auth.set_limits(uid, 0, ["lite", "fast", "grok"]))       # all → unrestricted
        self.assertTrue(auth.engine_allowed(user, "grok"))

    def test_should_settle_job_exactly_once(self):
        uid, _ = self._enrolled()
        auth.add_credits(uid, auth.to_micro(5), actor=1)
        reserved, _ = auth.reserve({"id": uid, "role": "user"}, 2.0)
        server.JOBS["once"] = {"owner": uid, "reserved": reserved, "status": "running"}
        server.job_update("once", status="done", cost=0.5)
        server.job_update("once", status="done", cost=0.5)
        server.job_update("once", status="failed")
        self.assertEqual(auth.account(uid)["balance"], 4_500_000)
        server.JOBS.pop("once")

    # ── daily screen time ───────────────────────────────────────────────────────
    def _timed_user(self, minutes):
        uid, _ = self._enrolled()
        auth.ENGINE_IDS[:] = ["lite", "fast"]
        self.assertTrue(auth.set_limits(uid, 0, ["lite", "fast"], minutes))
        return uid

    def test_should_count_only_continuous_activity_toward_the_allowance(self):
        from unittest import mock
        uid = self._timed_user(30)
        with mock.patch.object(auth.time, "time") as now:
            now.return_value = 1_000_000
            self.assertEqual(auth.touch(uid)["usedSec"], 0)                 # first signal of a burst counts nothing
            now.return_value = 1_000_030
            self.assertEqual(auth.touch(uid)["usedSec"], 30)
            now.return_value = 1_000_030 + 400                              # walked away: the gap is not counted
            self.assertEqual(auth.touch(uid)["usedSec"], 30)
            now.return_value = 1_000_030 + 400 + 20
            st = auth.touch(uid)
        self.assertEqual((st["usedSec"], st["leftSec"], st["up"]), (50, 30 * 60 - 50, False))

    def test_should_lock_when_the_allowance_is_used_and_unlock_with_bonus_time(self):
        from unittest import mock
        uid = self._timed_user(1)
        with mock.patch.object(auth.time, "time") as now:
            for t in (1_000_000, 1_000_040, 1_000_080):
                now.return_value = t
                st = auth.touch(uid)
            self.assertTrue(st["up"])                                       # (date.today() follows the patched clock,
            self.assertEqual(st["leftSec"], 0)                              #  so every step stays inside the block)
            self.assertTrue(auth.set_bonus(uid, 5))
            st = auth.time_status(uid)
        self.assertFalse(st["up"])
        self.assertEqual((st["leftSec"], st["bonusMin"]), (5 * 60 + 60 - 80, 5))

    def test_should_never_lock_when_no_limit_is_set(self):
        uid = self._timed_user(0)
        with auth._tx() as c:
            c.execute("UPDATE users SET used_seconds=999999, time_day=? WHERE id=?", (auth.date.today().isoformat(), uid))
        st = auth.time_status(uid)
        self.assertEqual((st["up"], st["leftSec"]), (False, None))

    def test_should_reset_time_and_bonus_on_a_new_day(self):
        uid = self._timed_user(10)
        with auth._tx() as c:
            c.execute("UPDATE users SET used_seconds=5000, bonus_seconds=600, time_day='2000-01-01' WHERE id=?", (uid,))
        st = auth.time_status(uid)
        self.assertEqual((st["usedSec"], st["bonusMin"], st["up"]), (0, 0, False))
        self.assertEqual({u["id"]: u for u in auth.list_users()}[uid]["used_seconds"], 0)

    def test_should_validate_minutes_everywhere(self):
        for bad in ("", "abc", "-5", "1.5", "99999999", None, " "):
            self.assertIsNone(auth.parse_minutes(bad, 240), bad)
        self.assertEqual(auth.parse_minutes(" 45 ", 240), 45)
        self.assertIsNone(auth.parse_minutes("241", 240))
        uid = self._timed_user(30)
        self.assertFalse(auth.set_bonus(uid, -1))
        self.assertFalse(auth.set_bonus(uid, auth.MAX_BONUS_MINUTES + 1))
        self.assertTrue(auth.set_bonus(uid, 0))
        self.assertFalse(auth.set_limits(uid, 0, ["lite"], auth.MAX_DAILY_MINUTES + 1))
        self.assertTrue(auth.set_limits(uid, 0, ["lite", "fast"], None))            # None leaves the limit unchanged
        self.assertEqual(auth.time_status(uid)["limitMin"], 30)

    def test_should_not_give_admins_bonus_time(self):
        admin_id, _ = self._enrolled("root", "admin")
        self.assertFalse(auth.set_bonus(admin_id, 10))

    def test_should_not_leak_markup_in_pages(self):
        user = {"username": "<script>x</script>", "totp_secret": auth.new_totp_secret()}
        self.assertNotIn("<script>x", auth.enroll_page("tok", user))


class HttpIsolationTests(LiveServerCase):
    # ── anonymous / half-authenticated ──────────────────────────────────────────
    def test_should_redirect_anonymous_page_requests_and_401_api_posts(self):
        r = self._raw("GET", "/api/list")
        self.assertEqual((r.status, r.getheader("Location")), (302, "/login"))
        self.assertEqual(self._raw("POST", "/api/generate", "{}").status, 401)

    def test_should_not_grant_access_with_password_only_cookie(self):
        r = self._raw("POST", "/login", urlencode({"username": "alice", "password": PW}), None, form=True)
        pending = r.getheader("Set-Cookie").split(";")[0]
        self.assertEqual(r.getheader("Location"), "/login/2fa")
        self.assertEqual(self._raw("GET", "/api/list", cookie=pending).status, 302)
        forged = self._raw("GET", "/api/list", cookie="vg_session=" + pending.split("=")[1])
        self.assertEqual(forged.status, 302)                  # pending token is not a session id

    def test_should_reject_unknown_host_header(self):
        self.assertEqual(self._raw("GET", "/login", host="evil.example:80").status, 403)

    def test_should_not_serve_source_or_database_files(self):
        for path in ("/users.db", "/server.py", "/auth.py", "/config.json", "/ui/../server.py",
                     "/ui/%2e%2e/server.py", "/.git/config", quote("/ui/../users.db")):
            self.assertEqual(self.req("alice", "GET", path).status, 404, path)
        self.assertEqual(self.req("alice", "GET", "/ui/vg-core.jsx").status, 200)

    # ── isolation (IDOR) ────────────────────────────────────────────────────────
    def test_should_list_only_own_generations(self):
        ids = lambda who: {e["id"] for e in json.loads(self.req(who, "GET", "/api/list").body)}
        self.assertEqual(ids("alice"), {"alice-gen", "alice-gen-c01"})
        self.assertEqual(ids("bob"), set())
        self.assertEqual(ids("admin"), {"alice-gen", "alice-gen-c01", "legacy-gen"})

    def test_should_404_cross_user_file_access(self):
        self.assertEqual(self.req("alice", "GET", "/generations/alice-gen/meta.json").status, 200)
        self.assertEqual(self.req("bob", "GET", "/generations/alice-gen/meta.json").status, 404)
        self.assertEqual(self.req("bob", "GET", "/generations/alice-gen-c01/clip.mp4").status, 404)
        self.assertEqual(self.req("alice", "GET", "/generations/legacy-gen/meta.json").status, 404)
        self.assertEqual(self.req("admin", "GET", "/generations/legacy-gen/meta.json").status, 200)

    def test_should_404_cross_user_delete_and_keep_data(self):
        self.assertEqual(self.req("bob", "DELETE", "/api/delete/alice-gen").status, 404)
        self.assertTrue((server.GENERATIONS / "alice-gen").is_dir())

    def test_should_404_cross_user_stitch(self):
        body = json.dumps({"ids": ["alice-gen", "alice-gen-c01"]})
        self.assertEqual(self.req("bob", "POST", "/api/stitch", body).status, 404)

    def test_should_404_cross_user_job_poll_and_hide_owner_field(self):
        self.assertEqual(self.req("bob", "GET", "/api/job/job-alice").status, 404)
        r = self.req("alice", "GET", "/api/job/job-alice")
        self.assertEqual(r.status, 200)
        self.assertNotIn("owner", json.loads(r.body))

    # ── admin surface ───────────────────────────────────────────────────────────
    def test_should_hide_admin_from_non_admins(self):
        self.assertEqual(self.req("alice", "GET", "/admin").status, 404)
        self.assertEqual(self.req("alice", "POST", "/admin/users", urlencode({"username": "x1x"}), True).status, 404)

    def test_should_require_csrf_token_for_admin_posts(self):
        r = self.req("admin", "POST", "/admin/users", urlencode({"username": "mallory"}), True)
        self.assertEqual(r.status, 403)
        self.assertNotIn("mallory", [u["username"] for u in auth.list_users()])

    def test_should_create_user_and_show_one_time_link_with_valid_csrf(self):
        csrf = auth.get_session(self.cookies["admin"].split("=")[1])["csrf"]
        r = self.req("admin", "POST", "/admin/users", urlencode({"username": "erin", "role": "user", "csrf": csrf}), True)
        self.assertEqual(r.status, 200)
        self.assertIn(b"/enroll/", r.body)
        self.assertIn("erin", [u["username"] for u in auth.list_users()])

    def test_should_show_copyable_setup_link_and_pin_only_that_script_in_csp(self):
        csrf = auth.get_session(self.cookies["admin"].split("=")[1])["csrf"]
        r = self.req("admin", "POST", "/admin/users", urlencode({"username": "frank", "csrf": csrf}), True)
        self.assertIn(b'data-copy="setup-link"', r.body)
        self.assertIn(b"/enroll/", r.body)
        csp = r.getheader("Content-Security-Policy")
        self.assertIn(f"script-src {auth.COPY_JS_CSP}", csp)
        self.assertNotIn("unsafe-inline'; img", csp.split("style-src")[0])   # scripts stay locked down

    # ── credits over HTTP ───────────────────────────────────────────────────────


    def test_should_block_generation_without_credits_and_leave_no_folder(self):
        before = set(p.name for p in server.GENERATIONS.iterdir())
        r = self.req("bob", "POST", "/api/generate", self._gen_body())
        self.assertEqual(r.status, 402)
        self.assertIn("Not enough credits", json.loads(r.body)["error"])
        self.assertEqual(set(p.name for p in server.GENERATIONS.iterdir()), before)

    def test_should_reserve_on_submit_and_refund_when_job_fails(self):
        r = self._admin_post(f"/admin/users/{self.uid['alice']}/credits", amount="5")
        self.assertEqual(r.status, 200)
        start = auth.account(self.uid["alice"])["balance"]
        r = self.req("alice", "POST", "/api/generate", self._gen_body())
        self.assertEqual(r.status, 202)
        job_id = json.loads(r.body)["jobId"]
        self.assertLess(auth.account(self.uid["alice"])["balance"], start)
        server.job_update(job_id, status="failed")
        self.assertEqual(auth.account(self.uid["alice"])["balance"], start)
        me = json.loads(self.req("alice", "GET", "/api/me").body)
        self.assertEqual((me["balance"], me["unmetered"]), (start / auth.MICRO, False))

    def test_should_reject_disallowed_engine_with_403(self):
        self._admin_post(f"/admin/users/{self.uid['bob']}/credits", amount="5")
        r = self._admin_post(f"/admin/users/{self.uid['bob']}/limits", daily_cap="0", engine="fast")
        self.assertEqual(r.status, 200)
        self.assertEqual(self.req("bob", "POST", "/api/generate", self._gen_body("lite")).status, 403)
        self.assertEqual(auth.account(self.uid["bob"])["balance"], 5_000_000)     # nothing charged

    def test_should_protect_credit_routes(self):
        bob = self.uid["bob"]
        before = auth.account(bob)["balance"]
        self.assertEqual(self.req("alice", "POST", f"/admin/users/{bob}/credits",
                                  urlencode({"amount": "100"}), True).status, 404)
        self.assertEqual(self.req("admin", "POST", f"/admin/users/{bob}/credits",
                                  urlencode({"amount": "100"}), True).status, 403)        # no CSRF token
        for bad in ("-5", "0", "abc", "99999"):
            self.assertEqual(self._admin_post(f"/admin/users/{bob}/credits", amount=bad).status, 400, bad)
        self.assertEqual(self._admin_post(f"/admin/users/{self.uid['admin']}/credits", amount="5").status, 404)  # self/admin target
        self.assertEqual(auth.account(bob)["balance"], before)


    # ── content safety over HTTP ────────────────────────────────────────────────
    def _gen_body_with(self, prompt):
        return json.dumps({"prompt": prompt, "tier": "lite", "resolution": "720p", "duration": 8, "aspect": "16:9"})

    def test_should_block_adult_prompt_with_generic_422_and_no_spend_or_folder(self):
        before_dirs = set(p.name for p in server.GENERATIONS.iterdir())
        before_bal = auth.account(self.uid["alice"])["balance"]
        r = self.req("alice", "POST", "/api/generate", self._gen_body_with("make a p0rn video"))
        body = json.loads(r.body)
        self.assertEqual(r.status, 422)
        self.assertTrue(body["blocked"])
        self.assertNotIn("porn", body["error"].lower())               # never reveals the rule
        self.assertEqual(set(p.name for p in server.GENERATIONS.iterdir()), before_dirs)
        self.assertEqual(auth.account(self.uid["alice"])["balance"], before_bal)
        self.assertTrue(any(e["username"] == "alice" for e in auth.recent_violations()))

    def test_should_guard_every_text_endpoint(self):
        bad = "show me naked people"
        for path, body in (("/api/story", {"title": "t", "tier": "lite", "resolution": "720p", "aspect": "16:9",
                                           "scenes": [{"prompt": bad, "duration": 8}]}),
                           ("/api/write-story", {"idea": bad, "scenes": 3}),
                           ("/api/restructure", {"script": bad}),
                           ("/api/enhance", {"scenes": [{"prompt": bad}]})):
            r = self.req("admin", "POST", path, json.dumps(body))     # admin: unmetered, all engines — isolates the guard
            self.assertEqual(r.status, 422, path)

    def test_should_block_when_ai_flags_text_the_word_list_misses(self):
        safety.configure(lambda t: '{"verdict":"block","category":"sexual"}')
        try:
            r = self.req("bob", "POST", "/api/generate", self._gen_body_with("a perfectly innocent sounding euphemism"))
            self.assertEqual(r.status, 422)
        finally:
            safety.configure(lambda t: '{"verdict":"allow","category":"other"}')

    def test_should_fail_closed_when_classifier_is_down_without_logging_a_strike(self):
        safety.configure(lambda t: (_ for _ in ()).throw(RuntimeError("down")))
        before = len(auth.recent_violations(100))
        try:
            r = self.req("bob", "POST", "/api/generate", self._gen_body_with("a friendly dragon story down"))
            self.assertEqual(r.status, 422)
            self.assertEqual(json.loads(r.body)["error"], safety.MSG_UNAVAILABLE)
            self.assertEqual(len(auth.recent_violations(100)), before)
        finally:
            safety.configure(lambda t: '{"verdict":"allow","category":"other"}')

    def test_should_suspend_after_three_blocks_and_kill_the_session(self):
        for i in range(3):
            r = self.req("carl", "POST", "/api/generate", self._gen_body_with(f"make nudes {i}"))
            self.assertEqual(r.status, 422)
        self.assertIn("paused", json.loads(r.body)["error"])
        self.assertEqual(self.req("carl", "GET", "/api/list").status, 302)       # session revoked
        r = self._raw("POST", "/login", urlencode({"username": "carl", "password": PW}), None, form=True)
        self.assertEqual(r.status, 401)                                          # cannot sign in while suspended


    def test_should_allow_framing_only_for_the_embedded_admin_screen(self):
        r = self.req("admin", "GET", "/admin?embed=1")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("X-Frame-Options"), "SAMEORIGIN")
        self.assertIn("frame-ancestors 'self'", r.getheader("Content-Security-Policy"))
        self.assertIn(b'action="/admin/users?embed=1"', r.body)                  # forms stay inside the pane
        self.assertNotIn(b"Back to app", r.body)
        full = self.req("admin", "GET", "/admin")
        self.assertEqual(full.getheader("X-Frame-Options"), "DENY")
        self.assertIn("frame-ancestors 'none'", full.getheader("Content-Security-Policy"))
        self.assertEqual(self._raw("GET", "/login").getheader("X-Frame-Options"), "DENY")
        self.assertEqual(self.req("alice", "GET", "/admin?embed=1").status, 404)        # still admin-only

    def test_should_keep_embedded_mode_after_an_admin_post(self):
        csrf = auth.get_session(self.cookies["admin"].split("=")[1])["csrf"]
        r = self.req("admin", "POST", "/admin/users?embed=1", urlencode({"username": "gina", "csrf": csrf}), True)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("X-Frame-Options"), "SAMEORIGIN")
        self.assertIn(b"/enroll/", r.body)
        r = self.req("admin", "POST", "/admin/users?embed=1", urlencode({"username": "x", "csrf": "bad"}), True)
        self.assertEqual((r.status, r.getheader("X-Frame-Options")), (403, "SAMEORIGIN"))

    def test_should_show_the_logo_on_sign_in_pages(self):
        self.assertIn(b"data:image/png;base64", self._raw("GET", "/login").body)
        self.assertEqual(self.req("alice", "GET", "/ui/logo.png").status, 200)

    # ── daily screen time over HTTP ─────────────────────────────────────────────
    def _set_time(self, who, minutes, used=0, bonus=0, last_active=0):
        with auth._tx() as c:
            c.execute("UPDATE users SET daily_minutes=?, used_seconds=?, bonus_seconds=?, last_active=?, time_day=? "
                      "WHERE id=?", (minutes, used, bonus, last_active, auth.date.today().isoformat(), self.uid[who]))

    def test_should_refuse_creating_things_once_time_is_up_but_keep_the_library_open(self):
        self._set_time("alice", 1, used=60)
        try:
            for path, body in (("/api/chat", {"engine": "chat-deepseek", "messages": [{"role": "user", "content": "hi"}]}),
                               ("/api/image", {"prompt": "a nice cat"}), ("/api/generate", {"prompt": "a cat"}),
                               ("/api/write-story", {"idea": "a cat", "scenes": 3})):
                r = self.req("alice", "POST", path, json.dumps(body))
                self.assertEqual(r.status, 423, path)
                self.assertTrue(json.loads(r.body)["timeUp"])
            self.assertEqual(self.req("alice", "GET", "/api/list").status, 200)          # Library stays open
            self.assertEqual(self.req("alice", "GET", "/generations/alice-gen/meta.json").status, 200)
            self.assertEqual(self.req("alice", "DELETE", "/api/delete/nonexistent-id").status, 404)   # not 423
            self.assertTrue(json.loads(self.req("alice", "GET", "/api/me").body)["time"]["up"])
            self.assertEqual(self.req("alice", "POST", "/api/ping").status, 200)         # ping/sign-out still allowed
        finally:
            self._set_time("alice", 0)

    def test_should_never_apply_the_time_limit_to_admins(self):
        self._set_time("admin", 1, used=999)
        try:
            r = self.req("admin", "POST", "/api/enhance", json.dumps({"scenes": []}))
            self.assertEqual(r.status, 400)                                              # validation error, not 423
        finally:
            self._set_time("admin", 0)

    def test_should_accrue_time_from_pings_and_report_status(self):
        import time as _t
        self._set_time("alice", 30, last_active=int(_t.time()) - 20)
        try:
            st = json.loads(self.req("alice", "POST", "/api/ping").body)
            self.assertGreaterEqual(st["usedSec"], 19)
            self.assertLessEqual(st["usedSec"], 25)
            self.assertEqual((st["limitMin"], st["up"]), (30, False))
            # polling endpoints must NOT count as activity (an idle open tab would burn the allowance)
            before = auth.time_status(self.uid["alice"])["usedSec"]
            self.req("alice", "GET", "/api/me"); self.req("alice", "GET", "/api/job/job-alice")
            self.assertEqual(auth.time_status(self.uid["alice"])["usedSec"], before)
        finally:
            self._set_time("alice", 0)

    def test_should_let_admin_set_the_allowance_and_add_extra_time(self):
        alice = self.uid["alice"]
        self._set_time("alice", 0)
        ok = self._admin_post_multi(f"/admin/users/{alice}/limits", list(auth.ENGINE_IDS), daily_cap="0", daily_minutes="45")
        self.assertEqual(ok.status, 200)
        self.assertEqual(auth.time_status(alice)["limitMin"], 45)
        for bad in ("1441", "abc", "-1"):
            r = self._admin_post_multi(f"/admin/users/{alice}/limits", list(auth.ENGINE_IDS), daily_cap="0", daily_minutes=bad)
            self.assertEqual(r.status, 400, bad)
        self.assertEqual(auth.time_status(alice)["limitMin"], 45)
        self._set_time("alice", 1, used=60)
        self.assertTrue(auth.time_status(alice)["up"])
        self.assertEqual(self._admin_post(f"/admin/users/{alice}/time", minutes="15").status, 200)
        self.assertFalse(auth.time_status(alice)["up"])
        self.assertEqual(self._admin_post(f"/admin/users/{alice}/time", minutes="10").status, 200)     # replaces, not adds
        self.assertEqual(auth.time_status(alice)["bonusMin"], 10)
        self.assertEqual(self._admin_post(f"/admin/users/{alice}/time", minutes="0").status, 200)      # 0 removes the extra
        self.assertEqual(auth.time_status(alice)["bonusMin"], 0)
        self.assertTrue(auth.time_status(alice)["up"])
        for bad in ("abc", "241", "", "-5"):
            self.assertEqual(self._admin_post(f"/admin/users/{alice}/time", minutes=bad).status, 400, bad)
        self.assertEqual(self.req("alice", "POST", f"/admin/users/{alice}/time", urlencode({"minutes": "60"}), True).status, 404)
        self._set_time("alice", 0)

    def test_should_show_time_allowed_and_used_with_labelled_fields_on_the_admin_screen(self):
        alice = self.uid["alice"]
        self._set_time("alice", 60, used=23 * 60 + 10, bonus=15 * 60)
        try:
            page = self.req("admin", "GET", "/admin?embed=1").body.decode()
            self.assertIn("Time today:</b> 23 of 75 min used", page)          # 60 allowed + 15 extra
            self.assertIn("Daily 60 + extra 15 (today only)", page)           # the split is spelled out
            self.assertIn('name="minutes" inputmode="numeric" value="15"', page)   # the extra is editable, prefilled
            self.assertIn("52 min left", page)
            for label in ("Daily screen time (minutes)", "Daily spend limit (USD)", "Allowed engines", "Extra time for today only"):
                self.assertIn(label, page)
            self._set_time("alice", 0)
            page = self.req("admin", "GET", "/admin?embed=1").body.decode()
            self.assertIn("No daily time limit set", page)
            r = self._admin_post(f"/admin/users/{alice}/time", minutes="15")      # nothing to extend yet → clear message
            self.assertEqual(r.status, 400)
            self.assertIn(b"no daily time limit yet", r.body)
        finally:
            self._set_time("alice", 0)

    def test_should_not_let_admin_disable_self(self):
        csrf = auth.get_session(self.cookies["admin"].split("=")[1])["csrf"]
        r = self.req("admin", "POST", f"/admin/users/{self.uid['admin']}/disable", urlencode({"csrf": csrf}), True)
        self.assertEqual(r.status, 404)
        self.assertIsNotNone(auth.get_session(self.cookies["admin"].split("=")[1]))


if __name__ == "__main__":
    unittest.main()
