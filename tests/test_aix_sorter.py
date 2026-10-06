"""Pet Sorter: pure logic (run under node) plus view-file safety checks."""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGIC = ROOT / "ui" / "vg-aix-sorter.js"
CORE = ROOT / "ui" / "vg-aix-core.js"
VIEW = ROOT / "ui" / "vg-aix-sorter.jsx"
NODE = shutil.which("node")


def run_js(expr):
    """Evaluate `expr` with S = sorter logic and R = AIXCore.rng, return its JSON result."""
    code = (f"const S=require({json.dumps(str(LOGIC))});const R=require({json.dumps(str(CORE))}).rng;"
            f"const byId=(id)=>S.POOL.find(p=>p.id===id);"
            f"const ex=(ids,label)=>ids.map(i=>({{creature:byId(i),label:label}}));"
            f"console.log(JSON.stringify({expr}))")
    return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)


@unittest.skipUnless(NODE, "node not installed")
class SorterLogicTests(unittest.TestCase):
    def test_should_have_a_balanced_pool_of_at_least_14_unique_pets(self):
        r = run_js("({n:S.POOL.length,ids:new Set(S.POOL.map(p=>p.id)).size,cats:S.POOL.filter(p=>p.cls==='cat').length,dogs:S.POOL.filter(p=>p.cls==='dog').length})")
        self.assertGreaterEqual(r["n"], 14)
        self.assertEqual(r["ids"], r["n"])
        self.assertGreaterEqual(min(r["cats"], r["dogs"]), 6)

    def test_should_only_use_declared_tag_values_for_every_pet(self):
        self.assertTrue(run_js("S.POOL.every(p=>Object.keys(S.FEATURES).every(f=>S.FEATURES[f].includes(p[f])))"))

    def test_should_include_deliberately_tricky_pets(self):
        # a floppy-eared cat and a pointy-eared dog
        self.assertTrue(run_js("S.POOL.some(p=>p.cls==='cat'&&p.ears==='floppy')"))
        self.assertTrue(run_js("S.POOL.some(p=>p.cls==='dog'&&p.ears==='pointy')"))

    def test_should_split_into_10_train_and_4_unseen_test_pets_without_overlap(self):
        r = run_js("(()=>{const t=S.pickTrainAndTest(R(5));const ids=new Set(t.train.map(p=>p.id));return {tr:t.train.length,te:t.test.length,overlap:t.test.filter(p=>ids.has(p.id)).length,"
                   "tc:t.test.filter(p=>p.cls==='cat').length,trc:t.train.filter(p=>p.cls==='cat').length}})()")
        self.assertEqual((r["tr"], r["te"], r["overlap"]), (10, 4, 0))
        self.assertEqual((r["tc"], r["trc"]), (2, 5))

    def test_should_be_deterministic_for_the_same_seed_and_vary_across_seeds(self):
        same = run_js("JSON.stringify(S.pickTrainAndTest(R(9)))===JSON.stringify(S.pickTrainAndTest(R(9)))")
        self.assertTrue(same)
        sigs = run_js("[1,2,3,4,5,6].map(s=>S.pickTrainAndTest(R(s)).test.map(p=>p.id).join())")
        self.assertGreater(len(set(sigs)), 1)

    def test_should_be_unsure_at_exactly_half_when_untrained(self):
        p = run_js("S.predict(S.train([]),byId('rex'))")
        self.assertAlmostEqual(p["confidence"], 0.5, places=6)

    def test_should_learn_to_call_woofers_dogs_when_shown_labelled_examples(self):
        # 3 clear cats and 3 clear dogs, then an unseen dog
        r = run_js("(()=>{const m=S.train(ex(['mittens','pudding','noodle'],'cat').concat(ex(['biscuit','waffles','sprout'],'dog')));return S.predict(m,byId('doodle'))})()")
        self.assertEqual(r["label"], "dog")
        self.assertGreater(r["confidence"], 0.6)

    def test_should_raise_confidence_as_more_examples_are_dropped(self):
        r = run_js("(()=>{const pets=S.POOL;const a=S.train(ex(['mittens'],'cat'));const b=S.train(ex(['mittens','pudding','noodle'],'cat').concat(ex(['biscuit','waffles','sprout'],'dog')));"
                   "return [S.meter(S.train([]),pets),S.meter(a,pets),S.meter(b,pets)]})()")
        self.assertAlmostEqual(r[0], 0.5, places=6)
        self.assertGreater(r[2], r[0])

    def test_should_follow_the_kids_labels_even_when_they_are_wrong(self):
        # kid puts the cats in the Dog pile and dogs in the Cat pile: Bolt learns exactly that
        r = run_js("(()=>{const m=S.train(ex(['mittens','pudding','noodle'],'dog').concat(ex(['biscuit','waffles','sprout'],'cat')));return S.predict(m,byId('rex')).label})()")
        self.assertEqual(r, "cat")

    def test_should_ignore_junk_examples_without_throwing(self):
        r = run_js("(()=>{const m=S.train([null,{},{creature:byId('rex'),label:'fish'},{creature:byId('rex'),label:'dog'},'x']);return m.total})()")
        self.assertEqual(r, 1)
        self.assertEqual(run_js("S.train(undefined).total"), 0)

    def test_should_smooth_unseen_tags_so_confidence_stays_finite(self):
        # a model that only ever saw cats must still return a real number for an unseen dog look
        r = run_js("S.predict(S.train(ex(['mittens'],'cat')),byId('frost'))")
        self.assertTrue(0.5 <= r["confidence"] <= 1)

    def test_should_return_confidence_between_half_and_one(self):
        self.assertTrue(run_js("S.POOL.every(p=>{const c=S.predict(S.train(ex(['mittens','rex'],'cat')),p).confidence;return c>=0.5&&c<=1})"))

    def test_should_score_a_test_and_flag_unsure_guesses(self):
        r = run_js("(()=>{const m=S.train(ex(['mittens','pudding','noodle','zigzag'],'cat').concat(ex(['biscuit','waffles','sprout','rex'],'dog')));"
                   "return S.scoreTest(m,[byId('duchess'),byId('doodle'),byId('pip'),byId('frost')])})()")
        self.assertEqual(r["total"], 4)
        self.assertEqual(r["correct"], sum(1 for x in r["results"] if x["right"]))
        self.assertGreaterEqual(r["correct"], 3)

    def test_should_score_zero_total_for_an_empty_test(self):
        r = run_js("S.scoreTest(S.train([]),[])")
        self.assertEqual((r["correct"], r["total"]), (0, 0))

    def test_should_award_stars_by_accuracy_and_amount_of_training(self):
        self.assertEqual(run_js("S.starsFor(4,8)"), 3)
        self.assertEqual(run_js("S.starsFor(4,10)"), 3)
        self.assertEqual(run_js("S.starsFor(4,6)"), 2)       # perfect but barely trained
        self.assertEqual(run_js("S.starsFor(3,10)"), 2)
        self.assertEqual(run_js("S.starsFor(2,10)"), 1)
        self.assertEqual(run_js("S.starsFor(0,0)"), 1)       # finishing always earns a star

    def test_should_never_be_negative_when_a_pet_goes_in_the_wrong_pile(self):
        r = run_js("S.reaction(byId('mittens'),'dog',R(1))")
        self.assertFalse(r["agree"])
        self.assertEqual(r["mood"], "confused")
        self.assertIn("dog", r["text"])

    def test_should_use_the_quirk_line_for_a_tricky_pet_in_the_right_pile(self):
        r = run_js("S.reaction(byId('sirfold'),'cat',R(1))")
        self.assertTrue(r["agree"])
        self.assertEqual(r["text"], run_js("byId('sirfold').quirk"))

    def test_should_give_a_happy_reaction_for_a_plain_pet_in_the_right_pile(self):
        r = run_js("S.reaction(byId('rex'),'dog',R(3))")
        self.assertIn(r["mood"], ["happy", "proud"])


class SorterFileSafetyTests(unittest.TestCase):
    SRC = None

    @classmethod
    def setUpClass(cls):
        cls.SRC = LOGIC.read_text() + "\n" + VIEW.read_text()

    def test_should_not_use_banned_apis(self):
        for bad in ["innerHTML", "dangerouslySetInnerHTML", "eval(", "new Function", "document.write", "fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon"]:
            self.assertNotIn(bad, self.SRC, bad)

    def test_should_have_no_text_inputs(self):
        self.assertIsNone(re.search(r"<(input|textarea)\b", self.SRC))

    def test_should_register_the_game_for_the_shell(self):
        self.assertIn("window.AIX_GAMES.sorter = AixSorterGame", VIEW.read_text())

    def test_should_offer_click_to_place_as_well_as_drag(self):
        v = VIEW.read_text()
        self.assertIn("draggable", v)
        self.assertIn("onClick={() => pickPet", v)

    def test_should_not_contain_emoji(self):
        self.assertIsNone(re.search("[\U0001F300-\U0001FAFF☀-➿]", self.SRC))


if __name__ == "__main__":
    unittest.main()
