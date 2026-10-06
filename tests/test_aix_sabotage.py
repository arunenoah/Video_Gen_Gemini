"""Sabotage! logic (run under node) plus a few safety greps on its files."""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGIC = ROOT / "ui" / "vg-aix-sabotage.js"
CORE = ROOT / "ui" / "vg-aix-core.js"
VIEW = ROOT / "ui" / "vg-aix-sabotage.jsx"
NODE = shutil.which("node")


def run_js(expr):
    """Evaluate `expr` with S = sabotage module and C = core, return JSON."""
    code = (f"const S=require({json.dumps(str(LOGIC))});const C=require({json.dumps(str(CORE))});"
            f"console.log(JSON.stringify({expr}))")
    return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)


@unittest.skipUnless(NODE, "node not installed")
class SabotageLogicTests(unittest.TestCase):
    def test_should_have_eight_items_with_two_known_tags_each(self):
        items = run_js("S.ITEMS")
        self.assertEqual(len(items), 8)
        for it in items:
            self.assertEqual(len(it["tags"]), 2)
            self.assertTrue(set(it["tags"]) <= {"round", "long", "soft", "hard", "sweet"})
            self.assertIn(it["label"], ("food", "not food"))

    def test_should_have_four_food_and_four_not_food_items_with_unique_tag_pairs(self):
        items = run_js("S.ITEMS")
        self.assertEqual(sum(1 for i in items if i["label"] == "food"), 4)
        self.assertEqual(len({tuple(sorted(i["tags"])) for i in items}), 8)

    def test_should_get_every_order_right_when_labels_are_honest(self):
        r = run_js("S.runOrders(S.train(S.ITEMS), S.ORDERS)")
        self.assertEqual(len(r), 8)
        self.assertTrue(all(x["correct"] for x in r))

    def test_should_flip_that_items_decision_when_one_label_is_flipped(self):
        for item in run_js("S.ITEMS"):
            out = run_js(f"(()=>{{const l={{{json.dumps(item['id'])}:{json.dumps('not food' if item['label'] == 'food' else 'food')}}};"
                         f"const m=S.train(S.labelled(S.ITEMS,l));const it=S.ITEMS.find(i=>i.id==={json.dumps(item['id'])});return S.decide(m,it)}})()")
            self.assertNotEqual(out, item["label"], item["id"])

    def test_should_serve_a_shoe_as_a_snack_when_shoe_is_labelled_food(self):
        r = run_js("S.runOrders(S.train(S.labelled(S.ITEMS,{shoe:'food'})),S.ORDERS.filter(o=>o.item==='shoe'))")[0]
        self.assertEqual(r["decision"], "food")
        self.assertFalse(r["correct"])
        self.assertIn("shoe", run_js(f"S.outcomeLine({json.dumps(r)})"))

    def test_should_return_not_food_when_bolt_has_learned_nothing(self):
        self.assertEqual(run_js("S.decide(S.train([]),S.ITEMS[0])"), "not food")
        self.assertEqual(run_js("S.decide(null,S.ITEMS[0])"), "not food")

    def test_should_fall_back_to_true_label_when_label_is_invalid(self):
        out = run_js("S.labelled(S.ITEMS,{banana:'<b>',apple:42}).map(i=>i.label).slice(0,2)")
        self.assertEqual(out, ["food", "food"])
        self.assertEqual(run_js("S.labelled(S.ITEMS,null)[0].label"), "food")

    def test_should_count_only_labels_that_differ_from_the_truth(self):
        self.assertEqual(run_js("S.countFlips(S.ITEMS,{banana:'not food',apple:'food',shoe:'food'})"), 2)
        self.assertEqual(run_js("S.countFlips(S.ITEMS,{})"), 0)
        self.assertEqual(run_js("S.countFlips(S.ITEMS,{banana:'garbage'})"), 0)

    def test_should_pick_five_unique_orders_and_always_include_sabotaged_items(self):
        orders = run_js("S.pickOrders(C.rng(3),5,['shoe','sock','banana'])")
        items = [o["item"] for o in orders]
        self.assertEqual(len(items), 5)
        self.assertEqual(len(set(items)), 5)
        self.assertTrue({"shoe", "sock", "banana"} <= set(items))

    def test_should_pick_the_same_orders_for_the_same_seed_and_vary_across_seeds(self):
        a = run_js("S.pickOrders(C.rng(11),5,[])")
        self.assertEqual(a, run_js("S.pickOrders(C.rng(11),5,[])"))
        seen = {tuple(o["item"] for o in run_js(f"S.pickOrders(C.rng({s}),5,[])")) for s in range(1, 8)}
        self.assertGreater(len(seen), 1)

    def test_should_shuffle_items_by_seed_without_losing_any(self):
        a = run_js("S.pickItems(C.rng(5)).map(i=>i.id)")
        self.assertEqual(sorted(a), sorted(i["id"] for i in run_js("S.ITEMS")))
        self.assertEqual(a, run_js("S.pickItems(C.rng(5)).map(i=>i.id)"))

    def test_should_cap_orders_at_pool_size_when_more_are_asked_for(self):
        self.assertEqual(len(run_js("S.pickOrders(C.rng(1),20,[])")), 8)

    def test_should_give_stars_by_the_spec_rules(self):
        self.assertEqual(run_js("S.starsFor(0,0)"), 1)
        self.assertEqual(run_js("S.starsFor(2,4)"), 1)      # not naughty enough
        self.assertEqual(run_js("S.starsFor(3,3)"), 1)      # not fixed enough
        self.assertEqual(run_js("S.starsFor(3,4)"), 2)
        self.assertEqual(run_js("S.starsFor(4,5)"), 3)
        self.assertEqual(run_js("S.starsFor(1,5)"), 3)
        self.assertEqual(run_js("S.starsFor(0,5)"), 1)      # skipped the naughtiness: no 3 stars

    def test_should_never_break_runorders_on_junk(self):
        self.assertEqual(run_js("S.runOrders(S.train(S.ITEMS),[{item:'nope'}])"), [])
        self.assertEqual(run_js("S.runOrders(S.train(S.ITEMS),null)"), [])

    def test_should_have_a_funny_line_for_both_outcomes_of_every_item(self):
        for it in run_js("S.ITEMS"):
            self.assertGreater(len(it["ok"]), 10)
            self.assertGreater(len(it["bad"]), 10)


class SabotageFileSafetyTests(unittest.TestCase):
    BANNED = re.compile(r"innerHTML|dangerouslySetInnerHTML|\beval\(|new Function|document\.write|\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|type=\"text\"|<textarea|<input")

    def test_should_not_use_banned_apis_or_text_inputs(self):
        for f in (LOGIC, VIEW):
            self.assertIsNone(self.BANNED.search(f.read_text()), f.name)

    def test_should_register_the_game_and_use_shell_helpers(self):
        src = VIEW.read_text()
        self.assertIn("window.AIX_GAMES.sabotage", src)
        self.assertIn("window.AixBolt", src)
        self.assertIn("aixSfx", src)


if __name__ == "__main__":
    unittest.main()
