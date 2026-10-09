"""AI Explorers game engine: validation (incl. hostile specs + sprites), deterministic play to win and lose, describe/friendlyDiff, view safety (node)."""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "ui" / "vg-aix-engine.js"
VIEW = ROOT / "ui" / "vg-aix-game.jsx"
NODE = shutil.which("node")

# JS prelude: E = engine, bots that play a template to a win or a loss, and a simulator.
PRELUDE = r"""
const E=require(%s);
const sgn=(v,dz)=>Math.abs(v)<(dz||2)?0:Math.sign(v);
const near=(st,kind,from)=>{let b=null,bd=1e9;for(const e of st.ents){if(e.kind!==kind)continue;const d=Math.abs(e.x-from.x)+(st.template==='shooter'?0:Math.abs(e.y-from.y)*0.3);if(e.y>from.y&&st.template==='catcher')continue;if(d<bd){bd=d;b=e}}return b};
function mazeStep(st,pred){const m=st.maze,w=m.w,key=(c,r)=>r*w+c,seen={},q=[[st.hero.c,st.hero.r,null]];seen[key(st.hero.c,st.hero.r)]=1;
 for(let i=0;i<q.length;i++){const [c,r,first]=q[i];if(pred(m.tiles[key(c,r)],c,r)&&first)return first;
  for(const d of [[1,0],[-1,0],[0,1],[0,-1]]){const x=c+d[0],y=r+d[1];if(m.tiles[key(x,y)]===undefined||m.tiles[key(x,y)]===1||seen[key(x,y)])continue;seen[key(x,y)]=1;q.push([x,y,first||{x:d[0],y:d[1]}])}}return {x:0,y:0}}
const BOTS={
 catcherWin:(st)=>{const e=near(st,'good',st.hero);return {x:e?sgn(e.x-st.hero.x):0}},
 catcherLose:(st)=>{const e=near(st,'bad',st.hero);return {x:e?sgn(e.x-st.hero.x):0}},
 runnerWin:(st,f)=>{const e=st.ents.filter(e=>e.kind==='good'&&e.x>st.hero.x).sort((a,b)=>a.x-b.x)[0];if(!e)return {y:0};const lane=E.LANE_Y.indexOf(e.y);return {y:f%%2?0:sgn(lane-st.hero.lane,0.5)}},
 runnerLose:(st,f)=>{const e=st.ents.filter(e=>e.kind==='bad'&&e.x>st.hero.x).sort((a,b)=>a.x-b.x)[0];if(!e)return {y:0};const lane=E.LANE_Y.indexOf(e.y);return {y:f%%2?0:sgn(lane-st.hero.lane,0.5)}},
 shooterWin:(st)=>{const bad=st.ents.filter(e=>e.kind==='bad').sort((a,b)=>b.y-a.y)[0];if(!bad)return {};
  const blocked=st.ents.some(g=>g.kind==='good'&&Math.abs(g.x-bad.x)<8&&g.y>bad.y-4&&g.y<st.hero.y);
  return {x:sgn(bad.x-st.hero.x,1),action:!blocked&&Math.abs(bad.x-st.hero.x)<3}},
 shooterLose:()=>({}),
 mazeWin:(st)=>mazeStep(st,(t,c,r)=>c===st.maze.exit[0]&&r===st.maze.exit[1]),
 mazeLose:(st)=>mazeStep(st,(t)=>t===2),
 quizWin:(st,f)=>({pick:f%%2?undefined:st.spec.quiz.questions[st.q.i]&&st.spec.quiz.questions[st.q.i].answer}),
 quizLose:(st,f)=>({pick:f%%2?undefined:st.spec.quiz.questions[st.q.i]&&(st.spec.quiz.questions[st.q.i].answer+1)%%3}),
};
function sim(spec,seed,bot,maxMs){let st=E.create(spec,seed),f=0,fr=16;while(st.status==='playing'&&st.t<maxMs){st=E.step(st,BOTS[bot](st,f),fr);f++}return st}
const tweak=(t,fn)=>{const s=E.defaultSpec(t);fn(s);return s};
const out=(x)=>console.log(JSON.stringify(x));
""" % json.dumps(str(ENGINE))


