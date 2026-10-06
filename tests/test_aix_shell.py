"""AI Explorers wiring and security: script load order, sidebar/mode hookup, banned APIs, stub/game files present."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
HTML = (UI / "VideoGen.html").read_text()
CHAT = (UI / "vg-views-chat.jsx").read_text()
GAMES = ["sorter", "sabotage", "fib"]
NEW_PLAIN = ["vg-aix-engine.js", "vg-aix-study-logic.js", "vg-aix-studio-logic.js"]
NEW_JSX = ["vg-aix-game.jsx", "vg-aix-study.jsx", "vg-aix-studio.jsx"]
MANIFEST = UI / "manifest.webmanifest"
# the only network calls an aix file may make (always through the shared vgPost helper)
ALLOWED_POSTS = {"/api/study", "/api/game-spec"}
# free-text boxes are the whole point of these two studios; every other aix file stays text-input free
TEXT_OK = ("vg-aix-study", "vg-aix-studio")
AIX_FILES = sorted(UI.glob("vg-aix-*"))

# Each pattern is a way to inject markup, run strings as code, phone home, or take free text.
BANNED = {
    "innerHTML": r"innerHTML", "dangerouslySetInnerHTML": r"dangerouslySetInnerHTML", "eval": r"\beval\s*\(",
    "new Function": r"new\s+Function\b", "document.write": r"document\s*\.\s*write", "fetch": r"\bfetch\s*\(",
    "XMLHttpRequest": r"XMLHttpRequest", "WebSocket": r"WebSocket", "sendBeacon": r"sendBeacon",
    "text input": r"""type\s*=\s*["']text["']""", "textarea": r"<textarea", "contentEditable": r"contentEditable",
}


class WiringTests(unittest.TestCase):
    def test_should_load_aix_scripts_in_spec_order_after_prompt_lab(self):
        srcs = re.findall(r'<script[^>]*src="/ui/([^"?]+)\?v=\d+"', HTML)
        want = ["vg-views-lab.jsx", "vg-aix-core.js"] + [f"vg-aix-{g}.js" for g in GAMES] + \
               ["vg-aix-shell.jsx"] + [f"vg-aix-{g}.jsx" for g in GAMES] + NEW_PLAIN + NEW_JSX + ["vg-views-chat.jsx"]
        start = srcs.index("vg-views-lab.jsx")
        self.assertEqual(srcs[start:start + len(want)], want)

    def test_should_use_babel_only_for_jsx_files_and_cache_bust_every_aix_script(self):
        for tag in re.findall(r'<script[^>]*vg-aix-[^>]*>', HTML):
            self.assertIn("?v=", tag)
            self.assertEqual('type="text/babel"' in tag, ".jsx?" in tag, tag)

    def test_should_allow_aix_mode_and_mount_the_pane(self):
        self.assertRegex(CHAT, r"\[[^\]]*'lab', 'aix'[^\]]*\]\.includes\(m\)")
        self.assertIn("mode === 'aix' && <AIExplorersPane key={viewKey} theme={theme} menuVisible={!open || narrow} />", CHAT)

    def test_should_have_a_sidebar_button_labelled_ai_explorers(self):
        self.assertRegex(CHAT, r"modeBtn\('aix', '(\w+)', 'AI Explorers'\)")
        icon = re.search(r"modeBtn\('aix', '([\w-]+)'", CHAT).group(1)
        self.assertIn(f"case '{icon}'", (UI / "vg-icons.jsx").read_text(), "sidebar icon must exist in vg-icons.jsx")

    def test_should_have_every_core_game_and_shell_file(self):
        names = {p.name for p in AIX_FILES}
        for f in ["vg-aix-core.js", "vg-aix-shell.jsx"] + NEW_PLAIN + NEW_JSX + [f"vg-aix-{g}.{e}" for g in GAMES for e in ("js", "jsx")]:
            self.assertIn(f, names)

    def test_should_register_each_game_under_its_lesson_id(self):
        for g in GAMES:
            self.assertRegex((UI / f"vg-aix-{g}.jsx").read_text(), rf"window\.AIX_GAMES\.{g}\s*=")

    def test_should_export_shell_components_to_window(self):
        src = (UI / "vg-aix-shell.jsx").read_text()
        exports = re.search(r"Object\.assign\(window,\s*\{([^}]*)\}", src).group(1)
        for name in ["AIExplorersPane", "AixBolt", "AixConfetti", "AixFrame"]:
            self.assertIn(name, exports)
        self.assertIn("window.aixSfx = aixSfx", src)


