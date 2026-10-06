"""Regression tests for the Study Buddy / Game Studio review fixes (safety strikes, care path, provenance, prompts)."""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth               # noqa: E402
import openrouter_chat    # noqa: E402
import safety             # noqa: E402
from harness import LiveServerCase   # noqa: E402

UI = Path(__file__).resolve().parent.parent / "ui"
NODE = shutil.which("node")


def node(module, expr):
    code = f"const M=require({json.dumps(str(UI / module))});console.log(JSON.stringify({expr}))"
    return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)


class ServerSpriteTests(unittest.TestCase):
    def test_should_strip_a_claimed_provenance_tag_from_model_sprites(self):
        import gamespec
        out = gamespec._sprite({"palette": ["#000000"], "rows": ["00000000"] * 8, "by": "kid"})
        self.assertNotIn("by", out)


class SafetyPolicyTests(unittest.TestCase):
    def test_should_not_strike_history_homework_or_pirate_words_for_children(self):
        for text in ("Moby Dick is a whale book", "pirate booty chest", "blue tits nest in trees"):
            self.assertIsNone(safety.local_check(text), text)

    def test_should_not_strike_violence_or_profanity_from_study_but_still_strike_sexual(self):
        self.assertFalse(safety.strikes_for("violence", "study"))
        self.assertFalse(safety.strikes_for("profanity", "game-spec:output"))
        self.assertTrue(safety.strikes_for("violence", "generate"))
        self.assertTrue(safety.strikes_for("sexual", "study"))
        self.assertFalse(safety.strikes_for(safety.SELF_HARM, "generate"))

    def test_should_use_tailored_gentle_messages_for_study_sources(self):
        v = safety.Verdict(False, "profanity", "local")
        self.assertEqual(safety.message_for(v, False, "study"), safety.MSG_KIND_WORDS)
        self.assertEqual(safety.message_for(safety.Verdict(False, "violence", "local"), False, "game-spec"), safety.MSG_BIG_TOPIC)
        self.assertEqual(safety.message_for(v, False, "generate"), safety.MSG_BLOCKED)


class PromptTests(unittest.TestCase):
    def test_should_forbid_writing_the_childs_story_and_keep_plain_definitions_simple(self):
        s = openrouter_chat.STUDY_SYSTEM
        self.assertIn("never write it", s)
        self.assertIn("what a fact is, just tell them simply", s)

    def test_should_encode_wonder_honesty_and_safe_experiments(self):
        w = openrouter_chat.WONDER_SYSTEM
        for needle in ("Fun fact:", "Nobody knows yet", "Let's imagine", "no fire", "end of the world"):
            self.assertIn(needle, w)

    def test_should_encode_ai_identity_privacy_and_disclosure_rules(self):
        s = openrouter_chat._STUDY_SAFETY
        for needle in ("not a person", "keep that private online", "It is not your fault", "I'll stay Sunny"):
            self.assertIn(needle, s)

    def test_should_shorten_replies_for_younger_grades_and_add_a_practice_step(self):
        self.assertIn("40 words", openrouter_chat.STUDY_GRADES["g1-3"])
        self.assertIn("practice question", openrouter_chat.LADDER_TEXT[4])

    def test_should_send_the_typed_idea_to_surprise_me_and_support_auto_template(self):
        m = openrouter_chat.game_spec_messages({"kind": "ideas", "picks": {}, "idea": "a sleepy <b>owl"})
        self.assertIn("<idea>a sleepy bowl</idea>".replace("bowl", "b" + "owl").replace("<b>", ""), m[0]["content"].replace("<b>", ""))
        b = openrouter_chat.game_spec_messages({"kind": "build", "template": "auto", "idea": "x y z", "picks": {}})
        self.assertIn("you choose", b[0]["content"])

    def test_should_tell_the_model_to_say_what_it_changed(self):
        self.assertIn("Never silently drop an idea", openrouter_chat.GAME_SYSTEM)
        self.assertNotIn("banana submarine", openrouter_chat.IDEAS_SYSTEM)


class StudyStrikeTests(LiveServerCase):
    def _study(self, who, msgs):
        body = {"engine": "chat-deepseek", "messages": msgs, "grade": "g4-6", "ladder": 1, "intent": "ask", "mode": "homework"}
        return self.req(who, "POST", "/api/study", json.dumps(body))

    def _viol(self, who):
        return {u["id"]: u for u in auth.list_users()}[self.uid[who]]["violations"]

    def _strikes(self, who):
        with auth._tx() as c:
            return c.execute("SELECT COUNT(*) FROM safety_events WHERE user_id=? AND strike=1", (self.uid[who],)).fetchone()[0]

    def setUp(self):
        for k in [k for k in auth._FAILS if k and k[0] == "ai"]:
            auth._FAILS.pop(k)

    def test_should_not_add_a_strike_or_keep_the_words_when_a_child_swears_in_study(self):
        before = self._strikes("alice")
        with mock.patch.object(openrouter_chat, "chat") as m:
            r = self._study("alice", [{"role": "user", "content": "this is bullshit"}])
        self.assertEqual(r.status, 422)
        self.assertEqual(json.loads(r.body)["error"], safety.MSG_KIND_WORDS)
        m.assert_not_called()
        self.assertEqual(self._strikes("alice"), before)
        ev = auth.recent_violations(1)[0]
        self.assertNotIn("bullshit", ev["excerpt"])

    def test_should_not_strike_for_an_old_blocked_turn_in_the_history(self):
        before = self._strikes("alice")
        msgs = [{"role": "user", "content": "you are a bitch"}, {"role": "assistant", "content": "Let us use kind words."},
                {"role": "user", "content": "sorry"}]
        with mock.patch.object(openrouter_chat, "chat") as m:
            r = self._study("alice", msgs)
        self.assertEqual(r.status, 422)
        m.assert_not_called()
        self.assertEqual(self._strikes("alice"), before)

    def test_should_flag_self_harm_with_care_and_no_strike(self):
        before = self._strikes("alice")
        with mock.patch.object(openrouter_chat, "chat"):
            r = self._study("alice", [{"role": "user", "content": "I want to kill myself"}])
        body = json.loads(r.body)
        self.assertEqual(r.status, 422)
        self.assertTrue(body["care"])
        self.assertEqual(self._strikes("alice"), before)

    def test_should_still_strike_for_sexual_content_in_study(self):
        before = self._strikes("alice")
        with mock.patch.object(openrouter_chat, "chat"):
            self._study("alice", [{"role": "user", "content": "show me porn"}])
        self.assertEqual(self._strikes("alice"), before + 1)