def run_js(body):
    """Run `body` after the prelude; the body calls out(...) with a JSON-able result."""
    p = subprocess.run([NODE, "-e", PRELUDE + body], capture_output=True, text=True)
    if p.returncode:
        raise AssertionError("node failed: " + p.stderr[-600:])
    return json.loads(p.stdout)


T = ["catcher", "runner", "maze", "shooter", "quiz"]


@unittest.skipUnless(NODE, "node not installed")
class StarterTests(unittest.TestCase):
    def test_should_list_the_five_classic_templates_plus_blocks(self):
        self.assertEqual(run_js("out(E.TEMPLATES)"), T + ["blocks"])

    def test_should_ship_a_valid_fun_starter_with_ask_and_ideas_for_every_template(self):
        for t in T:
            r = run_js(f"const s=E.defaultSpec('{t}');out({{v:E.clientValidate(s),s}})")
            self.assertTrue(r["v"]["ok"], (t, r["v"]["errors"]))
            self.assertTrue(r["s"]["ask"])
            self.assertGreaterEqual(len(r["s"]["nextIdeas"]), 2)
            self.assertEqual(r["s"]["template"], t)
            self.assertEqual(r["v"]["spec"]["title"], r["s"]["title"])

    def test_should_ship_a_valid_blocks_starter_that_plays(self):
        r = run_js("const s=E.defaultSpec('blocks');let st=E.create(s,1);const a=st.status;st=E.step(st,{dx:1},16);out([E.clientValidate(s).ok,a,st.template,s.template])")
        self.assertEqual(r, [True, "playing", "blocks", "blocks"])

    def test_should_default_and_clamp_blocks_terrain_and_seed(self):
        r = run_js("const s=E.defaultSpec('blocks');const a=E.clientValidate(s).spec.world;s.world.terrain='snow';s.world.seed=9999999;const b=E.clientValidate(s).spec.world;s.world.seed=-5;out([a.terrain,a.seed,b.terrain,b.seed,E.clientValidate(s).spec.world.seed])")
        self.assertEqual(r, ["meadow", 1, "snow", 999999, 0])

    def test_should_reject_bad_blocks_terrain_or_seed_type(self):
        for fld in ["terrain='lava'", "terrain=5", "seed='7'", "seed=null"]:
            self.assertFalse(run_js(f"const s=E.defaultSpec('blocks');s.world.{fld};out(E.clientValidate(s).ok)"), fld)

    def test_should_not_add_terrain_or_seed_to_other_templates(self):
        self.assertEqual(run_js("const s=E.defaultSpec('catcher');s.world.terrain='snow';out(Object.keys(E.clientValidate(s).spec.world))"), ["bg", "theme"])

    def test_should_return_a_fresh_copy_each_time(self):
        self.assertTrue(run_js("const a=E.defaultSpec('catcher');a.title='x';out(E.defaultSpec('catcher').title!=='x')"))

    def test_should_fall_back_to_catcher_for_unknown_template(self):
        self.assertEqual(run_js("out(E.defaultSpec('nope').template)"), "catcher")

    def test_should_keep_valid_sprites_in_starters(self):
        self.assertTrue(run_js("out(!!E.clientValidate(E.defaultSpec('catcher')).spec.hero.sprite)"))