class SecurityTests(unittest.TestCase):
    def test_should_find_aix_files_to_scan(self):
        self.assertGreaterEqual(len(AIX_FILES), 8)

    def test_should_not_use_banned_apis_in_any_aix_file(self):
        for path in AIX_FILES:
            text = path.read_text()
            for label, pat in BANNED.items():
                if label in ("text input", "textarea") and path.name.startswith(TEXT_OK):
                    continue
                self.assertIsNone(re.search(pat, text), f"{path.name} uses banned {label}")

    def test_should_make_only_the_two_allowed_vgpost_network_calls(self):
        for path in AIX_FILES:
            text = path.read_text()
            for m in re.finditer(r"\bvgPost\s*\(\s*([^,)]*)", text):
                arg = m.group(1).strip()
                lit = re.fullmatch(r"""['"]([^'"]+)['"]""", arg)
                self.assertTrue(lit and lit.group(1) in ALLOWED_POSTS, f"{path.name}: vgPost({arg}) is not an allowed call")
            for pat in (r"\bfetch\b", r"\.send\s*\(", r"new\s+EventSource", r"importScripts", r"\.open\s*\(\s*['\"](?:GET|POST)"):
                self.assertIsNone(re.search(pat, text), f"{path.name} matches network pattern {pat}")

    def test_should_not_load_remote_resources_from_aix_files(self):
        for path in AIX_FILES:
            self.assertIsNone(re.search(r"""(?:src|href)\s*=\s*\{?\s*['"]https?://""", path.read_text().replace('rel="noopener noreferrer"', "")) if path.name != "vg-aix-shell.jsx" else None, path.name)

    def test_should_open_outbound_links_only_through_safe_link_with_noopener(self):
        src = (UI / "vg-aix-shell.jsx").read_text()
        self.assertIn("safeLink(", src)
        self.assertIn('rel="noopener noreferrer"', src)
        for path in AIX_FILES:
            for tag in re.findall(r"<a\s[^>]*>", path.read_text()):
                self.assertIn("noopener noreferrer", tag, path.name)

    def test_should_build_styles_with_text_content_not_markup(self):
        src = (UI / "vg-aix-shell.jsx").read_text()
        self.assertIn("createElement('style')", src)
        self.assertIn("el.textContent = css", src)

    def test_should_respect_reduced_motion(self):
        src = (UI / "vg-aix-shell.jsx").read_text()
        self.assertIn("prefers-reduced-motion", src)
        self.assertIn("useAixReduced", src)


class PwaTests(unittest.TestCase):
    def test_should_ship_a_valid_manifest_with_both_icons(self):
        m = json.loads(MANIFEST.read_text())
        self.assertEqual(m["name"], "SparkGarden")
        self.assertEqual(m["start_url"], "/")
        self.assertEqual(m["display"], "standalone")
        self.assertEqual({i["src"] for i in m["icons"]}, {"/ui/icon-192.png", "/ui/icon-512.png"})
        self.assertRegex(m["theme_color"], r"^#[0-9a-fA-F]{6}$")

    def test_should_link_manifest_and_mobile_meta_in_head(self):
        head = HTML.split("</head>")[0]
        self.assertIn('rel="manifest" href="/ui/manifest.webmanifest"', head)
        self.assertRegex(head, r'name="theme-color" content="#[0-9a-fA-F]{6}"')
        self.assertIn('name="apple-mobile-web-app-capable" content="yes"', head)
        self.assertRegex(head, r'rel="apple-touch-icon" href="/ui/icon-192\.png"')
        self.assertRegex(head, r'name="viewport" content="[^"]*width=device-width[^"]*initial-scale=1[^"]*viewport-fit=cover')


class ShellStudioTests(unittest.TestCase):
    SHELL = (UI / "vg-aix-shell.jsx").read_text()

    def test_should_open_each_studio_with_the_agreed_props(self):
        self.assertIn("window.AIX_STUDIOS", self.SHELL)
        for prop in ("theme={theme}", "onExit={toMap}", "onAward={onStudioAward}", "onExplore={onStudioExplore}"):
            self.assertIn(prop, self.SHELL)

    def test_should_fall_back_when_a_studio_component_is_missing(self):
        self.assertRegex(self.SHELL, r"typeof Studio === 'function' && studio \?")
        self.assertIn("<AixFallback onExit={toMap} />", self.SHELL)

    def test_should_render_a_card_for_every_studio_above_the_stations(self):
        self.assertIn("C.STUDIOS.map", self.SHELL)
        self.assertLess(self.SHELL.index("C.STUDIOS.map"), self.SHELL.index("C.CATALOG.map(("))

    def test_should_stack_to_one_column_on_phones_and_keep_44px_taps(self):
        self.assertIn("max-width:639px", self.SHELL)
        self.assertIn(".aix-btn{min-height:44px}", self.SHELL)
        self.assertIn("safe-area-inset-bottom", self.SHELL)

    def test_should_only_apply_hover_movement_on_hover_devices(self):
        self.assertIn("@media (hover:hover){.aix-btn:hover", self.SHELL)
        self.assertNotRegex(self.SHELL, r"'\.aix-btn:hover:not\(:disabled\)\{transform")

    def test_should_persist_explored_progress_through_core_only(self):
        self.assertIn("C.explore(p, key, value)", self.SHELL)
        self.assertIn("C.award(p, studioId, 0)", self.SHELL)


if __name__ == "__main__":
    unittest.main()
