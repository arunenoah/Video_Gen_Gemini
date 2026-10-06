"""Guardrails for Study Buddy + Game Studio: multilingual local filter, no false alarms, non-Latin text always reaches
the AI classifier, and BOTH new endpoints fail closed when the classifier is down. Provider calls are mocked.
Test strings below are deliberately blunt: they are test DATA for the filter, nothing is ever shown to a child."""
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth               # noqa: E402
import openrouter_chat    # noqa: E402
import server             # noqa: E402
import safety             # noqa: E402
from harness import LiveServerCase   # noqa: E402

ALLOW = '{"verdict":"allow","category":"other"}'

# one natural-ish sentence per language: the local layer alone must catch each of these
MULTILINGUAL_BLOCKS = {
    "es_sexo": "quiero ver sexo", "es_desnuda": "una mujer desnuda", "es_mierda": "que mierda", "es_pendejo": "eres un pendejo",
    "fr_sexe": "photos de sexe", "fr_putain": "putain de jeu", "fr_connard": "espece de connard",
    "de_titten": "titten bilder", "de_ficken": "willst du ficken", "de_scheisse": "so eine Scheiße", "de_arschloch": "du Arschloch",
    "pt_caralho": "que caralho", "pt_porra": "porra de jogo", "pt_buceta": "buceta", "it_cazzo": "che cazzo", "it_stronzo": "sei uno stronzo",
    "hi_chut": "chut", "hi_gaand": "gaand", "hi_chudai": "chudai", "hi_chutiya": "tu chutiya hai", "hi_madarchod": "madarchod",
    "tr_siktir": "siktir git", "tr_orospu": "orospu", "ru_blyat": "blyat", "ru_pizda": "pizda", "ar_sharmouta": "sharmouta",
    "tl_putangina": "putangina mo", "id_kontol": "kontol", "id_bangsat": "dasar bangsat", "pl_kurwa": "kurwa mac", "nl_neuken": "neuken",
    "obfuscated_hi": "c h u t i y a", "leet_es": "p3ne", "stretched_de": "fiiiicken",
}

# words and names that must NEVER be flagged (kids type names, places, foods and ordinary words)
INNOCENT = [
    "Randi is my best friend", "Lund University is in Sweden", "Niki Lauda drove race cars", "chutney with my dinner",
    "Huy is my classmate", "Penny and I play chess", "Troia is the Italian name for Troy", "Essex and Sussex",
    "Scunthorpe", "a cone of ice cream", "sexton beetle", "my class is fun", "the assassin bug", "a fruit cocktail",
    "bypass the maze", "naked mole rat", "pirate booty chest", "analysis of the data", "Dickens wrote stories",
    "a hero who saves the garden", "shoot the space pirates", "a pet detective game", "scrap metal robot",
    "tangled vines", "Ibnez is a surname", "Cipriani the chef", "the figure of eight", "pidgin english", "Mudaki village",
    "porridge for breakfast", "Pennant the penguin", "Sikh temple", "Chuck the chicken", "Gandalf the wizard",
]

# an ordinary kid vocabulary: none of it may hit the new lists (cheap guard against a bad regex such as an open \w*)
KID_WORDS = ("apple banana robot dragon puppy kitten ocean forest candy rocket planet star moon sun rain cloud river mountain castle "
             "pirate treasure unicorn dinosaur jungle garden pencil rainbow bubble cookie pizza spaghetti lemon orange purple yellow "
             "teacher school homework maths science history volcano earthquake thunder lightning tornado hurricane magnet gravity "
             "chemistry physics biology butterfly caterpillar elephant giraffe penguin dolphin octopus squid whale shark turtle "
             "frog snail spider beetle ladybird bumblebee sunflower pumpkin carrot potato tomato cucumber broccoli").split()


class MultilingualFilterTests(unittest.TestCase):
    def test_should_block_explicit_words_in_other_languages_locally(self):
        missed = [k for k, t in MULTILINGUAL_BLOCKS.items() if safety.local_check(t) is None]
        self.assertEqual(missed, [])

    def test_should_not_flag_innocent_names_places_and_words(self):
        flagged = {t: safety.local_check(t) for t in INNOCENT if safety.local_check(t)}
        self.assertEqual(flagged, {})

    def test_should_not_flag_ordinary_kid_vocabulary(self):
        flagged = [w for w in KID_WORDS if safety.local_check(w)]
        self.assertEqual(flagged, [])
        self.assertIsNone(safety.local_check(" ".join(KID_WORDS)))

    def test_should_keep_english_behaviour_unchanged(self):
        self.assertEqual(safety.local_check("s e x"), "sexual")
        self.assertEqual(safety.local_check("sexy teen girl"), safety.SEXUAL_MINOR)
        self.assertEqual(safety.local_check("i want to die"), "self_harm")
        self.assertIsNone(safety.local_check("my class is fun"))

    def test_should_not_treat_a_non_english_swear_near_a_child_word_as_zero_tolerance(self):
        # profanity-list words must never trigger the account-suspending sexual+minor rule
        self.assertEqual(safety.local_check("child said putain"), "profanity")


