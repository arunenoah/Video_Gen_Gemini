"""Public parents page (/parents): reachable without sign-in, no scripts, and every factual claim is tied to the code."""
import html as htmllib
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth      # noqa: E402
import safety    # noqa: E402
import server    # noqa: E402
from harness import LiveServerCase   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TEXT = (ROOT / "ui" / "parents.html").read_text(encoding="utf-8")


def plain(page: str) -> str:
    return htmllib.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page)))


class ParentsHttpTests(LiveServerCase):
    def test_should_serve_the_page_without_signing_in(self):
        r = self._raw("GET", "/parents")
        self.assertEqual(r.status, 200)
        self.assertIn("text/html", r.getheader("Content-Type"))
        self.assertEqual(self._raw("GET", "/parents/").status, 200)
        body = r.body.decode()
        self.assertIn("For Parents: Learning &amp; Safety", body)
        self.assertNotIn("{{", body)                                   # every marker was filled in

    def test_should_make_the_parents_page_the_landing_page_for_visitors(self):
        r = self._raw("GET", "/")
        self.assertEqual(r.status, 200)                                # no redirect to /login any more
        self.assertIn("Curiosity grows here.", r.body.decode())
        self.assertIn('href="/login"', r.body.decode())                # the way in is the Sign in button
        self.assertEqual(self._raw("GET", "/?x=1").status, 200)

    def test_should_still_open_the_app_at_root_for_signed_in_users(self):
        body = self.req("alice", "GET", "/").body.decode()
        self.assertNotIn("Curiosity grows here.", body)
        self.assertIn("VG_USER", body)

    def test_should_keep_everything_else_behind_sign_in(self):
        for path in ("/classic", "/admin", "/api/me", "/api/list", "/api/examples", "/generations/x/y"):
            r = self._raw("GET", path)
            self.assertEqual((r.status, r.getheader("Location")), (302, "/login"), path)

    def test_should_ship_no_scripts_and_a_locked_down_csp(self):
        r = self._raw("GET", "/parents")
        self.assertNotIn("<script", r.body.decode().lower())
        self.assertIn("default-src 'none'", r.getheader("Content-Security-Policy"))
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")

    def test_should_serve_only_the_allow_listed_pictures_publicly(self):
        for path, (name, ctype) in server.PUBLIC_UI_FILES.items():
            r = self._raw("GET", path)
            self.assertEqual((r.status, r.getheader("Content-Type")), (200, ctype), path)
            self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        for path in ("/ui/vg-core.jsx", "/ui/parents.html", "/ui/logo.png", "/ui/parents-lab.jpg/../../server.py",
                     "/ui/parents-lab.jpg/%2e%2e/server.py"):
            r = self._raw("GET", path)
            self.assertIn(r.status, (302, 404), path)                  # still behind sign-in / not found
            self.assertNotIn(b"import", r.body[:200] if r.status == 200 else b"")

    def test_should_only_reference_public_pictures_on_the_page(self):
        for src in re.findall(r'src="(/ui/[^"]+)"', TEXT):
            self.assertIn(src, server.PUBLIC_UI_FILES, src)            # a private path here would show a broken picture

    def test_should_link_from_the_sign_in_pages_and_back(self):
        for path in ("/login", "/login/2fa"):
            self.assertIn('href="/parents"', self._raw("GET", path).body.decode(), path)
        self.assertIn("For Parents: Learning &amp; Safety", self._raw("GET", "/login").body.decode())
        self.assertIn('href="/login"', self._raw("GET", "/parents").body.decode())

    def test_should_reject_unknown_hosts_like_every_other_page(self):
        self.assertEqual(self._raw("GET", "/parents", host="evil.example").status, 403)


class ParentsStructureTests(unittest.TestCase):
    def test_should_have_a_target_for_every_in_page_link(self):
        ids = set(re.findall(r'\sid="([^"]+)"', TEXT))
        for href in set(re.findall(r'href="#([^"]+)"', TEXT)):
            self.assertIn(href, ids, f"#{href} has no section")

    def test_should_answer_the_five_questions_and_state_the_limits(self):
        for q in ("What will my child learn?", "What can my child do?", "How do you prevent misuse?",
                  "What can I control?", "What happens to my child's information?"):
            self.assertIn(htmllib.escape(q, quote=False), TEXT, q)
        text = plain(TEXT)
        self.assertIn("AI can make mistakes", text)
        self.assertIn("safety checks can miss things", text.lower())
        self.assertIn("grown-up nearby", text)

    def test_should_not_claim_things_that_do_not_exist(self):
        text = plain(TEXT).lower()
        for banned in ("100% safe", "guarantee", "completely safe", "parent dashboard", "weekly report", "gdpr", "coppa"):
            self.assertNotIn(banned, text)