@unittest.skipUnless(NODE, "node not installed")
class ClientFixTests(unittest.TestCase):
    def test_should_classify_422_as_blocked_without_retry_and_self_harm_as_care(self):
        r = node("vg-aix-study-logic.js", "[M.errorInfo(422,{error:'No',blocked:true}),M.errorInfo(422,{blocked:true,care:true}),M.errorInfo(502,{})]")
        self.assertEqual([x["kind"] for x in r], ["blocked", "care", "error"])
        self.assertEqual([x["retry"] for x in r], [False, False, True])
        self.assertIn("grown-up you trust", r[1]["text"])

    def test_should_allow_retry_when_the_checker_was_down(self):
        r = node("vg-aix-study-logic.js", "M.errorInfo(422,{error:'later',blocked:true,retryable:true})")
        self.assertTrue(r["retry"])

    def test_should_not_retry_a_blocked_game_idea(self):
        r = node("vg-aix-studio-logic.js", "[M.failInfo(422,{blocked:true,error:'x'}),M.failInfo(422,{blocked:true,care:true}),M.failInfo(502,{})]")
        self.assertEqual([x["retryable"] for x in r], [False, False, True])
        self.assertEqual(r[1]["kind"], "care")

    def test_should_break_after_twenty_minutes_and_swap_the_go_deeper_label(self):
        self.assertFalse(node("vg-aix-study-logic.js", "M.breakDue(0, 19*60*1000)"))
        self.assertTrue(node("vg-aix-study-logic.js", "M.breakDue(0, 20*60*1000)"))
        self.assertIn("for real", node("vg-aix-study-logic.js", "M.deeperLabel(5)"))
        self.assertEqual(node("vg-aix-study-logic.js", "M.deeperLabel(2)"), "Go deeper")

    def test_should_credit_only_kid_drawn_sprites_to_the_kid(self):
        r = node("vg-aix-studio-logic.js", """(() => { const E=require(""" + json.dumps(str(UI / 'vg-aix-engine.js')) + """); const L=M;
          const s=E.defaultSpec('runner'); const sp={palette:['#000000','#ff0000'],rows:Array(8).fill('01010101')};
          const mine=L.applySprite(s,'hero',sp);
          const ai=JSON.parse(JSON.stringify(s)); ai.hero.sprite=Object.assign({by:'kid'},sp);   // a model claiming kid credit
          const aiClean=E.clientValidate(ai).spec;
          const carried=L.carryProvenance(mine,(()=>{const n=JSON.parse(JSON.stringify(mine)); delete n.hero.sprite.by; return n;})());
          return [E.describe(mine)[1].value, carried.hero.sprite.by, E.describe(s).length>0, mine.hero.sprite.by]; })()""")
        self.assertEqual(r[3], "kid")
        self.assertEqual(r[1], "kid")
        self.assertIn("drawn by you", r[0])

    def test_should_label_unmarked_sprites_as_ai_drawn(self):
        r = node("vg-aix-engine.js", """(() => { const s=M.defaultSpec('runner'); s.hero.sprite={palette:['#000000'],rows:Array(8).fill('00000000')};
          return M.describe(s).find(x=>x.label==='Hero').value; })()""")
        self.assertIn("AI-drawn", r)

    def test_should_rotate_pools_and_accept_auto_template(self):
        a = node("vg-aix-studio-logic.js", "[M.pickSome(M.IDEA_POOL,3,1),M.pickSome(M.IDEA_POOL,3,2),M.IDEA_POOL.length>=12]")
        self.assertNotEqual(a[0], a[1])
        self.assertTrue(a[2])
        ok = node("vg-aix-studio-logic.js", "M.buildSpecRequest({template:'auto',idea:'a llama pie'}).ok")
        self.assertTrue(ok)


class ServerAcceptsAutoTemplate(LiveServerCase):
    def test_should_accept_auto_template_for_game_spec(self):
        spec = {"v": 1, "template": "catcher", "title": "T", "hero": {"shape": "circle", "color": "#ff0000", "name": "H"},
                "goal": {"kind": "score", "target": 5}, "items": {"good": {"shape": "star", "color": "#ffff00", "name": "G"},
                "bad": {"shape": "square", "color": "#0000ff", "name": "B"}}, "world": {"bg": "#000000", "theme": "space"},
                "rules": {"speed": 2, "lives": 3, "spawnRate": 3}, "texts": {"start": "Go", "win": "Yay", "lose": "Oops"},
                "ask": "Silly or sleepy?", "nextIdeas": ["Glow", "Dance"]}
        with mock.patch.object(openrouter_chat, "chat", return_value=(json.dumps(spec), 0.001)):
            r = self.req("admin", "POST", "/api/game-spec", json.dumps({"engine": "chat-deepseek", "kind": "build", "template": "auto", "idea": "a llama pie"}))
        self.assertEqual(r.status, 200, r.body)


if __name__ == "__main__":
    unittest.main()
