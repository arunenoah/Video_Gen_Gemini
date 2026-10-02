"""Prompt Lab: the pure validation/assembly logic (run under node) and the page wiring."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGIC = ROOT / "ui" / "vg-lab-logic.js"
NODE = shutil.which("node")


FORMATS = ROOT / "ui" / "vg-formats.js"


def run_fmt(expr):
    code = f"const F=require({json.dumps(str(FORMATS))});console.log(JSON.stringify({expr}))"
    return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)


def run_js(expr):
    """Evaluate `expr` against the lab module and return its JSON result."""
    code = f"const L=require({json.dumps(str(LOGIC))});console.log(JSON.stringify({expr}))"
    return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)


@unittest.skipUnless(NODE, "node not installed")
class LabLogicTests(unittest.TestCase):
    FULL_IMAGE = {"idea": "A puppy learning to skateboard", "happening": "jumping over a puddle and laughing",
                  "who": "a small brown puppy", "place": "on a rainy road", "lighting": "grey rainy afternoon"}

    def test_should_mark_everything_missing_when_empty(self):
        r = run_js("L.validate('image',{})")
        self.assertFalse(r["ready"])
        self.assertTrue(all(i["status"] == "missing" for i in r["items"]))
        self.assertEqual(r["score"], 0)

    def test_should_flag_a_one_word_idea_as_vague(self):
        r = run_js("L.validate('image',{idea:'dog'})")
        self.assertEqual(next(i for i in r["items"] if i["id"] == "idea")["status"], "vague")

    def test_should_be_ready_when_all_needed_picture_cards_are_ok(self):
        r = run_js(f"L.validate('image',{json.dumps(self.FULL_IMAGE)})")
        self.assertTrue(r["ready"])
        self.assertEqual(r["score"], 80 + 0)          # no bonus cards filled yet

    def test_should_need_animation_for_video_but_not_picture(self):
        img = run_js(f"L.validate('image',{json.dumps(self.FULL_IMAGE)})")
        vid = run_js(f"L.validate('video',{json.dumps(self.FULL_IMAGE)})")
        self.assertTrue(img["ready"])
        self.assertFalse(vid["ready"])
        self.assertIn("motion", [i["id"] for i in vid["items"]])
        self.assertNotIn("motion", [i["id"] for i in img["items"]])

    def test_should_assemble_in_card_order_ignoring_empty_cards(self):
        v = {"lighting": "warm sunset glow.", "idea": "A robot planting a garden"}
        self.assertEqual(run_js(f"L.assemble('image',{json.dumps(v)})"), "A robot planting a garden. warm sunset glow.")
        self.assertEqual(run_js("L.assemble('image',{})"), "")

    def test_should_cap_each_card_length(self):
        out = run_js("L.parts('image',{idea:'x '.repeat(500)})")
        self.assertLessEqual(len(out[0]["text"]), 200)

    def test_should_give_a_hint_for_the_next_needed_card(self):
        r = run_js("L.validate('image',{idea:'A puppy on a skateboard'})")
        self.assertIn("scene", r["nextHint"].lower())


@unittest.skipUnless(NODE, "node not installed")
class FormatTests(unittest.TestCase):
    def test_should_offer_all_fourteen_formats_with_a_question_each(self):
        fs = run_fmt("F.FORMATS")
        self.assertEqual(len(fs), 14)
        self.assertEqual(len({f["id"] for f in fs}), 14)
        for f in fs:
            self.assertIn("{t}", f["phrase"])
            self.assertTrue(f["asks"].endswith("?"))

    def test_should_strip_question_words_from_the_topic(self):
        self.assertEqual(run_fmt("F.topicOf('How does a car work?')"), "a car")
        self.assertEqual(run_fmt("F.topicOf('x'.repeat(400)).length"), 120)

    def test_should_suggest_fitting_formats_first(self):
        top = lambda q: [f["id"] for f in run_fmt(f"F.suggestFormats({json.dumps(q)}).top")]
        self.assertIn("process", top("How does a car work?"))
        self.assertIn("cutaway", top("What is inside a volcano?"))
        self.assertIn("compare", top("difference between petrol and electric car"))
        self.assertEqual(len(top("")), 4)                          # defaults when nothing hints

    def test_should_split_top_and_more_without_losing_any(self):
        r = run_fmt("(s=>[s.top.length,s.more.length])(F.suggestFormats('why is the sky blue'))")
        self.assertEqual(sum(r), 14)

    def test_should_build_a_prompt_within_the_server_limit(self):
        out = run_fmt("F.buildFormatPrompt('x'.repeat(500), F.byId('labelled'))")
        self.assertLessEqual(len(out), 1000)
        self.assertIn("labelled diagram", out)


@unittest.skipUnless(NODE, "node not installed")
class StoryCheckTests(unittest.TestCase):
    GOOD = ("Suddenly, the garden gate began to glow. Pip, a tiny robot, saw a bright light and felt nervous. "
            "But the gate was stuck, and he needed to find the key before dark. To his surprise, the key was in a kitten's paw! "
            "Finally, they opened the gate together and went home happy.")

    def test_should_score_a_complete_story_high(self):
        r = run_js(f"L.evaluateStory({json.dumps(self.GOOD)})")
        self.assertGreaterEqual(r["score"], 85)
        self.assertTrue(all(c["ok"] for c in r["checks"]))

    def test_should_list_what_is_missing_with_a_tip_and_example(self):
        r = run_js("L.evaluateStory('The cat sat. It was a day.')")
        missing = [c for c in r["checks"] if not c["ok"]]
        self.assertGreaterEqual(len(missing), 3)
        for c in missing:
            self.assertTrue(c["tip"] and c["example"])

    def test_should_score_zero_for_empty_text(self):
        self.assertEqual(run_js("L.evaluateStory('')")["score"], 0)

    def test_should_cap_story_length(self):
        self.assertLessEqual(run_js("L.evaluateStory('word '.repeat(1000)).words"), 300)

    def test_should_offer_the_explain_as_card_with_all_formats(self):
        card = run_js("L.CARDS.find(c=>c.id==='layout')")
        self.assertEqual(len(card["chips"]), 14)


class LabWiringTests(unittest.TestCase):
    def test_should_load_lab_scripts_before_the_shell(self):
        html = (ROOT / "ui" / "VideoGen.html").read_text()
        self.assertLess(html.index("vg-lab-logic.js"), html.index("vg-views-lab.jsx"))
        self.assertLess(html.index("vg-views-lab.jsx"), html.index("vg-views-chat.jsx"))

    def test_should_not_inject_html_from_typed_text(self):
        self.assertNotIn("dangerouslySetInnerHTML", (ROOT / "ui" / "vg-views-lab.jsx").read_text())
        self.assertNotIn("innerHTML", (ROOT / "ui" / "vg-views-lab.jsx").read_text())

    def test_should_add_the_sidebar_item_and_pane(self):
        chat = (ROOT / "ui" / "vg-views-chat.jsx").read_text()
        self.assertIn("modeBtn('lab'", chat)
        self.assertIn("<PromptLabPane", chat)

    def test_should_wire_the_format_picker_into_chat_and_pictures(self):
        chat = (ROOT / "ui" / "vg-views-chat.jsx").read_text()
        self.assertGreaterEqual(chat.count("<FormatPicker"), 2)
        self.assertIn("onPrefillPicture={prefillPicture}", chat)
        html = (ROOT / "ui" / "VideoGen.html").read_text()
        self.assertLess(html.index("vg-formats.js"), html.index("vg-lab-logic.js"))


if __name__ == "__main__":
    unittest.main()
