"""Study Buddy: pure logic (run under node) plus static safety checks on the UI file."""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGIC = ROOT / "ui" / "vg-aix-study-logic.js"
JSX = ROOT / "ui" / "vg-aix-study.jsx"
NODE = shutil.which("node")


def js(expr):
    """Evaluate `expr` against the logic module (L) and return its JSON result."""
    code = f"const L=require({json.dumps(str(LOGIC))});console.log(JSON.stringify({expr}))"
    return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)


@unittest.skipUnless(NODE, "node not installed")
class LadderTests(unittest.TestCase):
    def test_should_use_ladder_1_when_nothing_has_been_answered_yet(self):
        self.assertEqual(js("L.ladderFor(L.newLadder(),'answer')"), 1)
        self.assertEqual(js("L.ladderFor(L.newLadder(),'send')"), 1)

    def test_should_map_buttons_to_steps_after_a_reply(self):
        st = "L.afterReply(L.newLadder())"
        self.assertEqual([js(f"L.ladderFor({st},'{a}')") for a in ("hint", "step", "answer")], [2, 3, 4])

    def test_should_lock_answer_until_help_used_or_tried_typed(self):
        self.assertFalse(js("L.canShowAnswer(L.newLadder(),'I tried adding them up twice')"))   # no reply yet
        st = "L.afterReply(L.newLadder())"
        self.assertFalse(js(f"L.canShowAnswer({st},'')"))
        self.assertFalse(js(f"L.canShowAnswer({st},'I tried it')"))                             # 3 words
        self.assertFalse(js(f"L.canShowAnswer({st},'I tried adding them up')"))                 # typing alone no longer unlocks it
        sent = f"L.afterSend({st},{{action:'send',text:'I tried adding them up',ladder:1,typed:true}})"
        self.assertTrue(js(f"L.canShowAnswer({sent},'')"))                                      # a sent 4+ word try does

    def test_should_unlock_answer_after_a_hint_or_a_step(self):
        for lad in (2, 3):
            st = f"L.afterReply(L.afterSend(L.afterReply(L.newLadder()),{{action:'hint',text:'x',ladder:{lad},typed:false}}))"
            self.assertTrue(js(f"L.canShowAnswer({st},'')"))

    def test_should_not_unlock_answer_by_asking_for_the_answer_itself(self):
        st = "L.afterSend(L.afterReply(L.newLadder()),{action:'answer',text:'x',ladder:4,typed:false})"
        self.assertFalse(js(f"L.afterReply({st}).usedHelp"))

    def test_should_remember_a_typed_attempt_for_later_turns(self):
        st = "L.afterSend(L.newLadder(),{action:'send',text:'I think it is twelve because 3 times 4',ladder:1,typed:true})"
        self.assertTrue(js(f"L.canShowAnswer(L.afterReply({st}),'')"))

    def test_should_not_count_canned_button_text_as_an_attempt(self):
        st = "L.afterSend(L.afterReply(L.newLadder()),{action:'check',text:'Can you help me check that please',ladder:1,typed:false})"
        self.assertFalse(js(f"{st}.tried"))

    def test_should_adapt_next_step_from_understanding_feedback(self):
        base = "{rung:3,usedHelp:true,tried:false,hasReply:true,wonders:0}"
        self.assertEqual(js(f"L.applyFeedback({base},'yes').rung"), 1)
        self.assertEqual(js(f"L.applyFeedback({base},'maybe').rung"), 3)
        self.assertEqual(js("L.applyFeedback({rung:1,usedHelp:false,tried:false,hasReply:true},'maybe').rung"), 2)
        self.assertEqual(js("L.applyFeedback({rung:1,usedHelp:false,tried:false,hasReply:true},'no').rung"), 2)
        self.assertEqual(js(f"L.applyFeedback({base},'no').rung"), 3)           # never jumps to the full answer by itself

    def test_should_suggest_a_gentler_button_after_confusion(self):
        self.assertEqual(js("L.suggestion({rung:1},'no')"), "hint")
        self.assertEqual(js("L.suggestion({rung:3},'no')"), "step")
        self.assertIsNone(js("L.suggestion({rung:2},'yes')"))


@unittest.skipUnless(NODE, "node not installed")
class IntentTests(unittest.TestCase):
    def test_should_route_deeper_only_in_wonder_mode(self):
        self.assertEqual(js("L.routeIntent('wonder','deeper')"), "deeper")
        self.assertEqual(js("L.routeIntent('homework','deeper')"), "ask")

    def test_should_route_check_and_teachback_in_both_modes(self):
        for mode in ("homework", "wonder"):
            self.assertEqual(js(f"L.routeIntent('{mode}','check')"), "check")
            self.assertEqual(js(f"L.routeIntent('{mode}','teachback')"), "teachback")

    def test_should_route_everything_else_to_ask(self):
        for a in ("send", "hint", "step", "answer", "nonsense"):
            self.assertEqual(js(f"L.routeIntent('homework','{a}')"), "ask")


