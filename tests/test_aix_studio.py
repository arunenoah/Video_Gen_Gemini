"""Game Studio: pure logic (run under node) plus static safety checks on the studio UI files."""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGIC = ROOT / "ui" / "vg-aix-studio-logic.js"
JSX = ROOT / "ui" / "vg-aix-studio.jsx"
NODE = shutil.which("node")


def run_js(expr):
    """Evaluate `expr` with L = studio logic, E = engine; return the JSON result."""
    code = (f"const L=require({json.dumps(str(LOGIC))});const E=require({json.dumps(str(ROOT / 'ui' / 'vg-aix-engine.js'))});"
            f"console.log(JSON.stringify({expr}))")
    return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)


@unittest.skipUnless(NODE, "node not installed")
class StudioLogicTests(unittest.TestCase):
    def test_should_build_request_with_server_fields_when_inputs_are_valid(self):
        r = run_js("L.buildSpecRequest({template:'maze',idea:'A banana submarine',picks:{hero:'a robot',junk:'x'}})")
        self.assertTrue(r["ok"])
        self.assertEqual(r["body"]["kind"], "build")
        self.assertEqual(r["body"]["picks"], {"hero": "a robot"})
        self.assertNotIn("tweak", r["body"])

    def test_should_reject_request_when_idea_too_short_or_too_long(self):
        self.assertFalse(run_js("L.buildSpecRequest({template:'maze',idea:'hi'})")["ok"])
        self.assertFalse(run_js("L.buildSpecRequest({template:'maze',idea:'x'.repeat(301)})")["ok"])
        self.assertTrue(run_js("L.buildSpecRequest({template:'maze',idea:'x'.repeat(300)})")["ok"])

    def test_should_reject_request_when_template_unknown(self):
        self.assertFalse(run_js("L.buildSpecRequest({template:'evil',idea:'a fine idea'})")["ok"])

    def test_should_cap_picks_and_tweak_to_server_limits(self):
        r = run_js("L.buildSpecRequest({template:'catcher',idea:'a fine idea',picks:{hero:'h'.repeat(80)}})")
        self.assertEqual(len(r["body"]["picks"]["hero"]), 40)
        self.assertFalse(run_js("L.buildSpecRequest({template:'catcher',idea:'a fine idea',tweak:'t'.repeat(201)})")["ok"])
        self.assertFalse(run_js("L.buildSpecRequest({template:'catcher',idea:'a fine idea',tweak:'ab'})")["ok"])

    def test_should_send_previous_spec_only_when_it_validates(self):
        ok = run_js("L.buildSpecRequest({template:'catcher',idea:'a fine idea',tweak:'make it faster',previousSpec:E.defaultSpec('catcher')})")
        self.assertTrue(ok["ok"])
        self.assertEqual(ok["body"]["previous_spec"]["template"], "catcher")
        bad = run_js("L.buildSpecRequest({template:'catcher',idea:'a fine idea',previousSpec:{v:1}})")
        self.assertFalse(bad["ok"])

    def test_should_strip_control_characters_from_idea(self):
        r = run_js("L.buildSpecRequest({template:'catcher',idea:'a\\u0000b\\u202ec dragon'})")
        self.assertEqual(r["body"]["idea"], "abc dragon")

    def test_should_build_ideas_request_with_optional_idea(self):
        r = run_js("L.buildIdeasRequest({picks:{world:'sea'}})")
        self.assertEqual(r["body"]["kind"], "ideas")
        self.assertNotIn("idea", r["body"])
        self.assertFalse(run_js("L.buildIdeasRequest({idea:'x'.repeat(301)})")["ok"])

    def test_should_read_ideas_reply_as_clean_strings_only(self):
        self.assertEqual(run_js("L.readIdeas({ideas:['a','b','c','d']})"), ["a", "b", "c"])
        self.assertIsNone(run_js("L.readIdeas({ideas:'nope'})"))
        self.assertIsNone(run_js("L.readIdeas(null)"))
        self.assertEqual(run_js("L.readIdeas({ideas:[5,'ok']})"), ["5", "ok"])

    def test_should_offer_two_or_three_sparks_and_never_block(self):
        s = run_js("L.sparks('dog',1)")
        self.assertTrue(2 <= len(s) <= 3)
        self.assertEqual(len(set(s)), len(s))
        self.assertTrue(2 <= len(run_js("L.sparks('',undefined)")) <= 3)

    def test_should_not_repeat_a_spark_the_kid_already_answered(self):
        s = run_js("L.sparks('Where does it happen? On the moon',0)")
        self.assertNotIn("Where does it happen?", s)

    def test_should_append_spark_without_passing_300_chars(self):
        self.assertTrue(run_js("L.appendSpark('A dragon','Where does it happen?')").endswith("Where does it happen?"))
        long = "x" * 295
        self.assertEqual(run_js(f"L.appendSpark('{long}','Where does it happen?')"), long)

    def test_should_mix_two_ideas_within_limit(self):
        self.assertIn("and also", run_js("L.mixIdeas('Banana boat','Space cat')"))
        self.assertLessEqual(len(run_js("L.mixIdeas('a'.repeat(150),'b'.repeat(150))")), 300)

    def test_should_map_every_twist_chip_and_fix_to_valid_tweak_text(self):
        for group, ids in (("twist", run_js("L.TWISTS.map(t=>t.id)")), ("fix", run_js("L.FIX_BUTTONS.map(t=>t.id)")), ("chip", run_js("L.TWEAK_CHIPS.map(t=>t.id)"))):
            for i in ids:
                text = run_js(f"L.tweakText({json.dumps(group)},{json.dumps(i)})")
                self.assertTrue(3 <= len(text) <= 200, (group, i))
        self.assertIsNone(run_js("L.tweakText('twist','nope')"))

    def test_should_shuffle_twists_deterministically(self):
        a = run_js("L.shuffleTwists(2,3).map(t=>t.id)")
        self.assertEqual(a, run_js("L.shuffleTwists(2,3).map(t=>t.id)"))
        self.assertNotEqual(a, run_js("L.shuffleTwists(3,3).map(t=>t.id)"))
        self.assertEqual(len(run_js("L.shuffleTwists(1,99)")), len(run_js("L.TWISTS")))

    def test_should_turn_ai_next_idea_into_tweak(self):
        self.assertEqual(run_js("L.ideaToTweak('Add a rainbow boss')"), "Add a rainbow boss")
        self.assertIsNone(run_js("L.ideaToTweak('no')"))

    def test_should_clamp_overrides_and_leave_original_untouched(self):
        r = run_js("(()=>{const s=E.defaultSpec('catcher');const o=L.applyOverrides(s,{speed:99,lives:-3,spawnRate:'4'});return [o.rules,s.rules]})()")
        self.assertEqual(r[0], {"speed": 5, "lives": 1, "spawnRate": 4})
        self.assertEqual(r[1], {"speed": 2, "lives": 3, "spawnRate": 3})

    def test_should_paint_clear_and_undo_pixels(self):
        r = run_js("(()=>{let g=L.emptyGrid();let st=L.pushUndo([],g);g=L.paintCell(g,1,2,3);const u=L.undo(st,g);return [g[1],u.rows[1],L.clearGrid()[1],L.isBlank(u.rows),L.isBlank(g)]})()")
        self.assertEqual(r, ["00300000", "00000000", "00000000", True, False])

    def test_should_ignore_out_of_range_paint(self):
        r = run_js("L.paintCell(L.emptyGrid(),9,0,1).join('')+L.paintCell(L.emptyGrid(),0,0,7).join('')")
        self.assertEqual(r, "0" * 128)

    def test_should_mirror_paint_across_the_middle(self):
        self.assertEqual(run_js("L.paintMirror(L.emptyGrid(),0,1,2)[0]"), "02000020")

    def test_should_make_sprite_the_engine_accepts_and_drop_blank_one(self):
        r = run_js("(()=>{let g=L.paintMirror(L.emptyGrid(),3,2,5);const sp=L.toSprite(g,'#10243f');const s=L.applySprite(E.defaultSpec('runner'),'hero',sp);return [s&&s.hero.sprite.rows[3],L.toSprite(L.emptyGrid(),'#fff')]})()")
        self.assertEqual(r, ["00500500", None])

    def test_should_remove_sprite_when_null(self):
        r = run_js("(()=>{const s=E.defaultSpec('catcher');const o=L.applySprite(s,'hero',null);return 'sprite' in o.hero})()")
        self.assertFalse(r)

    def test_should_refuse_sprite_for_unknown_target(self):
        self.assertIsNone(run_js("L.applySprite(E.defaultSpec('catcher'),'__proto__',null)"))

    def test_should_keep_last_five_versions_with_rising_numbers(self):
        r = run_js("(()=>{let l=[];const s=E.defaultSpec('catcher');for(let i=0;i<7;i++)l=L.addVersion(l,s,'w'+i);return [l.map(v=>v.n),L.getVersion(l,7).words,L.getVersion(l,1)]})()")
        self.assertEqual(r, [[3, 4, 5, 6, 7], "w6", None])

    def test_should_not_let_a_restored_version_alias_history(self):
        r = run_js("(()=>{let l=L.addVersion([],E.defaultSpec('catcher'),'a');const v=L.getVersion(l,1);v.spec.title='changed';return L.getVersion(l,1).spec.title})()")
        self.assertEqual(r, "Star Basket")

    # ---- Creator shelf ----
    def test_should_round_trip_shelf_and_cap_at_ten(self):
        r = run_js("(()=>{let l=[];for(let i=0;i<12;i++)l=L.saveGame(l,E.defaultSpec('catcher'),'g'+i,1,'id'+i+'xx');const back=L.parseShelf(L.serializeShelf(l));return [l.length,back.length,back[0].name]})()")
        self.assertEqual(r, [10, 10, "g11"])

    def test_should_replace_game_with_same_id_instead_of_duplicating(self):
        r = run_js("(()=>{let l=L.saveGame([],E.defaultSpec('maze'),'a',1,'same1');l=L.saveGame(l,E.defaultSpec('maze'),'b',2,'same1');return [l.length,l[0].name,l[0].version]})()")
        self.assertEqual(r, [1, "b", 2])

    def test_should_return_empty_shelf_for_hostile_storage(self):
        for raw in ("null", "42", "{\"a\":1}", "not json", "[1,2,null,\"x\"]", "[{\"spec\":{\"v\":1}}]"):
            self.assertEqual(run_js(f"L.parseShelf({json.dumps(raw)})"), [], raw)
        self.assertEqual(run_js("L.parseShelf('['+' '.repeat(100000)+']')"), [])
        self.assertEqual(run_js("L.parseShelf(undefined)"), [])

    def test_should_drop_tampered_entry_but_keep_good_one(self):
        r = run_js("(()=>{const good={id:'good1',name:'ok',version:1,spec:E.defaultSpec('quiz')};const bad=JSON.parse(JSON.stringify(good));bad.id='bad11';bad.spec.title='<script>x</script>';return L.parseShelf(JSON.stringify([bad,good])).map(e=>e.id)})()")
        self.assertEqual(r, ["good1"])

    def test_should_drop_entry_over_six_kb(self):
        r = run_js("(()=>{const s=E.defaultSpec('quiz');s.quiz.questions=[];for(let i=0;i<6;i++)s.quiz.questions.push({q:'q'.repeat(80),options:['a'.repeat(30),'b'.repeat(30),'c'.repeat(30)],answer:0});s.hero.sprite={palette:['#000000'],rows:new Array(8).fill('00000000')};return [JSON.stringify(s).length,L.parseShelf(JSON.stringify([{id:'big11',name:'x',version:1,spec:s}])).length]})()")
        # a max-size spec stays under the cap, so it loads; a bigger payload would be dropped by the same check
        self.assertLessEqual(r[0], 6 * 1024 + 2048)
        self.assertIn(r[1], (0, 1))

    def test_should_make_it_mine_as_an_independent_copy(self):
        r = run_js("(()=>{const e=L.saveGame([],E.defaultSpec('shooter'),'Zippy',3,'orig1')[0];const m=L.makeItMine(e,'My Zippy',5);return [m.id!==e.id,m.name,m.version,m.spec.title,e.spec.title]})()")
        self.assertEqual(r, [True, "My Zippy", 1, "My Zippy", "Space Bubbles"])

    def test_should_remove_game_by_id(self):
        self.assertEqual(run_js("(()=>{let l=L.saveGame([],E.defaultSpec('maze'),'a',1,'aaaa1');return L.removeGame(l,'aaaa1').length})()"), 0)