class ParentsClaimsMatchCodeTests(unittest.TestCase):
    """Each assertion pins a sentence on the page to the code that makes it true."""

    def page(self):
        return plain(server.render_parents())

    def test_should_state_the_real_strike_limit(self):
        self.assertIn(f"After {auth.STRIKE_LIMIT} blocked requests within 24 hours", self.page())
        self.assertEqual(auth.STRIKE_WINDOW, 24 * 3600)

    def test_should_state_zero_tolerance_and_self_harm_handling(self):
        self.assertEqual(safety.ZERO_TOLERANCE, {safety.SEXUAL_MINOR})
        self.assertIn("first block", self.page())
        self.assertIn("not penalised", self.page())

    def test_should_state_the_blocked_message_the_child_really_sees(self):
        self.assertIn(safety.MSG_BLOCKED, TEXT)

    def test_should_list_only_categories_the_checker_has(self):
        for cat in ("sexual", "violence", "self_harm", "drugs", "hate", "profanity"):
            self.assertIn(cat, safety.CATEGORIES)
        low = self.page().lower()
        for word in ("sexual content", "graphic violence", "self-harm", "illegal drugs", "hate", "bad language"):
            self.assertIn(word, low)

    def test_should_say_the_review_list_keeps_80_characters(self):
        self.assertIn("first 80 characters", self.page())
        self.assertLessEqual(len(self._excerpt("x" * 300)), 80)

    @staticmethod
    def _excerpt(text):
        import tempfile
        from pathlib import Path as P
        with mock.patch.object(auth, "DB_PATH", P(tempfile.mkdtemp()) / "t.db"):
            auth.init_db()
            auth.create_user("kid", "user")
            uid = [u for u in auth.list_users() if u["username"] == "kid"][0]["id"]
            auth.record_violation({"id": uid, "role": "user"}, "other", "chat", text, strike=False)
            return auth.recent_violations(1)[0]["excerpt"]

    def test_should_describe_outside_services_without_company_or_model_names(self):
        providers = {spec["provider"] for spec in server.ENGINES.values()}
        self.assertEqual(providers, {"veo", "openrouter", "ark"})      # new kind of outside service → review the wording below
        page = self.page()
        for phrase in ("outside AI service", "browser's own speech service", "open-source code libraries"):
            self.assertIn(phrase, page)
        for name in ("OpenRouter", "Anthropic", "Claude", "BytePlus", "Seedance", "DeepSeek", "MiniMax", "Veo", "Grok", "unpkg"):
            self.assertNotIn(name, page, name)                         # names confuse parents; the claim stays generic
        self.assertIn("unpkg.com", (ROOT / "ui" / "VideoGen.html").read_text())   # "public hosting service" is true

    def test_should_match_retention_to_the_live_setting(self):
        with mock.patch.object(server, "VIDEO_RETENTION_HOURS", 48.0):
            self.assertIn("Deleted automatically 48 hours after they are made", self.page())
        with mock.patch.object(server, "VIDEO_RETENTION_HOURS", 0.0):
            self.assertNotIn("Deleted automatically", self.page())
            self.assertIn("Kept until deleted", self.page())
        self.assertEqual(server.VIDEO_KINDS, {"clip", "story", "stitch"})   # pictures and scripts are never expired
        with mock.patch.object(server, "VIDEO_RETENTION_HOURS", 48.0):
            self.assertIn("together with the words used for each scene", self.page())
        self.assertIn("Stories the helper writes for a child", self.page())      # scripts are kept, so the page must say so

    def test_should_match_clip_length_text_to_the_live_setting(self):
        with mock.patch.object(server, "USER_DURATIONS", (5, 10)):
            self.assertIn("clips of 5 or 10 seconds", self.page())
        with mock.patch.object(server, "USER_DURATIONS", ()):
            self.assertNotIn("5 or 10", self.page())

    def test_should_only_list_parent_controls_the_admin_screen_has(self):
        admin = (ROOT / "auth.py").read_text()
        for label in ("Add credits", "Daily spend limit", "Daily screen time", "Extra time for today only",
                      "Allowed engines", "Reset 2FA + password", "Recent blocked inputs", "Usage by type"):
            self.assertIn(label, admin, label)
        self.assertIn("(disable|enable|reset|credits|limits)", (ROOT / "server.py").read_text())   # no account-delete action, as the page says

    def test_should_match_the_upload_limit_and_chat_storage_claims(self):
        chat = (ROOT / "ui" / "vg-views-chat.jsx").read_text()
        self.assertIn("VG_MAX_UPLOAD = 2 * 1024 * 1024", chat)
        self.assertIn("smaller than 2 MB", TEXT)
        self.assertIn("lives in this browser only", chat)             # chat history is local, as the page says

    def test_should_keep_the_uploaded_drawing_only_with_its_picture(self):
        src = (ROOT / "server.py").read_text()
        self.assertIn('"ref01.jpg"', src)                             # drawing saved next to its result…
        self.assertIn("shutil.rmtree(target)", src)                   # …and removed with it when the child deletes it

    def test_should_not_have_analytics_or_ads(self):
        for f in (ROOT / "ui").glob("*.jsx"):
            self.assertNotRegex(f.read_text().lower(), r"googletagmanager|gtag\(|google-analytics|sentry\.io|mixpanel|segment\.com", f.name)


if __name__ == "__main__":
    unittest.main()
