"""Usage & profit: logging at every billable hook, period maths, admin view, and the resume double-billing fix."""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth               # noqa: E402
import openrouter_chat    # noqa: E402
import server             # noqa: E402
from harness import LiveServerCase   # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
DAY = 86400


class UsageReportTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        auth.DB_PATH = Path(self._tmp.name) / "users.db"
        auth.init_db()
        self.a, _ = auth.create_user("amy")
        self.b, _ = auth.create_user("ben")
        self.now = time.time()

    def tearDown(self):
        self._tmp.cleanup()

    def _event(self, uid, kind, provider, charged, age_days=0.0):
        auth.record_usage(uid, kind, "x", provider, charged)
        with auth._tx() as c:
            c.execute("UPDATE usage_events SET created=? WHERE id=(SELECT MAX(id) FROM usage_events)",
                      (int(self.now - age_days * DAY),))

    def test_should_split_usage_into_today_week_month_and_all_time(self):
        self._event(self.a, "video", 1.0, 5_000_000, 0)          # today
        self._event(self.a, "video", 2.0, 10_000_000, 3)         # this week
        self._event(self.a, "chat", 0.5, 2_500_000, 10)          # this month
        self._event(self.a, "image", 0.1, 500_000, 40)           # older
        a = auth.usage_report(self.now)["users"][self.a]
        self.assertEqual((a["today"]["n"], a["d7"]["n"], a["d30"]["n"], a["all"]["n"]), (1, 2, 3, 4))
        self.assertEqual((a["d7"]["charged"], a["d7"]["provider"]), (15_000_000, 3_000_000))
        self.assertEqual((a["all"]["charged"], a["all"]["provider"]), (18_000_000, 3_600_000))

    def test_should_total_everyone_and_keep_users_separate(self):
        self._event(self.a, "video", 1.0, 5_000_000)
        self._event(self.b, "chat", 0.002, 10_000)
        rep = auth.usage_report(self.now)
        self.assertEqual(rep["total"]["all"]["charged"], 5_010_000)
        self.assertEqual(rep["users"][self.a]["all"]["provider"], 1_000_000)
        self.assertEqual(rep["users"][self.b]["all"]["provider"], 2_000)

    def test_should_break_the_last_30_days_down_by_type(self):
        self._event(self.a, "video", 1.0, 5_000_000, 2)
        self._event(self.a, "video", 1.0, 5_000_000, 20)
        self._event(self.a, "chat", 0.01, 50_000, 1)
        self._event(self.a, "image", 0.1, 500_000, 45)           # outside the 30-day window
        kinds = auth.usage_report(self.now)["by_kind"][self.a]
        self.assertEqual(set(kinds), {"video", "chat"})
        self.assertEqual((kinds["video"]["n"], kinds["video"]["charged"]), (2, 10_000_000))

    def test_should_show_profit_and_mark_loss_making_use(self):
        self._event(self.a, "video", 1.0, 5_000_000)            # +$4 profit
        self._event(self.b, "video", 1.0, 0)                    # admin-style use: cost with nothing paid
        page = auth.admin_page({"id": 99, "csrf": "t", "username": "boss", "role": "admin"}, embed=True)
        self.assertIn('<b class="gain">+$4.00</b>', page)
        self.assertIn('<b class="loss">−$1.00</b>', page)
        self.assertIn("Usage &amp; profit", page)
        for label in ("Today", "Last 7 days", "Last 30 days", "All time", "Everyone"):
            self.assertIn(label, page)

    def test_should_render_an_empty_report_without_errors(self):
        page = auth.admin_page({"id": 99, "csrf": "t", "username": "boss", "role": "admin"}, embed=True)
        self.assertIn("Usage &amp; profit", page)
        self.assertIn("No billable use in the last 30 days.", page)

    def test_should_resolve_period_boundaries_at_local_midnight(self):
        starts = auth._period_starts(self.now)
        self.assertLessEqual(starts["today"], self.now)
        self.assertGreater(starts["today"], self.now - DAY)
        self.assertEqual(starts["d7"], starts["today"] - 6 * DAY)
        self.assertEqual(starts["d30"], starts["today"] - 29 * DAY)

    def test_should_bill_a_resumed_story_only_for_the_new_clips(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(server, "GENERATIONS", Path(tmp)):
            for cid, cost in (("c01", 0.4), ("c02", 0.3)):
                (Path(tmp) / cid).mkdir()
                (Path(tmp) / cid / "meta.json").write_text(json.dumps({"cost": cost}))
            self.assertEqual(server.new_run_cost(1.0, ["c01", "c02"]), 0.3)           # 1.0 total - 0.7 already billed
            self.assertEqual(server.new_run_cost(1.0, []), 1.0)                       # a fresh story bills everything
            self.assertEqual(server.new_run_cost(0.5, ["c01", "c02"]), 0.0)           # never negative
            self.assertEqual(server.new_run_cost(0.5, ["missing"]), 0.5)              # unknown prior clip counts as 0


class UsageHookTests(LiveServerCase):
    def setUp(self):
        p = mock.patch.object(server, "PRICE_MULTIPLIER", 5.0)
        p.start()
        self.addCleanup(p.stop)
        with auth._tx() as c:
            c.execute("DELETE FROM usage_events")
            c.execute("UPDATE users SET balance=?, daily_cap=0, engines='', daily_minutes=0 WHERE id=?",
                      (100 * auth.MICRO, self.uid["alice"]))

    def rows(self):
        with auth._tx() as c:
            return [dict(r) for r in c.execute("SELECT user_id, kind, engine, provider_micro, charged_micro FROM usage_events ORDER BY id")]

    def _generate(self, who="alice"):
        body = {"prompt": "a cat", "tier": "lite", "resolution": "720p", "duration": 8, "aspect": "16:9"}
        r = self.req(who, "POST", "/api/generate", json.dumps(body))
        self.assertEqual(r.status, 202)
        return json.loads(r.body)["jobId"]

    def test_should_log_a_finished_video_with_real_cost_and_the_multiplied_charge_once(self):
        job_id = self._generate()
        server.job_update(job_id, status="done", detail="done", genId="x", cost=0.20)
        server.job_update(job_id, status="done", detail="again", cost=0.20)               # a repeated update must not double count
        self.assertEqual(self.rows(), [{"user_id": self.uid["alice"], "kind": "video", "engine": "lite",
                                        "provider_micro": 200_000, "charged_micro": 1_000_000}])

    def test_should_not_log_a_failed_video(self):
        job_id = self._generate()
        server.job_update(job_id, status="failed")
        self.assertEqual(self.rows(), [])

    def test_should_log_admin_use_as_cost_with_nothing_charged(self):
        job_id = self._generate("admin")
        server.job_update(job_id, status="done", detail="done", genId="x", cost=0.20)
        row = self.rows()[0]
        self.assertEqual((row["user_id"], row["provider_micro"], row["charged_micro"]), (self.uid["admin"], 200_000, 0))

    def test_should_log_chat_and_picture_use(self):
        with mock.patch.object(openrouter_chat, "chat", return_value=("hi", 0.001)):
            self.req("alice", "POST", "/api/chat", json.dumps({"engine": "chat-deepseek", "messages": [{"role": "user", "content": "hello"}]}))
        with mock.patch.object(openrouter_chat, "generate_image", return_value=(PNG, "png", 0.018)):
            self.req("alice", "POST", "/api/image", json.dumps({"engine": "img-seedream", "prompt": "a baby elephant waving"}))
        got = [(r["kind"], r["engine"], r["provider_micro"], r["charged_micro"]) for r in self.rows()]
        self.assertEqual(got, [("chat", "chat-deepseek", 1_000, 5_000), ("image", "img-seedream", 18_000, 90_000)])

    def test_should_not_log_a_chat_that_failed_at_the_provider(self):
        with mock.patch.object(openrouter_chat, "chat", side_effect=RuntimeError("boom")):
            self.req("alice", "POST", "/api/chat", json.dumps({"engine": "chat-deepseek", "messages": [{"role": "user", "content": "hello"}]}))
        self.assertEqual(self.rows(), [])

    def test_should_show_the_profit_to_admins_only(self):
        job_id = self._generate()
        server.job_update(job_id, status="done", detail="done", genId="x", cost=0.20)
        page = self.req("admin", "GET", "/admin?embed=1").body.decode()
        self.assertIn("Usage &amp; profit", page)
        self.assertIn("+$0.80", page)                                       # paid $1.00, cost $0.20
        self.assertEqual(self.req("alice", "GET", "/admin?embed=1").status, 404)


if __name__ == "__main__":
    unittest.main()