@unittest.skipUnless(NODE, "node not installed")
class ValidateTests(unittest.TestCase):
    def v(self, mut):
        """Validate a catcher starter after the JS `mut` statement(s) changed `s`."""
        return run_js(f"const s=E.defaultSpec('catcher');{mut};out(E.clientValidate(s))")

    def test_should_never_throw_on_hostile_inputs(self):
        r = run_js(r"""
const deep={};let c=deep;for(let i=0;i<5000;i++){c.a={};c=c.a}
const loop={};loop.self=loop;
const inputs=[null,undefined,0,NaN,'x',[],[1],true,()=>1,Symbol('s'),10n,deep,loop,{v:1},{template:'catcher'},JSON.parse('{"__proto__":{"template":"quiz"}}'),
 new Proxy({}, {get(){throw new Error('boom')},has(){throw new Error('boom')},getOwnPropertyDescriptor(){throw new Error('boom')}}),
 Object.create({template:'catcher',v:1}), 'a'.repeat(1e6), {v:1,template:'catcher',title:'a'.repeat(1e6)}];
let bad=0;for(const i of inputs){try{const r=E.clientValidate(i);if(r.ok!==false&&i!==undefined)bad++;if(typeof r.ok!=='boolean')bad++}catch(e){bad++}}
out(bad)""")
        self.assertEqual(r, 0)

    def test_should_reject_non_object_specs(self):
        for x in ["null", "[]", "42", "'str'"]:
            self.assertFalse(run_js(f"out(E.clientValidate({x}).ok)"))

    def test_should_not_inherit_values_from_the_prototype_chain(self):
        self.assertFalse(run_js("out(E.clientValidate(Object.create(E.defaultSpec('catcher'))).ok)"))

    def test_should_clamp_numbers_and_coerce_numeric_strings(self):
        r = self.v("s.rules.speed=99;s.rules.lives=-5;s.rules.spawnRate='4';s.goal.target=1e9")
        self.assertEqual(r["spec"]["rules"], {"speed": 5, "lives": 1, "spawnRate": 4})
        self.assertEqual(r["spec"]["goal"]["target"], 50)

    def test_should_round_floats_and_clamp_infinity(self):
        r = self.v("s.rules.speed=2.6;s.goal.target=-Infinity")
        self.assertEqual(r["spec"]["rules"]["speed"], 3)
        self.assertEqual(r["spec"]["goal"]["target"], 3)

    def test_should_reject_nan_and_non_numeric_numbers(self):
        for bad in ["NaN", "'abc'", "null", "{}", "true"]:
            self.assertFalse(self.v(f"s.rules.speed={bad}")["ok"], bad)

    def test_should_replace_bad_colours_with_defaults(self):
        for bad in ["'red'", "'#fff'", "'#gggggg'", "'url(x)'", "123", "'#ff00ff;x'"]:
            r = self.v(f"s.hero.color={bad};s.world.bg={bad}")
            self.assertTrue(r["ok"])
            self.assertRegex(r["spec"]["hero"]["color"], r"^#[0-9a-f]{6}$")
            self.assertRegex(r["spec"]["world"]["bg"], r"^#[0-9a-f]{6}$")

    def test_should_lowercase_good_colours(self):
        self.assertEqual(self.v("s.hero.color='#FFAA00'")["spec"]["hero"]["color"], "#ffaa00")

    def test_should_reject_bad_enums(self):
        for mut in ["s.template='boss'", "s.hero.shape='hexagon'", "s.goal.kind='win'", "s.world.theme='lava'", "s.v=2", "s.items.bad.shape='x'"]:
            self.assertFalse(self.v(mut)["ok"], mut)

    def test_should_refuse_script_and_javascript_text(self):
        for bad in ["'<script>alert(1)</script>'", "'javascript:alert(1)'", "'JaVaScRiPt  :x'", "'a<b'", "'a>b'"]:
            self.assertFalse(self.v(f"s.title={bad}")["ok"], bad)
            self.assertFalse(self.v(f"s.texts.win={bad}")["ok"], bad)
            self.assertFalse(self.v(f"s.ask={bad}")["ok"], bad)

    def test_should_strip_control_chars_and_cap_long_strings(self):
        r = self.v("s.title='  Hi\\u0000\\u0007 there\\u202e  ';s.texts.start='x'.repeat(10000);s.hero.name='n'.repeat(500)")
        self.assertEqual(r["spec"]["title"], "Hi there")
        self.assertEqual(len(r["spec"]["texts"]["start"]), 80)
        self.assertEqual(len(r["spec"]["hero"]["name"]), 20)

    def test_should_reject_non_string_and_empty_required_text(self):
        for bad in ["null", "42", "{}", "['a']", "'   '", "'\\u0000'"]:
            self.assertFalse(self.v(f"s.title={bad}")["ok"], bad)

    def test_should_drop_unknown_keys_and_proto_pollution(self):
        r = run_js("const s=E.defaultSpec('catcher');s.evil='x';s.hero.evil=1;s.rules.__proto__={speed:5};s.constructor={a:1};const c=E.clientValidate(s);out({ok:c.ok,keys:Object.keys(c.spec),h:Object.keys(c.spec.hero)})")
        self.assertTrue(r["ok"])
        self.assertNotIn("evil", r["keys"])
        self.assertNotIn("evil", r["h"])
        self.assertNotIn("constructor", r["keys"])

    def test_should_drop_quiz_block_for_non_quiz_templates(self):
        r = self.v("s.quiz={questions:[]}")
        self.assertTrue(r["ok"])
        self.assertNotIn("quiz", r["spec"])

    def test_should_require_quiz_block_for_quiz_template(self):
        self.assertFalse(run_js("const s=E.defaultSpec('quiz');delete s.quiz;out(E.clientValidate(s))")["ok"])

    def test_should_reject_bad_quiz_questions(self):
        for mut in ["s.quiz.questions[0].answer=7", "s.quiz.questions[0].answer=-1", "s.quiz.questions[0].answer='1'", "s.quiz.questions[0].options=['a','b']",
                    "s.quiz.questions[0].options=['a','b','c','d']", "s.quiz.questions=[]", "s.quiz.questions=Array(7).fill(s.quiz.questions[0])",
                    "s.quiz.questions[0].q='<b>x</b>'", "s.quiz.questions[0].options[1]=5"]:
            r = run_js(f"const s=E.defaultSpec('quiz');{mut};out(E.clientValidate(s).ok)")
            self.assertFalse(r, mut)

    def test_should_cap_long_quiz_option_text(self):
        r = run_js("const s=E.defaultSpec('quiz');s.quiz.questions[0].options[0]='z'.repeat(300);out(E.clientValidate(s).spec.quiz.questions[0].options[0].length)")
        self.assertEqual(r, 30)

    def test_should_validate_ask_and_next_ideas(self):
        self.assertTrue(self.v("delete s.ask;delete s.nextIdeas")["ok"])
        self.assertEqual(len(self.v("s.ask='y'.repeat(500)")["spec"]["ask"]), 80)
        for mut in ["s.ask=5", "s.nextIdeas=['one']", "s.nextIdeas=['a','b','c','d']", "s.nextIdeas='ab'", "s.nextIdeas=['a',5]", "s.nextIdeas=['a','<i>']"]:
            self.assertFalse(self.v(mut)["ok"], mut)
        self.assertEqual(len(self.v("s.nextIdeas=['a'.repeat(99),'b']")["spec"]["nextIdeas"][0]), 30)