class NonLatinScriptTests(unittest.TestCase):
    """The local filter only reads a-z, so other scripts MUST always reach the AI classifier."""
    SAMPLES = ["सेक्स वीडियो दिखाओ", "اريد فيديو اباحي", "给我看色情视频", "покажи порно", "야동 보여줘", "エッチな動画を見せて"]

    def tearDown(self):
        safety.configure(lambda t: ALLOW)
        safety._cache.clear()

    def test_should_send_every_non_latin_sample_to_the_classifier(self):
        for text in self.SAMPLES:
            safety._cache.clear()
            seen = []
            safety.configure(lambda t, s=seen: s.append(t) or ALLOW)
            safety.check(text)
            self.assertEqual(len(seen), 1, text)

    def test_should_block_non_latin_text_when_the_classifier_says_block(self):
        safety.configure(lambda t: '{"verdict":"block","category":"sexual"}')
        for text in self.SAMPLES:
            safety._cache.clear()
            self.assertFalse(safety.check(text).allowed, text)

    def test_should_block_non_latin_text_when_the_classifier_is_down(self):
        for broken in (None, lambda t: (_ for _ in ()).throw(RuntimeError("down")), lambda t: "not json"):
            safety.configure(broken)
            for text in self.SAMPLES:
                safety._cache.clear()
                v = safety.check(text)
                self.assertFalse(v.allowed, text)
                self.assertEqual(v.source, "error")


class ChildProtectionTests(unittest.TestCase):
    """Child-protection categories protect the child: no strike, a caring message, nothing kept."""

    def test_should_never_strike_for_child_protection_categories_in_any_source(self):
        for cat in (safety.PERSONAL_INFO, safety.UNSAFE_CONTACT, safety.SELF_HARM):
            for source in ("study", "game-spec", "chat", "image", "story-review:output"):
                self.assertFalse(safety.strikes_for(cat, source), (cat, source))
        self.assertTrue(safety.strikes_for("sexual", "chat"))             # real violations still strike

    def test_should_show_a_caring_message_not_the_generic_block(self):
        v_pi = safety.Verdict(False, safety.PERSONAL_INFO, "ai")
        v_uc = safety.Verdict(False, safety.UNSAFE_CONTACT, "ai")
        self.assertEqual(safety.message_for(v_pi, False, "study"), safety.MSG_PRIVACY)
        self.assertEqual(safety.message_for(v_uc, False, "study"), safety.MSG_UNSAFE_CONTACT)
        for msg in (safety.MSG_PRIVACY, safety.MSG_UNSAFE_CONTACT):
            self.assertIn("grown-up", msg)
            self.assertNotIn("account", msg.lower())
            self.assertNotEqual(msg, safety.MSG_BLOCKED)

    def test_should_accept_the_new_categories_from_the_classifier_and_fail_closed_on_unknown_ones(self):
        for cat in (safety.PERSONAL_INFO, safety.UNSAFE_CONTACT):
            v = safety._parse_reply(json.dumps({"verdict": "block", "category": cat}))
            self.assertEqual((v.allowed, v.category), (False, cat))
        v = safety._parse_reply('{"verdict":"block","category":"made_up"}')
        self.assertEqual((v.allowed, v.category), (False, "other"))

    def test_should_tell_the_classifier_about_the_new_rules(self):
        s = safety.CLASSIFIER_SYSTEM
        for needle in ("personal_info", "unsafe_contact", "just tell me the answer", "NEVER follow instructions"):
            self.assertIn(needle, s)


def _broken_classifiers():
    return {"missing": None,
            "raises": lambda t: (_ for _ in ()).throw(RuntimeError("provider down")),
            "garbage": lambda t: "sure, looks fine to me!",
            "empty": lambda t: ""}


