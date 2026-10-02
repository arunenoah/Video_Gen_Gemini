"""Price multiplier (what people pay = provider cost x N) and ballpark display."""
import base64
import io
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth               # noqa: E402
import openrouter_chat    # noqa: E402
import server             # noqa: E402
from harness import LiveServerCase   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


class MultiplierParsingTests(unittest.TestCase):
    def test_should_default_to_five_and_clamp_to_a_sane_range(self):
        for raw, want in ((None, 5.0), ("", 5.0), ("5", 5.0), ("2.5", 2.5), ("1", 1.0), ("0.2", 1.0), ("-3", 1.0),
                          ("100", 100.0), ("5000", 100.0), ("abc", 5.0), ("nan", 5.0), ("inf", 5.0), ("-inf", 5.0)):
            self.assertEqual(server.parse_price_multiplier(raw), want, raw)


class PricingHttpTests(LiveServerCase):
    def setUp(self):
        p = mock.patch.object(server, "PRICE_MULTIPLIER", 5.0)
        p.start()
        self.addCleanup(p.stop)
        with auth._tx() as c:                                 # a clean, funded user: $100, all engines, no limits
            c.execute("UPDATE users SET balance=?, daily_cap=0, engines='', daily_minutes=0 WHERE id=?",
                      (100 * auth.MICRO, self.uid["alice"]))

    def balance(self):
        return auth.account(self.uid["alice"])["balance"]

    def _generate(self):
        body = {"prompt": "a cat", "tier": "lite", "resolution": "720p", "duration": 8, "aspect": "16:9"}
        r = self.req("alice", "POST", "/api/generate", json.dumps(body))
        self.assertEqual(r.status, 202)
        return json.loads(r.body)["jobId"]

    def test_should_reserve_five_times_the_provider_estimate(self):
        est = server.engine_estimate("lite", "720p", 8)
        start = self.balance()
        job_id = self._generate()
        self.assertEqual(start - self.balance(), auth.to_micro(est * 5))
        shown = json.loads(self.req("alice", "GET", f"/api/job/{job_id}").body)
        self.assertEqual(shown["estCost"], round(est * 5, 4))              # the page is told the same number
        server.job_update(job_id, status="failed")                          # (cleanup: refund)

    def test_should_settle_on_the_multiplied_final_cost_and_show_it(self):
        start = self.balance()
        job_id = self._generate()
        server.job_update(job_id, status="done", detail="done", genId="x", cost=0.20)       # provider billed $0.20
        self.assertEqual(start - self.balance(), auth.to_micro(0.20 * 5))                   # user pays $1.00
        shown = json.loads(self.req("alice", "GET", f"/api/job/{job_id}").body)
        self.assertEqual(shown["cost"], 1.0)
        for internal in ("owner", "reserved", "settled"):
            self.assertNotIn(internal, shown)

    def test_should_refund_the_full_multiplied_hold_when_the_job_fails(self):
        start = self.balance()
        job_id = self._generate()
        self.assertLess(self.balance(), start)
        server.job_update(job_id, status="failed")
        self.assertEqual(self.balance(), start)

    def test_should_refuse_when_credits_cover_the_raw_cost_but_not_the_multiplied_one(self):
        est = server.engine_estimate("lite", "720p", 8)                    # $0.40 real -> $2.00 for the user
        with auth._tx() as c:
            c.execute("UPDATE users SET balance=? WHERE id=?", (auth.to_micro(est * 2), self.uid["alice"]))   # $0.80: enough at 1x
        body = {"prompt": "a cat", "tier": "lite", "resolution": "720p", "duration": 8, "aspect": "16:9"}
        r = self.req("alice", "POST", "/api/generate", json.dumps(body))
        self.assertEqual(r.status, 402)
        self.assertIn("Not enough credits", json.loads(r.body)["error"])

    def test_should_charge_chat_and_pictures_on_the_same_multiplier(self):
        start = self.balance()
        with mock.patch.object(openrouter_chat, "chat", return_value=("hi", 0.001)):
            r = self.req("alice", "POST", "/api/chat", json.dumps({"engine": "chat-deepseek", "messages": [{"role": "user", "content": "hello"}]}))
        self.assertEqual(r.status, 200)
        self.assertEqual(start - self.balance(), auth.to_micro(0.001 * 5))
        start = self.balance()
        with mock.patch.object(openrouter_chat, "generate_image", return_value=(PNG, "png", 0.018)):
            r = self.req("alice", "POST", "/api/image", json.dumps({"engine": "img-seedream", "prompt": "a baby elephant waving"}))
        self.assertEqual(start - self.balance(), auth.to_micro(0.018 * 5))
        self.assertEqual(json.loads(r.body)["cost"], 0.09)

    def test_should_show_multiplied_costs_in_the_library_but_keep_the_real_cost_on_disk(self):
        d = server.GENERATIONS / "priced-gen"
        d.mkdir(exist_ok=True)
        (d / "meta.json").write_text(json.dumps({"id": "priced-gen", "createdAt": "2026-01-01", "kind": "clip", "cost": 0.6}))
        (d / "clip.mp4").write_bytes(b"x")
        auth.claim("priced-gen", self.uid["alice"])
        entry = [e for e in json.loads(self.req("alice", "GET", "/api/list").body) if e["id"] == "priced-gen"][0]
        self.assertEqual(entry["meta"]["cost"], 3.0)
        self.assertEqual(json.loads((d / "meta.json").read_text())["cost"], 0.6)          # provider cost kept for the books

    def test_should_tell_the_page_the_multiplier(self):
        self.assertEqual(json.loads(self.req("alice", "GET", "/api/me").body)["priceMultiplier"], 5.0)
        page = self.req("alice", "GET", "/").body.decode()
        self.assertIn('"priceMultiplier": 5.0', page)


@unittest.skipUnless(shutil.which("node"), "node not installed")
class BallparkDisplayTests(unittest.TestCase):
    """vgBallpark is browser code: run the real function under node."""
    def ballpark(self, values):
        src = (ROOT / "ui" / "vg-core.jsx").read_text()
        start = src.index("function vgBallpark")
        fn = src[start:src.index("\n}\n", start) + 3]
        out = subprocess.run(["node", "-e", fn + f"\nconsole.log(JSON.stringify({json.dumps(values)}.map(vgBallpark)))"],
                             capture_output=True, text=True, check=True).stdout
        return json.loads(out)

    def test_should_round_to_a_guide_never_an_exact_figure(self):
        got = self.ballpark([0, -1, 0.03, 0.44, 0.96, 2.05, 3.3, 4.77, 12.4, 47.6])
        self.assertEqual(got, ["free", "free", "about $0.10", "about $0.40", "about $1", "about $2", "about $3.50",
                               "about $5", "about $12", "about $48"])

    def test_should_never_print_cents_precision_beyond_the_rounding_step(self):
        for n in (0.123456, 1.2345, 7.777, 99.99):
            text = self.ballpark([n])[0]
            self.assertRegex(text, r"^about \$\d+(\.\d{2})?$")
            self.assertNotIn("0001", text)


if __name__ == "__main__":
    unittest.main()