@unittest.skipUnless(NODE, "node not installed")
class SpriteTests(unittest.TestCase):
    GOOD = "{palette:['#ff0000','#00FF00'],rows:['01010101','10101010','01010101','10101010','01010101','10101010','01010101','10101010']}"

    def sprite(self, expr):
        """Return the hero sprite left after validating a spec whose hero.sprite is `expr`."""
        return run_js(f"const s=E.defaultSpec('catcher');s.hero.sprite={expr};const r=E.clientValidate(s);out({{ok:r.ok,sp:r.spec&&r.spec.hero.sprite||null}})")

    def test_should_keep_a_valid_sprite_and_lowercase_its_palette(self):
        r = self.sprite(self.GOOD)
        self.assertTrue(r["ok"])
        self.assertEqual(r["sp"]["palette"], ["#ff0000", "#00ff00"])
        self.assertEqual(len(r["sp"]["rows"]), 8)

    def test_should_drop_invalid_sprites_but_keep_the_spec(self):
        bad = ["null", "'str'", "[]", "{palette:[],rows:[]}", "{palette:['#ff0000'],rows:Array(8).fill('00000000').slice(0,7)}",
               "{palette:['#ff0000'],rows:Array(9).fill('00000000')}", "{palette:['#ff0000'],rows:Array(8).fill('0000000')}",
               "{palette:['#ff0000'],rows:Array(8).fill('000000000')}", "{palette:['#ff0000'],rows:Array(8).fill('00000001')}",
               "{palette:['#ff0000'],rows:Array(8).fill('0000000a')}", "{palette:['#ff0000'],rows:Array(8).fill('0000000-')}",
               "{palette:['red'],rows:Array(8).fill('00000000')}", "{palette:Array(7).fill('#ff0000'),rows:Array(8).fill('00000000')}",
               "{palette:['#ff0000'],rows:Array(8).fill(0)}", "{palette:['#ff0000']}", "{rows:Array(8).fill('00000000')}",
               "{palette:['#ff0000'],rows:Array(8).fill('0000000\\u0660')}"]
        for b in bad:
            r = self.sprite(b)
            self.assertTrue(r["ok"], b)
            self.assertIsNone(r["sp"], b)

    def test_should_validate_sprites_on_items_too(self):
        r = run_js(f"const s=E.defaultSpec('catcher');s.items.good.sprite={self.GOOD};s.items.bad.sprite={{palette:['#fff'],rows:[]}};const c=E.clientValidate(s).spec;out([!!c.items.good.sprite,!!c.items.bad.sprite])")
        self.assertEqual(r, [True, False])

    def test_should_not_alias_the_input_sprite(self):
        self.assertTrue(run_js(f"const s=E.defaultSpec('catcher');s.hero.sprite={self.GOOD};const c=E.clientValidate(s).spec;s.hero.sprite.rows[0]='11111111';out(c.hero.sprite.rows[0]==='01010101')"))