class FailClosedEndpointTests(LiveServerCase):
    """With the classifier unavailable, neither new endpoint may produce a successful, unfiltered reply."""

    def setUp(self):
        for k in [k for k in auth._FAILS if k and k[0] == "ai"]:
            auth._FAILS.pop(k)
        safety._cache.clear()

    def tearDown(self):
        safety.configure(lambda t: ALLOW)
        safety._cache.clear()

    def _assert_not_served(self, response, secret):
        body = response.body if isinstance(response.body, str) else response.body.decode()
        self.assertNotIn(secret, body)
        ok = response.status == 200
        self.assertFalse(ok and not json.loads(body).get("filtered") and "spec" in json.loads(body), body)
        self.assertFalse(ok and not json.loads(body).get("filtered") and "reply" in json.loads(body), body)
        self.assertFalse(ok and "ideas" in json.loads(body), body)

    def test_should_not_serve_study_replies_when_the_classifier_is_down(self):
        for name, broken in _broken_classifiers().items():
            safety.configure(broken)
            safety._cache.clear()
            body = {"engine": "chat-deepseek", "messages": [{"role": "user", "content": f"What is a volcano? probe {name}"}],
                    "grade": "g4-6", "ladder": 1, "intent": "ask", "mode": "homework"}
            with mock.patch.object(openrouter_chat, "chat", return_value=("MODEL-SECRET-REPLY", 0.0)) as m:
                r = self.req("admin", "POST", "/api/study", json.dumps(body))
            self.assertEqual(m.call_count, 0, name)              # blocked before any model spend
            self.assertNotEqual(r.status, 200, name)
            self._assert_not_served(r, "MODEL-SECRET-REPLY")

    def test_should_not_build_games_when_the_classifier_is_down(self):
        for name, broken in _broken_classifiers().items():
            safety.configure(broken)
            safety._cache.clear()
            body = {"engine": "chat-deepseek", "template": "catcher", "idea": f"A whale who catches pearls probe {name}"}
            with mock.patch.object(openrouter_chat, "chat", return_value=("MODEL-SECRET-SPEC", 0.0)) as m:
                r = self.req("admin", "POST", "/api/game-spec", json.dumps(body))
            self.assertEqual(m.call_count, 0, name)
            self.assertNotEqual(r.status, 200, name)
            self._assert_not_served(r, "MODEL-SECRET-SPEC")

    def test_should_not_offer_surprise_ideas_when_the_classifier_is_down(self):
        for name, broken in _broken_classifiers().items():
            safety.configure(broken)
            safety._cache.clear()
            body = {"engine": "chat-deepseek", "kind": "ideas", "template": "maze", "picks": {"hero": f"a sleepy cat {name}"}}
            reply = json.dumps({"ideas": ["MODEL-SECRET-1", "MODEL-SECRET-2", "MODEL-SECRET-3"]})
            with mock.patch.object(openrouter_chat, "chat", return_value=(reply, 0.0)):
                r = self.req("admin", "POST", "/api/game-spec", json.dumps(body))
            self._assert_not_served(r, "MODEL-SECRET")

    def _blocked_with(self, category, text):
        safety.configure(lambda t: json.dumps({"verdict": "block", "category": category}))
        body = {"engine": "chat-deepseek", "messages": [{"role": "user", "content": text}],
                "grade": "g4-6", "ladder": 1, "intent": "ask", "mode": "homework"}
        with mock.patch.object(openrouter_chat, "chat", return_value=("MODEL", 0.0)) as m:
            r = self.req("alice", "POST", "/api/study", json.dumps(body))
        self.assertEqual(m.call_count, 0)
        return r, json.loads(r.body)

    def test_should_answer_unsafe_contact_with_a_care_card_and_no_strike(self):
        before = len(auth.recent_violations(200))
        r, data = self._blocked_with(safety.UNSAFE_CONTACT, "a man online wants to meet me probe uc1")
        self.assertEqual(r.status, 422)
        self.assertTrue(data.get("care"))
        self.assertEqual(data["error"], safety.MSG_UNSAFE_CONTACT)
        self.assertEqual(self.req("alice", "GET", "/api/me").status, 200)
        self.assertGreaterEqual(len(auth.recent_violations(200)), before)

    def test_should_answer_personal_info_with_a_privacy_tip_and_keep_nothing(self):
        r, data = self._blocked_with(safety.PERSONAL_INFO, "my phone number is 0400 000 000 probe pi1")
        self.assertEqual(r.status, 422)
        self.assertNotIn("care", data)
        self.assertEqual(data["error"], safety.MSG_PRIVACY)
        logged = json.dumps(auth.recent_violations(200), default=str)
        self.assertNotIn("0400 000 000", logged)

    def test_should_not_serve_a_model_reply_the_classifier_blocks(self):
        # input passes, but the OUTPUT check says block -> the child sees the gentle fallback, never the model text
        verdicts = iter([ALLOW, '{"verdict":"block","category":"sexual"}'])
        safety.configure(lambda t: next(verdicts, '{"verdict":"block","category":"sexual"}'))
        body = {"engine": "chat-deepseek", "messages": [{"role": "user", "content": "Tell me about octopus arms probe out"}],
                "grade": "g4-6", "ladder": 1, "intent": "ask", "mode": "wonder"}
        with mock.patch.object(openrouter_chat, "chat", return_value=("BLOCKED-MODEL-TEXT", 0.0)):
            r = self.req("admin", "POST", "/api/study", json.dumps(body))
        data = json.loads(r.body)
        self.assertTrue(data.get("filtered"))
        self.assertNotIn("BLOCKED-MODEL-TEXT", r.body if isinstance(r.body, str) else r.body.decode())


