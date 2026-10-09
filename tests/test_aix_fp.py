"""Block Builder Explore 3D (first-person view): wiring, vendored three.js integrity, cleanup, fallbacks, touch targets, chips.
These are static checks (no browser): the renderer itself is verified by hand in a real browser."""
import base64
import hashlib
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
HTML = (UI / "VideoGen.html").read_text()
FP = (UI / "vg-aix-fp.jsx").read_text()
BLOCKS = (UI / "vg-aix-blocks.jsx").read_text()
THREE_SHA384 = "CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu"
NODE = shutil.which("node")
SRCS = re.findall(r'<script[^>]*src="/ui/([^"?]+)\?v=(\d+)"', HTML)
ORDER = [s for s, _ in SRCS]
VERSION = dict(SRCS)
# every AIXVoxel member the renderer may call (the pure module's published contract)
VOXEL_API = {"WX", "WY", "WZ", "PLOT", "CHUNK", "BLOCKS", "ID", "TILES", "PLACEABLE", "generate", "get", "plotToBuild", "spawn", "physics",
             "raycast", "place", "breakBlock", "critters", "stepCritters", "gems", "collect", "timeOfDay", "buildChunkGeometry"}


class VendoredThreeTests(unittest.TestCase):
    def test_should_ship_three_js_unmodified(self):
        digest = base64.b64encode(hashlib.sha384((UI / "vendor" / "three.min.js").read_bytes()).digest()).decode()
        self.assertEqual(digest, THREE_SHA384)

    def test_should_load_three_as_a_plain_local_script_before_every_aix_file(self):
        self.assertIn('<script src="/ui/vendor/three.min.js?v=1"></script>', HTML)
        self.assertLess(ORDER.index("vendor/three.min.js"), ORDER.index("vg-aix-core.js"))
        self.assertNotRegex(HTML, r"<script[^>]*three[^>]*src=\"https?:")


class WiringTests(unittest.TestCase):
    def test_should_load_voxel_after_blocks_engine_and_fp_after_blocks_player(self):
        self.assertEqual(ORDER.index("vg-aix-voxel.js"), ORDER.index("vg-aix-blocks.js") + 1)
        self.assertEqual(ORDER.index("vg-aix-fp.jsx"), ORDER.index("vg-aix-blocks.jsx") + 1)
        self.assertIn('<script src="/ui/vg-aix-voxel.js?v=1"></script>', HTML)
        self.assertIn('<script type="text/babel" src="/ui/vg-aix-fp.jsx?v=1"></script>', HTML)

    def test_should_bump_changed_phase_one_files_to_v2_so_browsers_drop_stale_code(self):
        for f in ("vg-aix-engine.js", "vg-aix-blocks.js", "vg-aix-blocks.jsx", "vg-aix-game.jsx", "vg-aix-studio.jsx", "vg-aix-studio-logic.js"):
            self.assertEqual(VERSION[f], "2", f)

    def test_should_export_the_explore_view_and_mount_it_from_the_blocks_player(self):
        self.assertIn("window.AIX_FP = { ExploreView: ExploreView }", FP)
        self.assertIn("Explore 3D", BLOCKS)
        self.assertRegex(BLOCKS, r"window\.AIX_FP[\s\S]{0,80}ExploreView")
        self.assertIn("onPlotChange=", BLOCKS)
        self.assertIn("leaveExplore", BLOCKS)

    def test_should_keep_the_blocks_keyboard_handler_out_of_the_way_while_exploring(self):
        self.assertRegex(BLOCKS, r"rr\.mode === 'explore'\) return")

    def test_should_only_call_the_voxel_api_the_contract_publishes(self):
        used = set(re.findall(r"\bV\.(\w+)", FP))
        self.assertLessEqual(used, VOXEL_API, used - VOXEL_API)


class SafetyTests(unittest.TestCase):
    def test_should_not_use_markup_injection_or_code_execution(self):
        for pat in (r"innerHTML", r"dangerouslySetInnerHTML", r"\beval\s*\(", r"new\s+Function\b", r"document\s*\.\s*write", r"\bfetch\s*\(", r"XMLHttpRequest", r"WebSocket", r"localStorage", r"sessionStorage"):
            self.assertIsNone(re.search(pat, FP), pat)

    def test_should_never_use_the_forbidden_product_name(self):
        for name in ("vg-aix-fp.jsx", "vg-aix-voxel.js", "vg-aix-blocks.jsx", "vg-aix-studio-logic.js"):
            self.assertIsNone(re.search(r"minecraft|mojang", (UI / name).read_text(), re.I), name)

    def test_should_only_turn_spec_colours_into_numbers_after_a_hex_check(self):
        self.assertRegex(FP, r"HEX = /\^#\[0-9a-fA-F\]\{6\}\$/")
        self.assertIn("hexNum(spec && spec.items && spec.items.good && spec.items.good.color", FP)

    def test_should_not_load_remote_resources(self):
        self.assertIsNone(re.search(r"https?://", FP))