@unittest.skipUnless(NODE, "node not installed")
class PlayTests(unittest.TestCase):
    def test_should_reach_a_win_in_every_template(self):
        for t in T:
            for seed in (1, 7, 42):
                r = run_js(f"out(sim(tweak('{t}',s=>{{s.rules.lives=5}}),{seed},'{t}Win',120000).status)")
                self.assertEqual(r, "won", (t, seed))

    def test_should_reach_a_loss_in_every_template(self):
        for t in T:
            for seed in (1, 7, 42):
                r = run_js(f"out(sim(E.defaultSpec('{t}'),{seed},'{t}Lose',120000).status)")
                self.assertEqual(r, "lost", (t, seed))

    def test_should_win_survive_and_reach_goals_by_time(self):
        for t in ("catcher", "runner", "shooter"):
            for kind in ("survive", "reach"):
                r = run_js(f"out(sim(tweak('{t}',s=>{{s.rules.lives=5;s.goal.kind='{kind}';s.goal.target=4}}),3,'{t}Win',60000))")
                self.assertEqual(r["status"], "won", (t, kind))
                self.assertGreaterEqual(r["t"], 4000)

    def test_should_be_deterministic_for_same_spec_seed_and_inputs(self):
        for t in T:
            r = run_js(f"const a=sim(E.defaultSpec('{t}'),9,'{t}Win',9000),b=sim(E.defaultSpec('{t}'),9,'{t}Win',9000);out(JSON.stringify(a)===JSON.stringify(b))")
            self.assertTrue(r, t)

    def test_should_differ_between_seeds(self):
        self.assertTrue(run_js("const a=E.create(E.defaultSpec('maze'),1),b=E.create(E.defaultSpec('maze'),2);out(JSON.stringify(a.maze.tiles)!==JSON.stringify(b.maze.tiles))"))

    def test_should_not_mutate_the_previous_state(self):
        for t in T:
            r = run_js(f"let s=E.create(E.defaultSpec('{t}'),5);for(let i=0;i<30;i++)s=E.step(s,{{x:1,action:true}},16);const snap=JSON.stringify(s);E.step(s,{{x:-1,y:1,action:true,pick:1}},16);out(JSON.stringify(s)===snap)")
            self.assertTrue(r, t)

    def test_should_survive_hostile_input_and_frame_times(self):
        r = run_js("""let ok=true;for(const t of E.TEMPLATES){let s=E.create(E.defaultSpec(t),1);
 for(const inp of [null,undefined,5,'x',{x:NaN,y:Infinity,action:'yes',pick:99},{x:1e9,y:-1e9},{pick:-1},[]])for(const dt of [NaN,-5,1e9,Infinity,undefined,0]){try{s=E.step(s,inp,dt);if(!['playing','won','lost'].includes(s.status))ok=false}catch(e){ok=false}}}
 out(ok)""")
        self.assertTrue(r)

    def test_should_ignore_steps_after_the_game_ends(self):
        r = run_js("const s=sim(E.defaultSpec('shooter'),1,'shooterLose',99999);const n=E.step(s,{x:1},16);out(n.status===s.status&&n.t===s.t)")
        self.assertTrue(r)

    def test_should_refuse_to_create_from_an_invalid_spec(self):
        r = run_js("const s=E.create({template:'catcher'},1);out([s.status,E.step(s,{},16).status])")
        self.assertEqual(r, ["invalid", "invalid"])

    def test_should_scale_difficulty_with_rules(self):
        # faster + more frequent spawns => more things on screen after the same time
        r = run_js("""const run=(sp,rt)=>{let s=E.create(tweak('catcher',x=>{x.rules.speed=sp;x.rules.spawnRate=rt;x.rules.lives=5}),1);let n=0;for(let i=0;i<300;i++){s=E.step(s,{},16);n+=s.ents.length}return n};
 out([run(1,1),run(5,5)])""")
        self.assertGreater(r[1], r[0])

    def test_should_scale_lives_from_rules(self):
        self.assertEqual(run_js("out([1,3,5].map(l=>E.create(tweak('shooter',s=>{s.rules.lives=l}),1).lives))"), [1, 3, 5])

    def test_should_lose_a_life_per_bad_catch_and_a_point_per_good_catch(self):
        r = run_js("""let s=E.create(E.defaultSpec('catcher'),1);s.ents=[{id:1,kind:'good',x:50,y:88,vy:0},{id:2,kind:'bad',x:50,y:88,vy:0}];
 s=E.step(s,{},16);out([s.score,s.lives,s.events.map(e=>e.type)])""")
        self.assertEqual(r[:2], [1, 2])
        self.assertEqual(sorted(r[2]), ["bad", "good"])

    def test_should_hop_one_lane_per_press_in_runner(self):
        r = run_js("""let s=E.create(E.defaultSpec('runner'),1);const l=[];for(let i=0;i<10;i++){s=E.step(s,{y:-1},16);l.push(s.hero.lane)}
 s=E.step(s,{y:0},16);s=E.step(s,{y:1},16);l.push(s.hero.lane);out(l)""")
        self.assertEqual(r[0], 0)
        self.assertEqual(set(r[:10]), {0})
        self.assertEqual(r[10], 1)

    def test_should_not_walk_through_maze_walls(self):
        r = run_js("""let s=E.create(E.defaultSpec('maze'),3);for(let i=0;i<400;i++){s=E.step(s,{x:i%2?-1:0,y:i%2?0:-1},16);if(s.maze.tiles[s.hero.r*s.maze.w+s.hero.c]===1)out('inwall')}out('ok')""".replace("out('inwall')", "throw 1"))
        self.assertEqual(r, "ok")

    def test_should_keep_the_maze_route_free_of_goo_and_solvable(self):
        r = run_js("""let ok=true;for(let seed=1;seed<40;seed++){const s=E.create(tweak('maze',x=>{x.rules.lives=1;x.goal.target=50;x.rules.spawnRate=5}),seed);
 const e=sim(tweak('maze',x=>{x.rules.lives=1;x.goal.target=50;x.rules.spawnRate=5}),seed,'mazeWin',99999);if(e.status!=='won')ok=false}out(ok)""")
        self.assertTrue(r)

    def test_should_end_quiz_only_after_feedback_and_ignore_picks_meanwhile(self):
        r = run_js("""let s=E.create(E.defaultSpec('quiz'),1);s=E.step(s,{pick:1},16);const a=[s.score,s.q.i];s=E.step(s,{pick:0},16);const b=[s.score,s.q.i];
 for(let i=0;i<70;i++)s=E.step(s,{},16);out([a,b,s.q.i])""")
        self.assertEqual(r, [[1, 0], [1, 0], 1])

    def test_should_report_progress_between_0_and_1(self):
        r = run_js("""let ok=true;for(const t of ['catcher','runner','maze','shooter','quiz']){let s=E.create(E.defaultSpec(t),2);for(let i=0;i<200;i++){s=E.step(s,BOTS[t+'Win'](s,i),16);if(!(s.progress>=0&&s.progress<=1))ok=false}}out(ok)""")
        self.assertTrue(r)