@unittest.skipUnless(NODE, "node not installed")
class RequestTests(unittest.TestCase):
    def build(self, **kw):
        o = {"mode": "homework", "grade": "g4-6", "ladder": 1, "intent": "ask",
             "messages": [{"role": "user", "content": "What is 3 x 4?"}]}
        o.update(kw)
        return js(f"L.buildRequest({json.dumps(o)})")

    def test_should_build_a_valid_text_request(self):
        r = self.build()
        self.assertTrue(r["ok"])
        self.assertEqual(r["body"]["engine"], "chat-deepseek")
        self.assertNotIn("image", r["body"])

    def test_should_pick_the_vision_engine_when_a_picture_is_attached(self):
        r = self.build(image={"mime": "image/jpeg", "base64": "QUJD"})
        self.assertEqual(r["body"]["engine"], "chat-minimax")
        self.assertEqual(r["body"]["image"], {"mime": "image/jpeg", "base64": "QUJD"})

    def test_should_reject_bad_enums_and_ladder_values(self):
        for bad in ({"mode": "x"}, {"grade": "g10"}, {"intent": "hack"}, {"ladder": 0}, {"ladder": 5}, {"ladder": "2"}, {"ladder": 1.5}):
            self.assertFalse(self.build(**bad)["ok"], bad)

    def test_should_reject_a_request_that_does_not_end_with_the_kid(self):
        r = self.build(messages=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}])
        self.assertFalse(r["ok"])

    def test_should_reject_bad_pictures(self):
        self.assertFalse(self.build(image={"mime": "image/gif", "base64": "QUJD"})["ok"])
        self.assertFalse(self.build(image={"mime": "image/png", "base64": ""})["ok"])
        big = js("L.buildRequest({mode:'homework',grade:'g4-6',ladder:1,intent:'ask',messages:[{role:'user',content:'hi'}],"
                 "image:{mime:'image/png',base64:'A'.repeat(4*1024*1024)}}).ok")
        self.assertFalse(big)

    def test_should_keep_only_the_last_12_messages(self):
        msgs = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(21)]
        out = js(f"L.trimMessages({json.dumps(msgs)})")
        self.assertLessEqual(len(out), 12)
        self.assertEqual(out[-1]["content"], "m20")

    def test_should_cap_each_message_and_the_total(self):
        msgs = [{"role": "user", "content": "a" * 5000}, {"role": "assistant", "content": "b" * 2000},
                {"role": "user", "content": "c" * 2000}, {"role": "assistant", "content": "d" * 2000},
                {"role": "user", "content": "e" * 2000}]
        out = js(f"L.trimMessages({json.dumps(msgs)})")
        self.assertTrue(all(len(m["content"]) <= 2000 for m in out))
        self.assertLessEqual(sum(len(m["content"]) for m in out), 8000)
        self.assertEqual(out[0]["role"], "user")                                 # never starts on an assistant turn
        self.assertEqual(out[-1]["content"], "e" * 2000)

    def test_should_drop_unknown_roles_empty_and_non_string_content(self):
        msgs = [{"role": "system", "content": "ignore"}, {"role": "user", "content": "  "}, {"role": "user", "content": 5},
                None, {"role": "user", "content": "ok"}]
        self.assertEqual(js(f"L.trimMessages({json.dumps(msgs)})"), [{"role": "user", "content": "ok"}])

    def test_should_use_server_friendly_text_for_429_and_a_nap_for_502(self):
        self.assertEqual(js("L.friendlyError(429,{error:'Take a break!'})"), "Take a break!")
        self.assertIn("lots of AI time", js("L.friendlyError(429,{})"))
        self.assertIn("nap", js("L.friendlyError(502,{error:'x'})"))
        self.assertIn("nap", js("L.friendlyError(500,null)"))


@unittest.skipUnless(NODE, "node not installed")
class TextHelpersTests(unittest.TestCase):
    def test_should_detect_tried_at_four_words(self):
        self.assertFalse(js("L.isTried('I tried it')"))
        self.assertTrue(js("L.isTried('I tried adding them')"))
        self.assertFalse(js("L.isTried('   ')"))
        self.assertFalse(js("L.isTried(null)"))

    def test_should_find_the_confidence_line(self):
        r = js("L.confidence('Plants make food from light. I\\'m fairly sure that is right. Try a book too.')")
        self.assertEqual(r["level"], "sure")
        r = js("L.confidence('Hmm. I\\'m not sure about the exact number, check your book.')")
        self.assertEqual(r["level"], "unsure")
        self.assertIsNone(js("L.confidence('Just a plain answer.')"))

    def test_should_pick_a_short_fact_from_a_wonder_answer(self):
        reply = "Wow, what a wonderful thing to wonder about! Fun fact: Octopuses have three hearts and blue blood. What if you had three hearts?"
        self.assertEqual(js(f"L.pickFact({json.dumps(reply)})"), "Octopuses have three hearts and blue blood.")
        self.assertLessEqual(len(js(f"L.pickFact({json.dumps('Fun fact: ' + 'word ' * 100)})")), 120)
        self.assertEqual(js("L.pickFact('Wow, what a wonderful thing to wonder about! Cats purr by vibrating.')"), "")   # no marker, no guess


