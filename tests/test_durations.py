"""Clip-length limit for ordinary users (default 5 s or 10 s); admins are never limited."""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth      # noqa: E402
import server    # noqa: E402
from harness import LiveServerCase   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MSG = "Clips can be 5 or 10 seconds long."


class ParsingTests(unittest.TestCase):
    def test_should_default_to_5_and_10_seconds(self):
        self.assertEqual(server.parse_user_durations(None), (5, 10))

    def test_should_accept_a_custom_list_sorted_and_deduplicated(self):
        for raw, want in (("5,10", (5, 10)), (" 10 ; 5,5 ", (5, 10)), ("3,abc,7", (3, 7)), ("8", (8,)), ("4, 6, 8", (4, 6, 8))):
            self.assertEqual(server.parse_user_durations(raw), want, raw)

    def test_should_switch_the_limit_off_explicitly(self):
        for raw in ("", "off", "OFF", "none", "all", "0", "  "):
            self.assertEqual(server.parse_user_durations(raw), (), repr(raw))

    def test_should_fall_back_to_the_default_on_junk_or_out_of_range_values(self):
        for raw in ("abc", "0,99", "61", "-5", "5.5,x"):
            self.assertEqual(server.parse_user_durations(raw), (5, 10), raw)

    def test_should_snap_to_the_nearest_allowed_length_preferring_the_shorter(self):
        got = [server.snap_duration(v, (5, 10)) for v in (1, 4, 5, 6, 7, 7.5, 8, 9, 10, 12, 30)]
        self.assertEqual(got, [5, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10])

    def test_should_never_limit_admins_or_anyone_when_the_limit_is_off(self):
        with mock.patch.object(server, "USER_DURATIONS", (5, 10)):
            self.assertEqual(server.allowed_durations({"role": "user"}), (5, 10))
            self.assertIsNone(server.allowed_durations({"role": "admin"}))
        with mock.patch.object(server, "USER_DURATIONS", ()):
            self.assertIsNone(server.allowed_durations({"role": "user"}))


class DurationHttpTests(LiveServerCase):
    def setUp(self):
        for p in (mock.patch.object(server, "USER_DURATIONS", (5, 10)), mock.patch.object(server, "run_story")):
            p.start()
            self.addCleanup(p.stop)
        with auth._tx() as c:
            c.execute("UPDATE users SET balance=?, daily_cap=0, engines='', daily_minutes=0 WHERE id=?",
                      (100 * auth.MICRO, self.uid["alice"]))

    def balance(self):
        return auth.account(self.uid["alice"])["balance"]

    def gen(self, who, tier, duration, res="720p"):
        body = {"prompt": "a cat", "tier": tier, "resolution": res, "duration": duration, "aspect": "16:9"}
        return self.req(who, "POST", "/api/generate", json.dumps(body))

    def story(self, who, tier, durations):
        body = {"title": "t", "tier": tier, "resolution": "720p", "aspect": "16:9",
                "scenes": [{"prompt": f"scene {i}", "duration": d} for i, d in enumerate(durations, 1)]}
        return self.req(who, "POST", "/api/story", json.dumps(body))

    def test_should_allow_5_and_10_seconds_on_a_seedance_engine(self):
        for d in (5, 10):
            self.assertEqual(self.gen("alice", "seedance-mini", d).status, 202, d)

    def test_should_refuse_other_lengths_and_spend_nothing(self):
        before = self.balance()
        dirs = {p.name for p in server.GENERATIONS.iterdir()}
        for d in (4, 6, 8, 12, 15):
            r = self.gen("alice", "seedance-mini", d)
            self.assertEqual((r.status, json.loads(r.body)["error"]), (400, MSG), d)
        self.assertEqual(self.balance(), before)
        self.assertEqual({p.name for p in server.GENERATIONS.iterdir()}, dirs)

    def test_should_explain_when_the_engine_cannot_make_an_allowed_length(self):
        for tier in ("lite", "fast", "quality", "grok"):                     # Veo is 4/6/8 s, Grok 4/6/8 s
            r = self.gen("alice", tier, 5, "720p")
            self.assertEqual(r.status, 400, tier)
            self.assertIn("can't make 5-second clips", json.loads(r.body)["error"])
            self.assertIn("Seedance", json.loads(r.body)["error"])

    def test_should_never_limit_an_admin(self):
        self.assertEqual(self.gen("admin", "lite", 8).status, 202)             # Veo 8 s
        self.assertEqual(self.gen("admin", "seedance-mini", 7).status, 202)    # not 5 or 10

    def test_should_check_every_scene_of_a_story(self):
        self.assertEqual(self.story("alice", "seedance-mini", [5, 10, 5]).status, 202)
        before = self.balance()
        r = self.story("alice", "seedance-mini", [5, 8])
        self.assertEqual((r.status, json.loads(r.body)["error"]), (400, "scene 2: " + MSG))
        self.assertEqual(self.balance(), before)
        self.assertEqual(self.story("admin", "seedance-mini", [4, 7, 12]).status, 202)

    def test_should_snap_old_pending_scenes_when_a_story_is_resumed(self):
        sid = "resume-legacy"
        d = server.GENERATIONS / sid
        d.mkdir()
        (d / "meta.json").write_text(json.dumps({
            "id": sid, "kind": "story", "status": "partial", "tier": "seedance-mini", "resolution": "720p", "aspectRatio": "9:16",
            "prompt": "t", "sourceIds": [], "createdAt": "2026-01-01T00:00:00+00:00",
            "pendingScenes": [{"prompt": "a", "duration": 6, "imageIndex": None}, {"prompt": "b", "duration": 8, "imageIndex": None}]}))
        auth.claim(sid, self.uid["alice"])
        r = self.req("alice", "POST", "/api/story/resume", json.dumps({"id": sid}))
        self.assertEqual(r.status, 202)
        args = server.run_story.call_args.args[2]
        self.assertEqual([s["duration"] for s in args["scenes"]], [5, 10])

    def test_should_tell_the_page_which_lengths_are_allowed(self):
        self.assertEqual(json.loads(self.req("alice", "GET", "/api/me").body)["allowedDurations"], [5, 10])
        self.assertIsNone(json.loads(self.req("admin", "GET", "/api/me").body)["allowedDurations"])
        self.assertIn('"allowedDurations": [5, 10]', self.req("alice", "GET", "/").body.decode())
        self.assertIn('"allowedDurations": null', self.req("admin", "GET", "/").body.decode())