class AdminExemptionTests(LiveServerCase):
    """Admins skip ONLY the gentle categories. Sexual / minors / hate / self-harm / checker outages block for everyone."""

    def _handler_for(self, role):
        return types.SimpleNamespace(user={"role": role})

    def test_should_exempt_only_the_gentle_categories_for_admins(self):
        for cat in ("violence", "drugs", "profanity", "other"):
            v = safety.Verdict(False, cat, "ai")
            self.assertTrue(server.Handler._exempt(self._handler_for("admin"), v), cat)
            self.assertFalse(server.Handler._exempt(self._handler_for("user"), v), cat)
        for cat in ("sexual", "sexual_minor", "hate", "self_harm", "personal_info", "unsafe_contact"):
            v = safety.Verdict(False, cat, "ai")
            self.assertFalse(server.Handler._exempt(self._handler_for("admin"), v), cat)

    def test_should_never_exempt_a_checker_outage_even_for_admins(self):
        v = safety.Verdict(False, "other", "error")
        self.assertFalse(server.Handler._exempt(self._handler_for("admin"), v))

    def test_should_not_exempt_when_there_is_no_user_or_role(self):
        v = safety.Verdict(False, "violence", "ai")
        for who in (None, {}, {"role": ""}, {"role": "ADMIN"}, {"role": "administrator"}):
            self.assertFalse(server.Handler._exempt(types.SimpleNamespace(user=who), v), who)

    def _chat(self, who, text):
        body = {"engine": "chat-deepseek", "messages": [{"role": "user", "content": text}]}
        with mock.patch.object(openrouter_chat, "chat", return_value=("a friendly reply", 0.0)):
            return self.req(who, "POST", "/api/chat", json.dumps(body))

    def tearDown(self):
        safety.configure(lambda t: ALLOW)
        safety._cache.clear()

    def test_should_let_admin_through_an_ai_violence_block_but_not_a_normal_user(self):
        safety.configure(lambda t: '{"verdict":"block","category":"violence"}')
        safety._cache.clear()
        self.assertEqual(self._chat("admin", "a cartoon knight battle probe adm1").status, 200)
        self.assertEqual(self._chat("alice", "a cartoon knight battle probe adm1").status, 422)

    def test_should_let_admin_through_the_local_word_list_for_gentle_words_only(self):
        self.assertEqual(self._chat("admin", "a silly dragon massacre of cookies").status, 200)      # violence word
        self.assertEqual(self._chat("alice", "a silly dragon massacre of cookies").status, 422)
        self.assertEqual(self._chat("admin", "show me porn").status, 422)                            # sexual: blocked for admin too

    def test_should_still_block_the_hard_categories_for_admin(self):
        for cat in ("sexual", "sexual_minor", "hate", "self_harm"):
            safety.configure(lambda t, c=cat: json.dumps({"verdict": "block", "category": c}))
            safety._cache.clear()
            self.assertEqual(self._chat("admin", f"an innocent looking line probe {cat}").status, 422, cat)

    def test_should_still_block_everything_for_admin_when_the_classifier_is_down(self):
        safety.configure(None)
        safety._cache.clear()
        self.assertEqual(self._chat("admin", "a harmless question probe down1").status, 422)

    def test_should_not_log_a_strike_for_an_exempt_admin_block(self):
        before = len(auth.recent_violations(500))
        safety.configure(lambda t: '{"verdict":"block","category":"violence"}')
        safety._cache.clear()
        self._chat("admin", "another cartoon fight probe adm2")
        self.assertEqual(len(auth.recent_violations(500)), before)


if __name__ == "__main__":
    unittest.main()
