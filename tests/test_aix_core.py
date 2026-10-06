"""AI Explorers core: catalog integrity, progress validation fuzz, award/wear rules, link safety, rng (run under node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "ui" / "vg-aix-core.js"
NODE = shutil.which("node")


def run_js(expr):
    """Evaluate `expr` against the core module (as C) and return its JSON result."""
    code = f"const C=require({json.dumps(str(CORE))});console.log(JSON.stringify({expr}))"
    return json.loads(subprocess.run([NODE, "-e", code], capture_output=True, text=True, check=True).stdout)


@unittest.skipUnless(NODE, "node not installed")
class CatalogTests(unittest.TestCase):
    def test_should_list_ten_lessons_numbered_one_to_ten_with_unique_ids(self):
        cat = run_js("C.CATALOG")
        self.assertEqual([c["n"] for c in cat], list(range(1, 11)))
        self.assertEqual(len({c["id"] for c in cat}), 10)

    def test_should_mark_only_sorter_sabotage_and_fib_ready(self):
        ready = {c["id"] for c in run_js("C.CATALOG") if c["ready"]}
        self.assertEqual(ready, {"sorter", "sabotage", "fib"})

    def test_should_have_a_real_part_for_every_lesson(self):
        parts = {p["id"]: p for p in run_js("C.PARTS")}
        for c in run_js("C.CATALOG"):
            self.assertIn(c["part"], parts)
        self.assertEqual(len({c["part"] for c in run_js("C.CATALOG")}), 10)

    def test_should_use_valid_slots_and_three_free_starters(self):
        parts = run_js("C.PARTS")
        self.assertTrue(all(p["slot"] in ("hat", "face", "body", "wheels", "color") for p in parts))
        self.assertEqual(sum(1 for p in parts if p.get("free")), 3)

    def test_should_only_link_to_safe_urls_from_the_catalog(self):
        for c in run_js("C.CATALOG"):
            self.assertEqual(run_js(f"C.safeLink({json.dumps(c['goFurther']['url'])})"), c["goFurther"]["url"])


@unittest.skipUnless(NODE, "node not installed")
class ProgressTests(unittest.TestCase):
    EMPTY = {"v": 1, "done": {}, "stars": {}, "parts": [], "outfit": {}, "muted": False,
             "explored": {"templates": [], "wonder": 0, "sprites": 0, "ideas": 0}}

    def test_should_return_empty_progress_when_input_is_garbage(self):
        for bad in ["null", "undefined", "42", "'str'", "[]", "true", "NaN", "()=>1"]:
            self.assertEqual(run_js(f"C.validateProgress({bad})"), self.EMPTY, bad)

    def test_should_drop_unknown_ids_and_keys(self):
        raw = {"done": {"sorter": True, "evil": True, "__proto__": True}, "stars": {"nope": 3, "sorter": 2},
               "parts": ["p-propeller-hat", "bogus"], "extra": "x"}
        r = run_js(f"C.validateProgress({json.dumps(raw)})")
        self.assertEqual(r["done"], {"sorter": True})
        self.assertEqual(r["stars"], {"sorter": 2})
        self.assertEqual(r["parts"], ["p-propeller-hat"])
        self.assertNotIn("extra", r)

    def test_should_clamp_stars_to_zero_through_three_integers(self):
        r = run_js("C.validateProgress({stars:{sorter:99,sabotage:-1,fib:NaN,safari:1.9,twenty:'2',pixels:Infinity}}).stars")
        self.assertEqual(r, {"sorter": 3, "sabotage": 0, "fib": 0, "safari": 1, "twenty": 2, "pixels": 0})

    def test_should_ignore_non_true_done_values(self):
        r = run_js("C.validateProgress({done:{sorter:1,sabotage:'yes',fib:true}}).done")
        self.assertEqual(r, {"fib": True})

    def test_should_keep_outfit_only_when_owned_and_slot_matches(self):
        raw = {"parts": ["p-propeller-hat"], "outfit": {"hat": "p-propeller-hat", "face": "p-propeller-hat",
                                                         "body": "p-cape-body", "wheels": "p-starter-wheels", "bogus": "x"}}
        r = run_js(f"C.validateProgress({json.dumps(raw)}).outfit")
        self.assertEqual(r, {"hat": "p-propeller-hat", "wheels": "p-starter-wheels"})

    def test_should_coerce_muted_to_strict_boolean(self):
        self.assertFalse(run_js("C.validateProgress({muted:'yes'}).muted"))
        self.assertTrue(run_js("C.validateProgress({muted:true}).muted"))

    def test_should_never_throw_on_hostile_objects(self):
        expr = ("(()=>{const o={};Object.defineProperty(o,'done',{get(){throw new Error('x')}});"
                "return C.validateProgress(o)})()")
        self.assertEqual(run_js(expr), self.EMPTY)

    def test_should_handle_huge_inputs_without_growing(self):
        r = run_js("C.validateProgress({parts:Array(100000).fill('p-propeller-hat'),stars:{sorter:1e308}})")
        self.assertEqual(r["parts"], ["p-propeller-hat"])
        self.assertEqual(r["stars"], {"sorter": 3})

    def test_should_award_immutably_and_keep_best_stars(self):
        r = run_js("(()=>{const p=C.emptyProgress();const a=C.award(p,'sorter',3);const b=C.award(a,'sorter',1);"
                   "return {p,a,b}})()")
        self.assertEqual(r["p"], self.EMPTY)
        self.assertEqual(r["b"]["stars"], {"sorter": 3})
        self.assertEqual(r["b"]["parts"], ["p-propeller-hat"])
        self.assertEqual(r["b"]["done"], {"sorter": True})

    def test_should_grant_part_only_once_across_replays(self):
        r = run_js("C.award(C.award(C.emptyProgress(),'fib',1),'fib',2).parts")
        self.assertEqual(r, ["p-detective-hat"])

    def test_should_ignore_award_for_unknown_lesson(self):
        self.assertEqual(run_js("C.award(C.emptyProgress(),'nope',3)"), self.EMPTY)

    def test_should_clamp_award_stars(self):
        self.assertEqual(run_js("C.award(C.emptyProgress(),'fib',99).stars"), {"fib": 3})
        self.assertEqual(run_js("C.award(C.emptyProgress(),'fib',-5).stars"), {"fib": 0})

    def test_should_not_wear_a_part_that_is_not_owned(self):
        self.assertEqual(run_js("C.wear(C.emptyProgress(),'p-cape-body').outfit"), {})

    def test_should_wear_free_starter_and_swap_within_a_slot(self):
        r = run_js("(()=>{let p=C.award(C.emptyProgress(),'sorter',1);p=C.award(p,'safari',1);"
                   "p=C.wear(p,'p-propeller-hat');p=C.wear(p,'p-explorer-hat');return [p.outfit, C.wear(C.emptyProgress(),'p-starter-smile').outfit]})()")
        self.assertEqual(r[0], {"hat": "p-explorer-hat"})
        self.assertEqual(r[1], {"face": "p-starter-smile"})

    def test_should_take_part_off_when_worn_again_and_not_mutate_input(self):
        r = run_js("(()=>{const p=C.wear(C.emptyProgress(),'p-starter-smile');const q=C.wear(p,'p-starter-smile');return [p.outfit,q.outfit]})()")
        self.assertEqual(r, [{"face": "p-starter-smile"}, {}])


@unittest.skipUnless(NODE, "node not installed")
class StorageTests(unittest.TestCase):
    def test_should_roundtrip_through_storage(self):
        r = run_js("(()=>{const m={};const s={getItem:k=>m[k]??null,setItem:(k,v)=>{m[k]=v}};"
                   "const ok=C.saveProgress(s,C.award(C.emptyProgress(),'fib',2));return [ok,C.loadProgress(s).stars,Object.keys(m)]})()")
        self.assertEqual(r, [True, {"fib": 2}, ["sg-aix-v1"]])

    def test_should_load_empty_when_json_is_corrupt_or_hostile(self):
        for stored in ["{not json", "[1,2]", "null", '{"done":{"x":true},"parts":"p"}', '"str"']:
            r = run_js(f"C.loadProgress({{getItem:()=>{json.dumps(stored)}}})")
            self.assertEqual(r, ProgressTests.EMPTY, stored)

    def test_should_load_empty_when_storage_throws_or_missing(self):
        self.assertEqual(run_js("C.loadProgress({getItem(){throw new Error('blocked')}})"), ProgressTests.EMPTY)
        self.assertEqual(run_js("C.loadProgress(null)"), ProgressTests.EMPTY)

    def test_should_refuse_to_load_values_over_size_cap(self):
        big = json.dumps({"v": 1, "pad": "x" * 5000})
        self.assertEqual(run_js(f"C.loadProgress({{getItem:()=>{json.dumps(big)}}})"), ProgressTests.EMPTY)

    def test_should_report_false_when_save_fails(self):
        self.assertFalse(run_js("C.saveProgress({setItem(){throw new Error('quota')}},C.emptyProgress())"))
        self.assertFalse(run_js("C.saveProgress(null,C.emptyProgress())"))

    def test_should_keep_saved_size_under_cap_even_for_a_full_game(self):
        r = run_js("(()=>{let p=C.emptyProgress();C.CATALOG.forEach(c=>{p=C.award(p,c.id,3)});"
                   "C.PARTS.forEach(x=>{p=C.wear(p,x.id)});return JSON.stringify(p).length})()")
        self.assertLess(r, 4096)


@unittest.skipUnless(NODE, "node not installed")
class SafeLinkTests(unittest.TestCase):
    def link(self, url):
        return run_js(f"C.safeLink({json.dumps(url)})")

    def test_should_allow_code_org_and_its_subdomains_over_https(self):
        for ok in ["https://code.org", "https://code.org/", "https://studio.code.org/s/oceans", "https://www.code.org/a?b=1#c"]:
            self.assertEqual(self.link(ok), ok)

    def test_should_reject_dangerous_or_lookalike_links(self):
        bad = ["javascript:alert(1)", "http://code.org", "data:text/html,<script>1</script>", "https://code.org.evil.com",
               "https://evilcode.org", "//code.org", "HTTPS://code.org", "hTtPs://code.org", " https://code.org", "https://code.org ",
               "https://code.org\n", "https://user@code.org", "https://evil.com@code.org", "https://evil.com/code.org",
               "https://code.org\\evil.com", "https://code.org:8080/", "https://xcode.org", "https://code.org.", "", "ftp://code.org",
               "https://studio.code.org/a b", "https://evil.com#.code.org"]
        for url in bad:
            self.assertIsNone(self.link(url), repr(url))

    def test_should_reject_non_strings_and_overlong_urls(self):
        for bad in ["null", "undefined", "42", "{}", "['https://code.org']", "{toString(){return 'https://code.org'}}"]:
            self.assertIsNone(run_js(f"C.safeLink({bad})"), bad)
        self.assertIsNone(self.link("https://code.org/" + "a" * 400))


@unittest.skipUnless(NODE, "node not installed")
class RngTests(unittest.TestCase):
    def test_should_repeat_the_same_sequence_for_the_same_seed(self):
        a = run_js("(()=>{const r=C.rng(7);return [r(),r(),r()]})()")
        b = run_js("(()=>{const r=C.rng(7);return [r(),r(),r()]})()")
        self.assertEqual(a, b)

    def test_should_differ_between_seeds_and_stay_in_unit_range(self):
        seqs = run_js("(()=>{const a=C.rng(1),b=C.rng(2);const xs=[];for(let i=0;i<500;i++)xs.push(a());return [xs,a(),b()]})()")
        self.assertTrue(all(0 <= x < 1 for x in seqs[0]))
        self.assertNotEqual(seqs[1], seqs[2])

    def test_should_survive_odd_seeds(self):
        for s in ["NaN", "undefined", "-5", "1e20", "'abc'"]:
            v = run_js(f"C.rng({s})()")
            self.assertTrue(0 <= v < 1, s)

    def test_should_shuffle_into_a_copy_with_same_members(self):
        r = run_js("(()=>{const a=[1,2,3,4,5,6,7,8];const s=C.shuffle(a,C.rng(3));return [a,s,C.shuffle(a,C.rng(3))]})()")
        self.assertEqual(r[0], [1, 2, 3, 4, 5, 6, 7, 8])
        self.assertEqual(sorted(r[1]), r[0])
        self.assertEqual(r[1], r[2])
        self.assertNotEqual(r[1], r[0])

    def test_should_shuffle_empty_and_single_arrays(self):
        self.assertEqual(run_js("[C.shuffle([],C.rng(1)),C.shuffle([9],C.rng(1))]"), [[], [9]])


TEMPLATES = ["catcher", "runner", "maze", "shooter", "quiz"]


@unittest.skipUnless(NODE, "node not installed")
class StudioTests(unittest.TestCase):
    def test_should_list_study_and_studio_ready_with_real_parts(self):
        studios = run_js("C.STUDIOS")
        self.assertEqual([s["id"] for s in studios], ["study", "studio"])
        parts = {p["id"] for p in run_js("C.PARTS")}
        for s in studios:
            self.assertTrue(s["ready"] and s["title"] and s["tagline"])
            self.assertIn(s["part"], parts)

    def test_should_hardcode_the_five_template_ids(self):
        self.assertEqual(run_js("C.TEMPLATES"), TEMPLATES)

    def test_should_add_four_exploration_parts_in_hat_face_body_color_slots(self):
        slots = {p["id"]: p["slot"] for p in run_js("C.PARTS")}
        got = {slots[i] for i in ["p-compass-body", "p-stardust-color", "p-pixel-face", "p-spark-hat"]}
        self.assertEqual(got, {"hat", "face", "body", "color"})

    def test_should_award_a_studio_part_once_and_mark_it_done(self):
        r = run_js("C.award(C.award(C.emptyProgress(),'study',0),'study',0)")
        self.assertEqual(r["done"], {"study": True})
        self.assertEqual(r["parts"], ["p-scholar-face"])
        self.assertEqual(run_js("C.award(C.emptyProgress(),'studio',0).parts"), ["p-maker-hat"])

    def test_should_keep_studio_ids_when_validating_and_drop_other_ids(self):
        r = run_js("C.validateProgress({done:{study:true,studio:true,evil:true},stars:{study:9}})")
        self.assertEqual(r["done"], {"study": True, "studio": True})
        self.assertEqual(r["stars"], {"study": 3})

    def test_should_not_treat_a_studio_as_a_catalog_lesson(self):
        self.assertIsNone(run_js("C.lessonOf('study')"))
        self.assertEqual(run_js("C.studioOf('studio').id"), "studio")


@unittest.skipUnless(NODE, "node not installed")
class ExploreTests(unittest.TestCase):
    def test_should_add_a_template_once_in_canonical_order(self):
        r = run_js("(()=>{let p=C.emptyProgress();p=C.explore(p,'templates','quiz');p=C.explore(p,'templates','catcher');"
                   "p=C.explore(p,'templates','quiz');return p.explored.templates})()")
        self.assertEqual(r, ["catcher", "quiz"])

    def test_should_ignore_unknown_templates_and_keys(self):
        for call in ["C.explore(C.emptyProgress(),'templates','tetris')", "C.explore(C.emptyProgress(),'nope',1)",
                     "C.explore(C.emptyProgress(),'__proto__',1)", "C.explore(C.emptyProgress(),'templates',{})"]:
            self.assertEqual(run_js(call), ProgressTests.EMPTY, call)

    def test_should_unlock_the_template_part_only_after_all_five(self):
        r = run_js("(()=>{let p=C.emptyProgress();const out=[];%s.forEach(t=>{p=C.explore(p,'templates',t);out.push(p.parts.length)});return out})()" % json.dumps(TEMPLATES))
        self.assertEqual(r, [0, 0, 0, 0, 1])

    def test_should_unlock_wonder_part_on_the_third_question(self):
        r = run_js("(()=>{let p=C.emptyProgress();const out=[];for(let i=0;i<3;i++){p=C.explore(p,'wonder');out.push(p.parts)}return out})()")
        self.assertEqual(r, [[], [], ["p-stardust-color"]])

    def test_should_unlock_sprite_and_idea_parts_on_the_first_try(self):
        self.assertEqual(run_js("C.explore(C.emptyProgress(),'sprites',1).parts"), ["p-pixel-face"])
        self.assertEqual(run_js("C.explore(C.emptyProgress(),'ideas',1).parts"), ["p-spark-hat"])

    def test_should_cap_counters_at_99_and_ignore_bad_amounts(self):
        r = run_js("(()=>{let p=C.explore(C.emptyProgress(),'ideas',500);const a=p.explored.ideas;"
                   "p=C.explore(C.explore(C.explore(p,'ideas',-5),'ideas','7'),'ideas',NaN);return [a,p.explored.ideas]})()")
        self.assertEqual(r, [99, 99])

    def test_should_be_immutable(self):
        r = run_js("(()=>{const p=C.emptyProgress();C.explore(p,'wonder',3);return p})()")
        self.assertEqual(r, ProgressTests.EMPTY)

    def test_should_sanitise_explored_on_load(self):
        raw = {"explored": {"templates": ["quiz", "quiz", "evil", 7, "maze"], "wonder": 1e9, "sprites": "5",
                            "ideas": -3, "extra": 1}}
        r = run_js(f"C.validateProgress({json.dumps(raw)}).explored")
        self.assertEqual(r, {"templates": ["maze", "quiz"], "wonder": 99, "sprites": 0, "ideas": 0})

    def test_should_survive_hostile_explored_values(self):
        for bad in ["null", "[]", "'x'", "42", "{templates:'quiz'}", "{templates:{length:9}}", "{wonder:{},sprites:[],ideas:NaN}",
                    "{templates:Array(100000).fill('quiz')}", "JSON.parse('{\"__proto__\":{\"wonder\":9}}')"]:
            r = run_js(f"C.validateProgress({{explored:{bad}}}).explored")
            self.assertEqual(sorted(r), ["ideas", "sprites", "templates", "wonder"], bad)
            self.assertTrue(all(isinstance(r[k], int) and 0 <= r[k] <= 99 for k in ("wonder", "sprites", "ideas")), bad)
            self.assertTrue(set(r["templates"]) <= set(TEMPLATES) and len(set(r["templates"])) == len(r["templates"]), bad)

    def test_should_fuzz_validate_progress_into_a_valid_shape(self):
        # deterministic pseudo-random junk: whatever goes in, the output must keep the schema
        code = """
        const r=C.rng(99);const junk=[null,undefined,NaN,Infinity,-1,1e30,'x','quiz','__proto__',[],{},true,false,[1,2],{a:{b:{}}},'p-gold-color','study'];
        const pick=()=>junk[Math.floor(r()*junk.length)];
        const obj=()=>({done:{study:pick(),sorter:pick()},stars:{study:pick()},parts:[pick(),pick(),'p-spark-hat'],outfit:{hat:pick(),face:pick()},
          muted:pick(),explored:{templates:[pick(),pick(),'maze'],wonder:pick(),sprites:pick(),ideas:pick()}});
        const bad=[];
        for(let i=0;i<500;i++){const o=Math.floor(r()*3)===0?pick():obj();const p=C.validateProgress(o);
          const e=p.explored;
          const ok=e&&Array.isArray(e.templates)&&e.templates.every(t=>C.TEMPLATES.includes(t))&&['wonder','sprites','ideas'].every(k=>Number.isInteger(e[k])&&e[k]>=0&&e[k]<=99)
            &&JSON.stringify(C.validateProgress(p))===JSON.stringify(p);
          if(!ok)bad.push(i)}
        bad
        """
        self.assertEqual(run_js(f"(()=>{{{code.strip().rsplit(chr(10), 1)[0]} return bad}})()"), [])

    def test_should_keep_saved_size_under_cap_with_everything_unlocked(self):
        r = run_js("(()=>{let p=C.emptyProgress();C.CATALOG.concat(C.STUDIOS).forEach(c=>{p=C.award(p,c.id,3)});"
                   "C.TEMPLATES.forEach(t=>{p=C.explore(p,'templates',t)});['wonder','sprites','ideas'].forEach(k=>{p=C.explore(p,k,99)});"
                   "C.PARTS.forEach(x=>{p=C.wear(p,x.id)});return JSON.stringify(p).length})()")
        self.assertLess(r, 4096)


if __name__ == "__main__":
    unittest.main()
