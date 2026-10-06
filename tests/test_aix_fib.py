"""Fib Finder: pure logic (run under node) plus the view's safety rules."""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGIC = ROOT / "ui" / "vg-aix-fib.js"
VIEW = ROOT / "ui" / "vg-aix-fib.jsx"
CORE = ROOT / "ui" / "vg-aix-core.js"
NODE = shutil.which("node")


def run_js(expr):
    """Evaluate `expr` with F (fib logic) and C (core) in scope and return its JSON result."""
    code = (f"const F=require({json.dumps(str(LOGIC))});const C=require({json.dumps(str(CORE))});"
            f"console.log(JSON.stringify({expr}))")
    return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)


@unittest.skipUnless(NODE, "node not installed")
class FibLogicTests(unittest.TestCase):
    def test_should_have_at_least_twelve_rounds_with_unique_ids(self):
        ids = run_js("F.ROUNDS.map(r=>r.id)")
        self.assertGreaterEqual(len(ids), 12)
        self.assertEqual(len(ids), len(set(ids)))

    def test_should_have_four_or_five_sentences_and_a_valid_fib_in_every_round(self):
        for r in run_js("F.ROUNDS"):
            self.assertIn(len(r["sentences"]), (4, 5), r["id"])
            self.assertTrue(0 <= r["fib"] < len(r["sentences"]), r["id"])
            self.assertEqual(len(set(r["sentences"])), len(r["sentences"]), r["id"])
            for key in ("question", "truth", "tip", "topic"):
                self.assertTrue(r[key].strip(), f"{r['id']} missing {key}")

    def test_should_not_always_hide_the_fib_in_the_same_place(self):
        self.assertGreaterEqual(len({r["fib"] for r in run_js("F.ROUNDS")}), 3)

    def test_should_pick_three_distinct_rounds_when_asked(self):
        ids = run_js("F.pickRounds(C.rng(5),3).map(r=>r.id)")
        self.assertEqual(len(ids), 3)
        self.assertEqual(len(set(ids)), 3)

    def test_should_pick_the_same_rounds_when_seed_repeats(self):
        a = run_js("F.pickRounds(C.rng(42),3).map(r=>r.id)")
        b = run_js("F.pickRounds(C.rng(42),3).map(r=>r.id)")
        self.assertEqual(a, b)

    def test_should_pick_different_rounds_for_different_seeds(self):
        picks = {tuple(run_js(f"F.pickRounds(C.rng({s}),3).map(r=>r.id)")) for s in range(1, 12)}
        self.assertGreater(len(picks), 1)

    def test_should_clamp_count_when_n_is_out_of_range(self):
        self.assertEqual(len(run_js("F.pickRounds(C.rng(1),999)")), len(run_js("F.ROUNDS")))
        self.assertEqual(len(run_js("F.pickRounds(C.rng(1),0)")), 1)
        self.assertEqual(len(run_js("F.pickRounds(C.rng(1),'x')")), 1)

    def test_should_not_reorder_the_rounds_table_when_picking(self):
        self.assertEqual(run_js("(()=>{const b=F.ROUNDS.map(r=>r.id);F.pickRounds(C.rng(3),5);return F.ROUNDS.map(r=>r.id).join()===b.join()})()"), True)

    def test_should_be_correct_only_for_the_fib_index(self):
        for r in run_js("F.ROUNDS"):
            n = len(r["sentences"])
            for idx in range(n):
                res = run_js(f"F.check(F.ROUNDS.find(x=>x.id==='{r['id']}'),{idx})")
                self.assertEqual(res["correct"], idx == r["fib"])
                self.assertEqual(res["fibIndex"], r["fib"])

    def test_should_not_throw_when_check_gets_bad_input(self):
        self.assertEqual(run_js("F.check(null,0)"), {"correct": False, "fibIndex": -1})
        self.assertFalse(run_js("F.check(F.ROUNDS[0],-1)")["correct"])
        self.assertFalse(run_js("F.check(F.ROUNDS[0],'2')")["correct"])
        self.assertFalse(run_js("F.check(F.ROUNDS[0],undefined)")["correct"])

    def test_should_give_stars_by_first_try_catches(self):
        self.assertEqual(run_js("F.starsFor(3,3)"), 3)
        self.assertEqual(run_js("F.starsFor(2,3)"), 2)
        self.assertEqual(run_js("F.starsFor(1,3)"), 1)
        self.assertEqual(run_js("F.starsFor(0,3)"), 1)      # finishing always earns a star

    def test_should_stay_between_one_and_three_stars_when_input_is_odd(self):
        for a, b in [("-5", "3"), ("NaN", "NaN"), ("99", "3"), ("null", "0"), ("'2'", "3")]:
            self.assertIn(run_js(f"F.starsFor({a},{b})"), (1, 2, 3))


class FibViewSafetyTests(unittest.TestCase):
    def setUp(self):
        self.text = VIEW.read_text(encoding="utf-8") + LOGIC.read_text(encoding="utf-8")

    def test_should_not_use_banned_apis(self):
        for bad in ("innerHTML", "dangerouslySetInnerHTML", "eval(", "new Function", "document.write",
                    "fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "<textarea", 'type="text"', "<input"):
            self.assertNotIn(bad, self.text, bad)

    def test_should_not_contain_emoji(self):
        self.assertIsNone(re.search("[\U0001F000-\U0001FAFF☀-➿⭐]", self.text))

    def test_should_register_the_game_for_the_shell(self):
        self.assertIn("window.AIX_GAMES.fib = AixFibGame", VIEW.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