class CleanupTests(unittest.TestCase):
    def test_should_dispose_everything_it_creates_when_unmounted(self):
        for needle in ("renderer.dispose()", "forceContextLoss", ".geometry.dispose()", "own.geoms.forEach", "own.mats.forEach", "own.texs.forEach", "handGeo.dispose()"):
            self.assertIn(needle, FP)

    def test_should_remove_every_listener_and_stop_every_timer(self):
        for needle in ("removeEventListener", "cancelAnimationFrame", "clearTimeout(saveTimer)", "clearTimeout(savedTimer)", "clearTimeout(noteTimer)", "ro.disconnect()"):
            self.assertIn(needle, FP)
        self.assertNotRegex(FP, r"\b(?:window|document|canvas)\.addEventListener")

    def test_should_pause_when_the_tab_is_hidden(self):
        self.assertIn("visibilitychange", FP)
        self.assertRegex(FP, r"document\.hidden")

    def test_should_save_the_last_edit_on_unmount_and_on_back(self):
        self.assertRegex(FP, r"saveTimer = 0; flushSave\(\)")
        self.assertIn("flushNow", FP)
        self.assertIn("const exit = ", FP)


class FallbackTests(unittest.TestCase):
    def test_should_show_a_friendly_card_and_back_button_when_webgl_or_three_is_missing(self):
        self.assertRegex(FP, r"const missing = !THREE \|\| !V \|\| !Bk")
        self.assertIn("function Fallback(", FP)
        self.assertIn("setFail('webgl')", FP)
        self.assertIn("webglcontextlost", FP)
        self.assertIn("Back to the flat view", FP)

    def test_should_fall_back_to_drag_to_look_when_pointer_lock_is_refused(self):
        for needle in ("requestPointerLock", "pointerlockchange", "pointerlockerror", "exitPointerLock", "c.noLock = true"):
            self.assertIn(needle, FP)

    def test_should_cap_pixel_ratio_and_rebuild_at_most_two_chunks_per_frame(self):
        self.assertIn("Math.min(window.devicePixelRatio || 1, 2)", FP)
        self.assertRegex(FP, r"CHUNKS_PER_FRAME = 2\b")

    def test_should_respect_reduced_motion(self):
        self.assertIn("prefers-reduced-motion", FP)
        self.assertRegex(FP, r"motion && Math\.sin\(bob\)|moving && motion")


class TouchTests(unittest.TestCase):
    def test_should_keep_touch_targets_at_least_44px(self):
        m = re.search(r"const TAP = (\d+)\b", FP)
        self.assertGreaterEqual(int(m.group(1)), 44)
        self.assertIn("minWidth: TAP, minHeight: TAP", FP)
        self.assertIn("width: TAP, height: TAP", FP)           # hotbar slots
        for size in re.findall(r'<HoldButton[^>]*size=\{?(\w+)\}?', FP):
            self.assertTrue(size == "TAP" or int(size) >= 44, size)

    def test_should_offer_joystick_look_drag_and_the_four_big_buttons(self):
        for needle in ('label="Jump"', 'label="Break the block"', 'label="Place a block"', 'label="Next block"', "stickDown", "lookDown", "touchAction: 'none'"):
            self.assertIn(needle, FP)

    def test_should_have_keyboard_controls_for_every_action(self):
        for needle in ("'f'", "'g'", "'e'", "'q'", "' '", "'shift'", "'1'"):
            self.assertIn(needle, FP)


@unittest.skipUnless(NODE, "node not installed")
class StudioChipTests(unittest.TestCase):
    def run_js(self, expr):
        code = f"const L=require({json.dumps(str(UI / 'vg-aix-studio-logic.js'))});console.log(JSON.stringify({expr}))"
        return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)

    def test_should_offer_the_four_blocks_world_chips_with_valid_tweak_text(self):
        chips = self.run_js("L.BLOCK_TWEAK_CHIPS")
        self.assertEqual([c["label"] for c in chips], ["Add a castle", "Make it a desert", "Add a pond", "Snowy mountains"])
        for c in chips:
            text = self.run_js(f"L.tweakText('blocks',{json.dumps(c['id'])})")
            self.assertTrue(3 <= len(text) <= 200, c["id"])
        self.assertIsNone(self.run_js("L.tweakText('blocks','nope')"))

    def test_should_show_the_chips_only_for_blocks_worlds(self):
        jsx = (UI / "vg-aix-studio.jsx").read_text()
        self.assertRegex(jsx, r"spec\.template === 'blocks' \? L\.TWEAK_CHIPS\.concat\(L\.BLOCK_TWEAK_CHIPS\) : L\.TWEAK_CHIPS")


if __name__ == "__main__":
    unittest.main()