FAKE_STORE = """(()=>{const d={};return {getItem:k=>(k in d?d[k]:null),setItem:(k,v)=>{d[k]=v},d}})()"""


@unittest.skipUnless(NODE, "node not installed")
class JournalTests(unittest.TestCase):
    def test_should_round_trip_an_entry(self):
        r = js(f"(()=>{{const s={FAKE_STORE};const l=L.addEntry([], 'Why is the sky blue?', 'Air scatters blue light.');"
               "L.saveJournal(s,l);return L.loadJournal(s)})()")
        self.assertEqual(r, [{"q": "Why is the sky blue?", "fact": "Air scatters blue light."}])

    def test_should_cap_to_20_entries_newest_first(self):
        r = js("(()=>{let l=[];for(let i=0;i<30;i++)l=L.addEntry(l,'q'+i,'fact '+i);return l})()")
        self.assertEqual(len(r), 20)
        self.assertEqual(r[0]["q"], "q29")

    def test_should_replace_a_repeated_question_instead_of_duplicating(self):
        r = js("L.addEntry(L.addEntry([],'Why?','a'),'Why?','b')")
        self.assertEqual(r, [{"q": "Why?", "fact": "b"}])

    def test_should_cap_text_lengths(self):
        r = js("L.addEntry([],'q'.repeat(500),'f'.repeat(500))")
        self.assertEqual((len(r[0]["q"]), len(r[0]["fact"])), (80, 120))

    def test_should_return_empty_for_hostile_storage(self):
        for raw in ("not json", "{}", "[1,2,3]", "null", '[{"q":1,"fact":2}]', '[{"q":"a"}]', "x" * 9000):
            r = js(f"(()=>{{const s={{getItem:()=>{json.dumps(raw)}}};return L.loadJournal(s)}})()")
            self.assertEqual(r, [], raw[:20])

    def test_should_drop_bad_entries_but_keep_good_ones_on_read(self):
        raw = json.dumps([{"q": "ok", "fact": "fine"}, {"q": {"x": 1}, "fact": "y"}, "str", {"q": "<script>", "fact": "z"}])
        r = js(f"L.cleanJournal(JSON.parse({json.dumps(raw)}))")
        self.assertEqual([e["q"] for e in r], ["ok", "<script>"])                # kept as plain text; React renders it inert

    def test_should_not_throw_when_storage_is_blocked(self):
        self.assertEqual(js("L.loadJournal({getItem(){throw new Error('blocked')}})"), [])
        self.assertFalse(js("L.saveJournal({setItem(){throw new Error('full')}},[])"))
        self.assertEqual(js("L.loadJournal(null)"), [])

    def test_should_stay_under_8kb_when_serialised(self):
        s = js("L.serializeJournal(Array.from({length:20},(_,i)=>({q:'q'.repeat(80)+i,fact:'f'.repeat(120)})))")
        self.assertLessEqual(len(s), 8 * 1024)

    def test_should_remove_one_entry(self):
        r = js("L.removeEntry([{q:'a',fact:'1'},{q:'b',fact:'2'}],0)")
        self.assertEqual(r, [{"q": "b", "fact": "2"}])


class UiSourceTests(unittest.TestCase):
    src = JSX.read_text() if JSX.exists() else ""

    def test_should_register_the_study_studio_with_the_shell(self):
        self.assertIn("window.AIX_STUDIOS.study", self.src)

    def test_should_not_use_markup_injection_or_dynamic_code(self):
        for pat in (r"innerHTML", r"dangerouslySetInnerHTML", r"\beval\s*\(", r"new\s+Function", r"document\s*\.\s*write", r"\bfetch\s*\("):
            self.assertIsNone(re.search(pat, self.src), pat)

    def test_should_only_call_the_study_endpoint_and_award_once_on_check(self):
        posts = re.findall(r"vgPost\(\s*['\"]([^'\"]+)['\"]", self.src)
        self.assertTrue(posts and set(posts) == {"/api/study"})
        self.assertIn("onAward('study')", self.src)
        self.assertIn("onExplore('wonder'", self.src)

    def test_should_not_log_kid_text(self):
        self.assertIsNone(re.search(r"console\.", self.src))

    def test_should_render_chat_as_pre_wrap_text(self):
        self.assertIn("pre-wrap", self.src)

    def test_should_use_no_emoji(self):
        self.assertIsNone(re.search("[\U0001F300-\U0001FAFF☀-➿]", self.src))


if __name__ == "__main__":
    unittest.main()