@unittest.skipUnless(shutil.which("node"), "node not installed")
class BrowserHelperTests(unittest.TestCase):
    """The helpers the screens use, run for real under node."""
    def run_js(self, allowed, body):
        src = (ROOT / "ui" / "vg-core.jsx").read_text()

        def block(start, end):
            i = src.index(start)
            return src[i:src.index(end, i) + len(end)]
        code = "\n".join([block("const VG_DURATIONS_BY_TIER = {", "\n};"), "const VG_DEFAULT_DURATIONS = [4, 6, 8];",
                          block("const VG_TIERS = [", "\n];"),
                          block("function vgAllowedDurations", "\n}\n"), block("function vgSnapDuration", "\n}\n"),
                          block("function vgAllowedEngines", "\n}\n"),
                          block("function vgTiersForUser", "\n}\n"), block("function vgDefaultTierId", "\n}\n")])
        script = f"global.window={{VG_USER:{{allowedDurations:{json.dumps(allowed)}}}}};\n{code}\n{body}"
        return json.loads(subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout)

    def test_should_offer_a_limited_user_only_engines_that_can_make_every_allowed_length(self):
        got = self.run_js([5, 10], "console.log(JSON.stringify(vgTiersForUser().map(t => t.id)))")
        self.assertEqual(set(got), {"seedance", "seedance-fast", "seedance-mini", "seedance-2.5", "ark-seedance-mini"})
        for veo_or_grok in ("lite", "standard", "pro", "grok"):
            self.assertNotIn(veo_or_grok, got)

    def test_should_give_admins_everything_and_leave_durations_alone(self):
        got = self.run_js(None, "console.log(JSON.stringify([vgTiersForUser().length, vgSnapDuration(7), vgAllowedDurations()]))")
        self.assertEqual(got, [9, 7, None])

    def test_should_snap_to_5_or_10_and_pick_a_working_default_engine(self):
        got = self.run_js([5, 10], "console.log(JSON.stringify([[4,5,6,7,8,9,12].map(vgSnapDuration), vgDefaultTierId()]))")
        self.assertEqual(got, [[5, 5, 5, 5, 10, 10, 10], "seedance-mini"])
        self.assertEqual(self.run_js(None, "console.log(JSON.stringify(vgDefaultTierId()))"), "lite")

    def test_should_follow_a_custom_limit_such_as_veo_lengths(self):
        got = self.run_js([4, 8], "console.log(JSON.stringify([vgTiersForUser().some(t => t.id === 'lite'), vgDefaultTierId()]))")
        self.assertEqual(got, [True, "lite"])


if __name__ == "__main__":
    unittest.main()