@unittest.skipUnless(NODE, "node not installed")
class DescribeTests(unittest.TestCase):
    def test_should_describe_every_starter_with_labelled_rows(self):
        for t in T:
            rows = run_js(f"out(E.describe(E.defaultSpec('{t}')))")
            labels = [r["label"] for r in rows]
            for need in ("Hero", "Goal", "Speed", "Lives", "Spawn rate"):
                self.assertIn(need, labels, t)
            self.assertTrue(all(r["value"] and r["hint"] for r in rows))

    def test_should_describe_nothing_for_invalid_specs(self):
        self.assertEqual(run_js("out([E.describe(null),E.describe({}),E.describe('x')])"), [[], [], []])

    def test_should_mention_a_hand_drawn_hero(self):
        rows = run_js("out(E.describe(E.defaultSpec('catcher')))")
        self.assertIn("starter drawing", [r for r in rows if r["label"] == "Hero"][0]["value"])

    def test_should_name_colours_in_words(self):
        self.assertEqual(run_js("out(['#ff0000','#00ff00','#0000ff','#000000','#ffffff','#808080'].map(E.colorName))"),
                         ["red", "green", "blue", "black", "white", "grey"])

    def test_should_show_speed_change_in_friendly_diff(self):
        r = run_js("const a=E.defaultSpec('catcher'),b=E.defaultSpec('catcher');b.rules.speed=4;out(E.friendlyDiff(a,b))")
        self.assertEqual(r, ["Speed 2 of 5 -> 4 of 5"])

    def test_should_list_several_changes(self):
        r = run_js("const a=E.defaultSpec('shooter'),b=E.defaultSpec('shooter');b.rules.lives=5;b.hero.color='#00ff00';b.texts.win='Yay!';delete b.hero.sprite;out(E.friendlyDiff(a,b))")
        self.assertEqual(len(r), 4)
        self.assertTrue(any(x.startswith("Lives 3 -> 5") for x in r))
        self.assertIn("The story words changed", r)
        self.assertIn("Hero drawing changed", r)

    def test_should_return_nothing_when_specs_match_or_are_invalid(self):
        self.assertEqual(run_js("const a=E.defaultSpec('maze');out([E.friendlyDiff(a,a),E.friendlyDiff(null,a),E.friendlyDiff(a,{}),E.friendlyDiff(1,2)])"), [[], [], [], []])


class ViewSafetyTests(unittest.TestCase):
    def test_should_not_use_dangerous_apis_in_engine_or_player(self):
        for f in (ENGINE, VIEW):
            src = f.read_text()
            for bad in ("innerHTML", "dangerouslySetInnerHTML", "eval(", "new Function", "document.write", "fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "localStorage", "sessionStorage"):
                self.assertNotIn(bad, src, f"{f.name} uses {bad}")

    def test_should_validate_before_running_and_respect_motion_and_visibility(self):
        src = VIEW.read_text()
        self.assertIn("AIXEngine.clientValidate", src)
        self.assertIn("prefers-reduced-motion", src)
        self.assertIn("visibilitychange", src)
        self.assertIn("window.AixGamePlayer", src)

    def test_should_make_touch_buttons_at_least_44px(self):
        src = VIEW.read_text()
        m = re.search(r"const TAP\s*=\s*(\d+)", src)
        self.assertTrue(m and int(m.group(1)) >= 44)


if __name__ == "__main__":
    unittest.main()
