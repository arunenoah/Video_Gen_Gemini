"""Engine picker for kids: the page learns which engines the admin allowed, lists only those, and hides the picker
entirely when exactly one is left (the kid then just chooses 16:9 or 9:16). The server still enforces the limit."""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth      # noqa: E402
from harness import LiveServerCase   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class AllowedEnginesHttpTests(LiveServerCase):
    def tearDown(self):
        auth.set_limits(self.uid["alice"], 0, list(auth.ENGINE_IDS))      # back to unrestricted

    def _limit(self, engines):
        self.assertTrue(auth.set_limits(self.uid["alice"], 0, engines))

    def test_should_tell_the_page_exactly_which_engines_a_limited_kid_may_use(self):
        self._limit(["seedance-mini", "chat-deepseek"])
        me = json.loads(self.req("alice", "GET", "/api/me").body)
        self.assertEqual(me["allowedEngines"], ["seedance-mini", "chat-deepseek"])
        self.assertIn('"allowedEngines": ["seedance-mini", "chat-deepseek"]', self.req("alice", "GET", "/").body.decode())

    def test_should_send_null_for_admins_and_for_unrestricted_kids(self):
        self.assertIsNone(json.loads(self.req("admin", "GET", "/api/me").body)["allowedEngines"])
        self.assertIsNone(json.loads(self.req("alice", "GET", "/api/me").body)["allowedEngines"])
        self.assertIn('"allowedEngines": null', self.req("admin", "GET", "/").body.decode())

    def test_should_only_ever_send_known_engine_ids(self):
        self._limit(["grok", "not-a-real-engine", "<script>"])
        sent = json.loads(self.req("alice", "GET", "/api/me").body)["allowedEngines"]
        self.assertEqual(sent, ["grok"])

    def test_should_still_refuse_a_disallowed_engine_on_the_server(self):
        self._limit(["grok"])
        body = json.dumps({"engine": "chat-deepseek", "messages": [{"role": "user", "content": "hi there"}]})
        self.assertEqual(self.req("alice", "POST", "/api/chat", body).status, 403)


@unittest.skipUnless(shutil.which("node"), "node not installed")
class PickerLogicTests(unittest.TestCase):
    """The real helper functions from ui/vg-core.jsx, run under node."""

    def run_js(self, user, body):
        src = (ROOT / "ui" / "vg-core.jsx").read_text()

        def block(start, end):
            i = src.index(start)
            return src[i:src.index(end, i) + len(end)]
        code = "\n".join([block("const VG_DURATIONS_BY_TIER = {", "\n};"), "const VG_DEFAULT_DURATIONS = [4, 6, 8];",
                          block("const VG_TIERS = [", "\n];"), block("function vgAllowedDurations", "\n}\n"),
                          block("function vgAllowedEngines", "\n}\n"), block("function vgTiersForUser", "\n}\n"),
                          block("function vgShowEnginePicker", "\n"), block("function vgDefaultTierId", "\n}\n")])
        script = f"global.window={{VG_USER:{json.dumps(user)}}};\n{code}\n{body}"
        return json.loads(subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout)

    SHOW = "console.log(JSON.stringify({tiers: vgTiersForUser().map(t => t.id), show: vgShowEnginePicker(), def: vgDefaultTierId()}))"

    def test_should_hide_the_picker_and_use_the_only_allowed_engine(self):
        got = self.run_js({"allowedEngines": ["seedance-mini"]}, self.SHOW)
        self.assertEqual(got, {"tiers": ["seedance-mini"], "show": False, "def": "seedance-mini"})
        got = self.run_js({"allowedEngines": ["grok"]}, self.SHOW)
        self.assertEqual(got, {"tiers": ["grok"], "show": False, "def": "grok"})

    def test_should_list_only_the_allowed_engines_when_there_are_several(self):
        got = self.run_js({"allowedEngines": ["grok", "seedance-mini", "chat-deepseek", "img-ming"]}, self.SHOW)
        self.assertEqual(got["tiers"], ["grok", "seedance-mini"])          # chat / picture ids are not video engines
        self.assertTrue(got["show"])
        self.assertEqual(got["def"], "seedance-mini")

    def test_should_show_everything_for_admins_and_unrestricted_kids(self):
        for user in ({"role": "admin", "allowedEngines": None}, {"allowedEngines": None}, {}):
            got = self.run_js(user, self.SHOW)
            self.assertEqual(len(got["tiers"]), 9)
            self.assertTrue(got["show"])
            self.assertEqual(got["def"], "lite")

    def test_should_treat_a_malformed_allowed_list_as_no_limit(self):
        for bad in ("grok", [], 7, {"a": 1}):
            got = self.run_js({"allowedEngines": bad}, self.SHOW)
            self.assertEqual(len(got["tiers"]), 9, bad)

    def test_should_combine_the_engine_limit_with_the_clip_length_limit(self):
        # grok cannot make 5 s / 10 s clips, so a 5/10-only kid limited to grok has nothing usable: no picker, safe default
        got = self.run_js({"allowedEngines": ["grok"], "allowedDurations": [5, 10]}, self.SHOW)
        self.assertEqual(got, {"tiers": [], "show": False, "def": "lite"})
        got = self.run_js({"allowedEngines": ["grok", "seedance-mini"], "allowedDurations": [5, 10]}, self.SHOW)
        self.assertEqual(got, {"tiers": ["seedance-mini"], "show": False, "def": "seedance-mini"})


class PickerWiringTests(unittest.TestCase):
    def test_should_guard_both_engine_pickers_with_the_single_engine_rule(self):
        for name, marker in (("vg-views-input.jsx", "Which engine builds it?"), ("vg-views-output.jsx", "Model & quality")):
            src = (ROOT / "ui" / name).read_text()
            before = src[:src.index(marker)]
            self.assertIn("vgShowEnginePicker()", before[-400:], name)

    def test_should_keep_the_selected_engine_valid_in_the_app_shell(self):
        html = (ROOT / "ui" / "VideoGen.html").read_text()
        self.assertIn("vgTiersForUser()", html)
        self.assertIn("setTierId(vgDefaultTierId())", html)

    def test_should_keep_the_aspect_choice_for_everyone(self):
        for name in ("vg-views-input.jsx", "vg-views-output.jsx"):
            self.assertIn("VG_ASPECTS", (ROOT / "ui" / name).read_text(), name)


if __name__ == "__main__":
    unittest.main()