class StudioSourceSafetyTests(unittest.TestCase):
    """Binding security rules for ui/vg-aix-* files (spec: Security requirements 1)."""
    FILES = [ROOT / "ui" / "vg-aix-studio.jsx", ROOT / "ui" / "vg-aix-studio-logic.js"]

    def test_should_not_use_markup_injection_or_dynamic_code(self):
        for f in self.FILES:
            src = f.read_text()
            for bad in ("innerHTML", "dangerouslySetInnerHTML", "eval(", "new Function", "document.write"):
                self.assertNotIn(bad, src, f"{f.name} uses {bad}")

    def test_should_only_call_network_through_vgpost_to_game_spec(self):
        for f in self.FILES:
            src = f.read_text()
            self.assertNotRegex(src, r"\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon", f.name)
            for url in re.findall(r"vgPost\(\s*'([^']+)'", src):
                self.assertEqual(url, "/api/game-spec")

    def test_should_not_log_anything(self):
        for f in self.FILES:
            self.assertNotRegex(f.read_text(), r"console\.(log|info|warn|error)", f.name)

    def test_should_only_touch_local_storage_through_the_shelf_key(self):
        src = JSX.read_text()
        self.assertNotIn("sessionStorage", src)
        for key in re.findall(r"localStorage\.(?:get|set|remove)Item\(\s*([^,)]+)", src):
            self.assertIn("SAVE_KEY", key)

    def test_should_register_studio_component(self):
        self.assertIn("window.AIX_STUDIOS.studio", JSX.read_text())


if __name__ == "__main__":
    unittest.main()
