"""Block Builder engine: build validation (strict), starter world, movement/edit rules, win/lose per goal, determinism,
purity and hostile inputs (node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOCKS = ROOT / "ui" / "vg-aix-blocks.js"
ENGINE = ROOT / "ui" / "vg-aix-engine.js"
NODE = shutil.which("node")

PRELUDE = r"""
const B=require(%s),E=require(%s);
const out=(x)=>console.log(JSON.stringify(x));
const rows=(fill)=>Array(12).fill(fill);
const flat=(ch)=>({layers:[rows(ch.repeat(12))]});
const spec=(fn)=>{const s=E.defaultSpec('blocks');if(fn)fn(s);return s};
// A tiny world: a strip of grass, hero starts near the middle. layers[z][y][x].
const strip=()=>{const r=rows('.'.repeat(12));r[5]='gggggggggggg';return {layers:[r]}};
const idx=(st,k)=>st.items.filter(i=>i.kind===k);
const sim=(sp,seed,bot,maxMs,init)=>{let st=B.create(sp,seed);if(init)init(st);let f=0;while(st.status==='playing'&&st.t<maxMs){st=B.step(st,bot(st,f),16);f++}return st};
const toward=(arr)=>(st)=>{const t=arr(st)[0];return t?{goTo:{x:t.x,y:t.y}}:{}};
const BOTS={collect:toward(st=>st.items.filter(i=>i.kind==='good')),flag:toward(st=>st.items.filter(i=>i.kind==='flag')),chase:toward(st=>st.critters),idle:()=>({})};
""" % (json.dumps(str(BLOCKS)), json.dumps(str(ENGINE)))


def run_js(body):
    p = subprocess.run([NODE, "-e", PRELUDE + body], capture_output=True, text=True)
    if p.returncode:
        raise AssertionError("node failed: " + p.stderr[-800:])
    return json.loads(p.stdout)


@unittest.skipUnless(NODE, "node not installed")
class BuildValidationTests(unittest.TestCase):
    def v(self, expr):
        return run_js(f"const b={expr};out(B.validateBuild(b))")

    def test_should_expose_the_contract_constants(self):
        r = run_js("out([B.SIZE,B.MAX_LAYERS,B.ALPHABET,B.hasBlocks,Object.keys(B.MATERIALS).sort().join('')])")
        self.assertEqual(r, [12, 6, ".gdswlbaytcpj", True, "".join(sorted("gdswlbaytcpj"))])

    def test_should_describe_every_material_with_cartoon_colours(self):
        r = run_js("out(Object.values(B.MATERIALS).every(m=>m.name&&/^#[0-9a-f]{6}$/.test(m.top)&&/^#[0-9a-f]{6}$/.test(m.left)&&/^#[0-9a-f]{6}$/.test(m.right)&&m.walkable))")
        self.assertTrue(r)
        flags = run_js("out([B.MATERIALS.a.slow,B.MATERIALS.j.bouncy,B.MATERIALS.t.solid,B.MATERIALS.t.see])")
        self.assertEqual(flags, [True, True, True, True])

    def test_should_accept_the_starter_and_return_a_fresh_copy(self):
        r = run_js("const s=B.starterBuild(),v=B.validateBuild(s);v.build.layers[0][0]='x';out([v.ok,v.errors,B.starterBuild().layers[0][0]])")
        self.assertEqual(r, [True, [], "............"])

    def test_should_accept_the_smallest_world(self):
        self.assertTrue(self.v("strip()")["ok"])
        self.assertTrue(self.v("{layers:[rows('.'.repeat(12)).map((r,i)=>i===0?'g'+'.'.repeat(11):r)]}")["ok"])

    def test_should_reject_bad_alphabet_characters(self):
        for ch in ["x", "G", "#", " ", "<", "0", "\\u00e9"]:
            r = self.v(f"{{layers:[rows('g'.repeat(11)+'{ch}')]}}")
            self.assertFalse(r["ok"], ch)
            self.assertIsNone(r["build"])
            self.assertTrue(r["errors"])

    def test_should_reject_wrong_row_and_layer_sizes(self):
        for expr in ["{layers:[rows('g'.repeat(13))]}", "{layers:[rows('g'.repeat(11))]}", "{layers:[rows('')]}",
                     "{layers:[rows('g'.repeat(12)).slice(0,11)]}", "{layers:[[...rows('g'.repeat(12)),'g'.repeat(12)]]}"]:
            self.assertFalse(self.v(expr)["ok"], expr)

    def test_should_reject_zero_or_seven_layers(self):
        self.assertFalse(self.v("{layers:[]}")["ok"])
        self.assertFalse(self.v("{layers:Array(7).fill(rows('g'.repeat(12)))}")["ok"])
        self.assertTrue(self.v("{layers:Array(6).fill(rows('g'.repeat(12)))}")["ok"])

    def test_should_reject_empty_or_all_water_worlds(self):
        self.assertFalse(self.v("flat('.')")["ok"])
        self.assertFalse(self.v("flat('a')")["ok"])
        self.assertFalse(self.v("{layers:[rows('a'.repeat(12)),rows('.'.repeat(12))]}")["ok"])

    def test_should_accept_water_with_dry_land_on_top_of_it(self):
        self.assertTrue(self.v("{layers:[rows('a'.repeat(12)),rows('g'+'.'.repeat(11))]}")["ok"])

    def test_should_reject_non_string_rows_and_non_array_shapes(self):
        for expr in ["{layers:[rows(5)]}", "{layers:[[...Array(12)]]}", "{layers:'ggg'}", "{layers:{length:1}}", "{}", "{layers:[null]}", "{layers:[rows(['g'])]}"]:
            self.assertFalse(self.v(expr)["ok"], expr)

    def test_should_not_read_the_prototype_chain(self):
        self.assertFalse(run_js("out(B.validateBuild(Object.create(B.starterBuild())).ok)"))

    def test_should_never_throw_on_hostile_inputs(self):
        r = run_js(r"""
const deep={};let c=deep;for(let i=0;i<5000;i++){c.layers=[c={}]}
const loop={};loop.layers=[loop];
const boom=new Proxy({}, {get(){throw new Error('x')},has(){throw new Error('x')},getOwnPropertyDescriptor(){throw new Error('x')}});
const inputs=[null,undefined,0,NaN,'x',[],[1],true,()=>1,Symbol('s'),10n,deep,loop,boom,{layers:boom},{layers:[boom]},JSON.parse('{"__proto__":{"layers":[]}}'),'a'.repeat(1e6),{layers:[['g'.repeat(1e6)]]}];
let bad=0;for(const i of inputs){try{const r=B.validateBuild(i);if(r.ok!==false||!Array.isArray(r.errors)||!r.errors.length)bad++}catch(e){bad++}
 try{B.heightAt(i,1,1);B.topMaterial(i,1,1);B.describe(i);B.toSpec(i);B.pick(1,1,i,{tile:10,ox:0,oy:0});B.project(1,1,1,i)}catch(e){bad++}}
out(bad)""")
        self.assertEqual(r, 0)

    def test_should_cap_the_number_of_errors(self):
        r = run_js("out(B.validateBuild({layers:Array(6).fill(rows('x'))}).errors.length)")
        self.assertLessEqual(r, 10)


@unittest.skipUnless(NODE, "node not installed")
class StarterAndHeightTests(unittest.TestCase):
    def test_should_ship_a_pretty_valid_starter_in_the_engine(self):
        r = run_js("const s=E.defaultSpec('blocks');out([E.clientValidate(s).ok,s.template,B.validateBuild(s.build).ok,B.describe(s)])")
        self.assertTrue(r[0] and r[2])
        self.assertEqual(r[1], "blocks")
        self.assertIn("block world", r[3])

    def test_should_report_heights_and_top_materials(self):
        r = run_js("""const b={layers:[rows('d'.repeat(12)),rows('.'.repeat(12)).map((x,i)=>i===2?'..w.........':x)]};
 out([B.heightAt(b,0,0),B.heightAt(b,2,2),B.topMaterial(b,2,2),B.topMaterial(b,0,0),B.topMaterial(strip(),0,0),B.heightAt(strip(),0,0)])""")
        self.assertEqual(r, [1, 2, "w", "d", ".", 0])

    def test_should_count_height_by_the_highest_block_even_with_a_gap(self):
        self.assertEqual(run_js("out(B.heightAt({layers:[rows('.'.repeat(12)),rows('c'.repeat(12))]},3,3))"), 2)

    def test_should_return_zero_and_air_out_of_range_or_for_bad_args(self):
        r = run_js("const b=B.starterBuild();out([B.heightAt(b,-1,0),B.heightAt(b,12,0),B.heightAt(b,1.5,1),B.heightAt(b,'1','1'),B.heightAt(b,NaN,0),B.topMaterial(b,99,99),B.heightAt(null,1,1)])")
        self.assertEqual(r, [0, 0, 0, 0, 0, ".", 0])

    def test_should_describe_counts_and_handle_missing_build(self):
        r = run_js("out([B.describe(spec()),B.describe({}),B.describe(null),B.describe({build:flat('a')})])")
        self.assertIn("blocks", r[0])
        self.assertRegex(r[0], r"\d+ grass")
        self.assertEqual(r[1:], ["An empty block world."] * 3)

    def test_should_not_use_the_forbidden_name_or_dangerous_apis(self):
        src = BLOCKS.read_text()
        self.assertNotIn("minecraft", src.lower())
        self.assertNotIn("mojang", src.lower())
        for bad in ("innerHTML", "eval(", "new Function", "fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "document."):
            self.assertNotIn(bad, src)


@unittest.skipUnless(NODE, "node not installed")
class EngineIntegrationTests(unittest.TestCase):
    def test_should_list_blocks_as_a_template(self):
        self.assertIn("blocks", run_js("out(E.TEMPLATES)"))

    def test_should_require_a_valid_build_for_blocks_specs(self):
        for mut in ["delete s.build", "s.build={layers:[]}", "s.build=null", "s.build={layers:[rows('x')]}", "s.build=flat('a')"]:
            r = run_js(f"const s=spec();{mut};out(E.clientValidate(s))")
            self.assertFalse(r["ok"], mut)
            self.assertTrue(any(e.startswith("build:") for e in r["errors"]), mut)

    def test_should_drop_build_on_other_templates(self):
        r = run_js("const s=E.defaultSpec('catcher');s.build=B.starterBuild();out(E.clientValidate(s))")
        self.assertTrue(r["ok"])
        self.assertNotIn("build", r["spec"])

    def test_should_keep_a_clean_copy_of_build_in_the_validated_spec(self):
        self.assertTrue(run_js("const s=spec();const c=E.clientValidate(s).spec;s.build.layers[0][0]='zzzzzzzzzzzz';out(c.build.layers[0][0]==='............')"))

    def test_should_delegate_create_and_step_to_blocks(self):
        r = run_js("let st=E.create(spec(),1);const a=st.template;st=E.step(st,{dx:1},16);out([a,st.template,st.events.length>=0,st.hero.dir])")
        self.assertEqual(r[0], "blocks")
        self.assertEqual(r[1], "blocks")

    def test_should_show_block_count_changes_in_friendly_diff(self):
        r = run_js("const a=spec(),b=spec();b.build=B.edit(E.create(b,1),{op:'place',x:2,y:2,mat:'s'}).state.build;out([E.friendlyDiff(a,b),E.friendlyDiff(a,a)])")
        self.assertEqual(r[0], ["Blocks 188 -> 189"])
        self.assertEqual(r[1], [])

    def test_should_describe_reach_goal_for_blocks(self):
        rows_ = run_js("const s=spec(x=>{x.goal.kind='reach'});out(E.describe(s))")
        self.assertEqual([r["value"] for r in rows_ if r["label"] == "Goal"], ["Reach the flag"])


@unittest.skipUnless(NODE, "node not installed")
class CreateTests(unittest.TestCase):
    def test_should_create_a_playing_state_with_the_contract_shape(self):
        r = run_js("const st=B.create(spec(),7);out([st.v,st.template,st.status,st.t,st.score,st.lives,st.progress,Array.isArray(st.events),Object.keys(st.hero).slice(0,4),Array.isArray(st.items),Array.isArray(st.critters),Array.isArray(st.path),typeof st.rs])")
        self.assertEqual(r, [1, "blocks", "playing", 0, 0, 3, 0, True, ["x", "y", "z", "dir"], True, True, True, "number"])

    def test_should_refuse_invalid_specs(self):
        r = run_js("out([B.create(null,1).status,B.create({},1).status,B.create(spec(s=>{s.build={layers:[]}}),1).status,B.create(E.defaultSpec('catcher'),1).status,E.create(spec(s=>{delete s.build}),1).status])")
        self.assertEqual(r, ["invalid"] * 5)

    def test_should_put_exactly_target_good_items_for_score_goals(self):
        self.assertEqual(run_js("out(idx(B.create(spec(s=>{s.goal.target=7}),2),'good').length)"), 7)

    def test_should_place_only_as_many_items_as_free_cells(self):
        r = run_js("const s=spec(x=>{x.build=strip();x.goal.target=50});const st=B.create(s,1);out([idx(st,'good').length,st.need])")
        self.assertEqual(r, [11, 11])

    def test_should_place_everything_on_reachable_ground_never_on_the_hero(self):
        r = run_js("""let bad=0;for(const seed of [1,2,3,4,5,6,7,8,9,10]){const st=B.create(spec(s=>{s.goal.target=50;s.rules.spawnRate=5}),seed);
 const key=(o)=>o.x+','+o.y;const seen={};seen[key(st.hero)]=1;
 for(const o of st.items.concat(st.critters)){if(seen[key(o)])bad++;seen[key(o)]=1;if(B.heightAt(st.build,o.x,o.y)!==o.z)bad++;if(!st.reach.includes(o.y*12+o.x))bad++}}out(bad)""")
        self.assertEqual(r, 0)

    def test_should_never_strand_items_on_an_unreachable_island(self):
        # Two islands separated by void: everything must land on the hero's island.
        r = run_js("""const L=rows('.'.repeat(12)).map((x,i)=>i<12?'gggg....gggg':x);let bad=0;
 for(let seed=1;seed<30;seed++){const st=B.create(spec(s=>{s.build={layers:[L]};s.goal.target=50}),seed);const side=st.hero.x<6;
  for(const o of st.items.concat(st.critters))if((o.x<6)!==side)bad++}out(bad)""")
        self.assertEqual(r, 0)

    def test_should_put_the_flag_on_a_reachable_highest_cell(self):
        r = run_js("""let bad=0;for(let seed=1;seed<15;seed++){const st=B.create(spec(s=>{s.goal.kind='reach'}),seed);const f=idx(st,'flag');if(f.length!==1){bad++;continue}
 const best=Math.max(...st.reach.map(i=>B.heightAt(st.build,i%12,(i/12)|0)));if(f[0].z!==best||!st.reach.includes(f[0].y*12+f[0].x))bad++}out(bad)""")
        self.assertEqual(r, 0)

    def test_should_not_put_the_flag_on_an_unreachable_taller_tower(self):
        r = run_js("""const L=rows('.'.repeat(12));L[5]='gggg....gggg';const T=rows('.'.repeat(12));T[5]='.........ccc';
 const lay=[L,rows('.'.repeat(12)).map((x,i)=>i===5?'........cccc':x),rows('.'.repeat(12)).map((x,i)=>i===5?'........cccc':x)];
 const st=B.create(spec(s=>{s.build={layers:lay};s.goal.kind='reach'}),3);const f=idx(st,'flag')[0];out([st.hero.x<6,f.x<6])""")
        self.assertEqual(r[0], r[1])

    def test_should_place_a_few_bonus_items_and_no_flag_for_survive(self):
        r = run_js("const st=B.create(spec(s=>{s.goal.kind='survive'}),1);out([idx(st,'good').length,idx(st,'flag').length])")
        self.assertEqual(r, [3, 0])

    def test_should_spawn_the_requested_number_of_critters_away_from_the_hero(self):
        for n in (1, 3, 5):
            r = run_js(f"const st=B.create(spec(s=>{{s.rules.spawnRate={n}}}),4);out([st.critters.length,st.critters.every(c=>Math.abs(c.x-st.hero.x)+Math.abs(c.y-st.hero.y)>=4)])")
            self.assertEqual(r, [n, True])

    def test_should_start_on_dry_non_jelly_ground_when_possible(self):
        r = run_js("""let ok=true;for(let seed=1;seed<10;seed++){const st=B.create(spec(),seed);const m=B.topMaterial(st.build,st.hero.x,st.hero.y);if(m==='a'||m==='j')ok=false}out(ok)""")
        self.assertTrue(r)

    def test_should_scale_lives_from_rules(self):
        self.assertEqual(run_js("out([1,3,5].map(l=>B.create(spec(s=>{s.rules.lives=l}),1).lives))"), [1, 3, 5])

    def test_should_survive_a_one_cell_world(self):
        r = run_js("""const L=rows('.'.repeat(12));L[3]='...g........';
 for(const k of ['score','reach','survive']){const st=B.create(spec(s=>{s.build={layers:[L]};s.goal.kind=k}),1);let s2=st;for(let i=0;i<20;i++)s2=B.step(s2,{dx:1},16);}
 out(B.create(spec(s=>{s.build={layers:[L]}}),1).items.length)""")
        self.assertEqual(r, 0)


@unittest.skipUnless(NODE, "node not installed")
class MovementTests(unittest.TestCase):
    HEAD = "const mk=(layers,fn)=>{const st=B.create(spec(s=>{s.build={layers};s.rules.spawnRate=1;s.rules.speed=5;if(fn)fn(s)}),1);st.critters=[];st.items=[];st.hero.x=5;st.hero.y=5;st.hero.z=B.heightAt(st.build,5,5);return st};const go=(st,inp,n)=>{for(let i=0;i<(n||1);i++)st=B.step(st,inp,50);return st};"

    def js(self, body):
        return run_js(self.HEAD + body)

    def test_should_move_one_cell_per_move_and_respect_cooldown(self):
        r = self.js("let st=mk([strip().layers[0]]);st=B.step(st,{dx:1},16);const a=st.hero.x;st=B.step(st,{dx:1},16);const b=st.hero.x;st=go(st,{dx:1},3);out([a,b,st.hero.x>b,st.hero.dir])")
        self.assertEqual(r[:2], [6, 6])
        self.assertTrue(r[2])
        self.assertEqual(r[3], "e")

    def test_should_move_in_all_four_grid_directions(self):
        r = self.js("""const L=rows('g'.repeat(12));let out_=[];for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const st=B.step(mk([L]),{dx,dy},16);out_.push([st.hero.x-5,st.hero.y-5])}out(out_)""")
        self.assertEqual(r, [[1, 0], [-1, 0], [0, 1], [0, -1]])

    def test_should_not_leave_the_grid_or_enter_empty_columns(self):
        r = self.js("""let st=mk([strip().layers[0]]);st=go(st,{dy:1},4);const a=st.hero.y;st=go(st,{dx:1},40);const b=st.hero.x;st=go(st,{dx:-1},60);out([a,b,st.hero.x])""")
        self.assertEqual(r, [5, 11, 0])

    def test_should_block_a_rise_of_two_without_jump_and_allow_it_with_jump(self):
        r = self.js("""const mid=rows('.'.repeat(12)).map((x,i)=>i===5?'......s.....':x);const lay=[rows('g'.repeat(12)),mid,mid];
 const st=mk(lay);st.hero.x=6;st.hero.y=4;st.hero.z=1;
 const plain=B.step(st,{dy:1},16),jumped=B.step(st,{dy:1,jump:true},16);out([plain.hero.y,jumped.hero.y,jumped.hero.z,jumped.events.map(e=>e.type)])""")
        self.assertEqual(r, [4, 5, 3, ["jump"]])

    def test_should_allow_dropping_down_any_distance(self):
        r = self.js("""const tall=[rows('g'.repeat(12)),rows('g'.repeat(12)),rows('g'.repeat(12)).map((x,i)=>i===5?'.....g......':x),rows('g'.repeat(12)).map((x,i)=>i===5?'.....g......':x)];
 const st=mk(tall);const s2=B.step(st,{dx:1},16);out([st.hero.z,s2.hero.x,s2.hero.z])""")
        self.assertEqual(r, [4, 6, 2])

    def test_should_slow_down_in_water(self):
        r = self.js("""const lay=[rows('g'.repeat(12)).map((x,i)=>x),rows('.'.repeat(12))];const w=rows('g'.repeat(12)).map((x,i)=>i===5?'......aaaaaa':x);
 const dry=B.step(mk([rows('g'.repeat(12))]),{dx:1},16),wet=B.step(mk([w]),{dx:1},16);out([dry.hero.cd,wet.hero.cd])""")
        self.assertEqual(r[1], r[0] * 2 if r[0] else 0)
        self.assertEqual(r, [60, 120])

    def test_should_bounce_off_jelly_and_reach_higher_ground(self):
        r = self.js("""const jelly=rows('.'.repeat(12)).map((x,i)=>i===5?'......j.....':x),hi=rows('.'.repeat(12)).map((x,i)=>i===5?'.......s....':x);
 const lay=[rows('g'.repeat(12)),jelly,rows('.'.repeat(12)).map((x,i)=>i===5?'.......s....':x),rows('.'.repeat(12)).map((x,i)=>i===5?'.......s....':x),hi];
 let st=B.step(mk(lay),{dx:1},16);const first=st.hero.x;st=go(st,{dx:1},1);out([first,st.hero.x,st.events.map(e=>e.type),st.hero.z])""")
        self.assertEqual(r[0], 6)
        self.assertEqual(r[1], 6)  # still on cooldown after the bounce; the next move works
        st = self.js("""const jelly=rows('.'.repeat(12)).map((x,i)=>i===5?'......j.....':x);const lay=[rows('g'.repeat(12)),jelly,rows('.'.repeat(12)).map((x,i)=>i===5?'.......s....':x),rows('.'.repeat(12)).map((x,i)=>i===5?'.......s....':x),rows('.'.repeat(12)).map((x,i)=>i===5?'.......s....':x)];
 let st=B.step(mk(lay),{dx:1},16);const ev=st.events.map(e=>e.type);const z=st.hero.z;st=go(st,{dx:1},3);out([ev,z,st.hero.x,st.hero.z])""")
        self.assertEqual(st[0], ["step", "bounce"])
        self.assertEqual(st[1], 4)
        self.assertEqual(st[2], 7)

    def test_should_settle_back_down_after_hanging_in_the_air(self):
        r = self.js("""const jelly=rows('.'.repeat(12)).map((x,i)=>i===5?'......j.....':x);let st=B.step(mk([rows('g'.repeat(12)),jelly]),{dx:1},16);const hi=st.hero.z;st=go(st,{},20);out([hi,st.hero.z])""")
        self.assertEqual(r, [4, 2])

    def test_should_walk_to_a_tapped_cell_by_the_shortest_route(self):
        r = self.js("""let st=B.step(mk([rows('g'.repeat(12))]),{goTo:{x:8,y:5}},16);const len=st.path.length;st=go(st,{},40);out([len,st.hero.x,st.hero.y,st.path.length])""")
        self.assertEqual(r, [2, 8, 5, 0])

    def test_should_climb_automatically_along_a_goto_path(self):
        r = self.js("""const mid=rows('.'.repeat(12)).map((x,i)=>i===5?'......s.....':x);const lay=[rows('g'.repeat(12)),mid,mid];
 let st=B.step(mk(lay),{goTo:{x:6,y:5}},16);st=go(st,{},10);out([st.hero.x,st.hero.z])""")
        self.assertEqual(r, [6, 3])

    def test_should_cancel_a_goto_walk_on_any_direction_key(self):
        r = self.js("""let st=B.step(mk([rows('g'.repeat(12))]),{goTo:{x:11,y:5}},16);const had=st.path.length>0;st=B.step(st,{dy:1},16);out([had,st.path.length])""")
        self.assertEqual(r, [True, 0])

    def test_should_ignore_goto_to_unreachable_or_invalid_targets(self):
        r = self.js("""const L=rows('.'.repeat(12)).map((x,i)=>i===5?'gggg....gggg':x);const st=mk([L]);const res=[];
 for(const g of [{x:9,y:5},{x:0,y:0},{x:-1,y:5},{x:12,y:5},{x:1.5,y:5},{x:'3',y:5},{x:NaN,y:NaN},null,5,{},{x:5,y:5}]){const s=B.step(st,{goTo:g},16);res.push(s.path.length)}out(res)""")
        self.assertEqual(r, [0] * 11)

    def test_should_cap_goto_path_length(self):
        r = self.js("""let st=B.step(mk([rows('g'.repeat(12))]),{goTo:{x:0,y:0}},16);out(st.path.length>0&&st.path.length<=200)""")
        self.assertTrue(r)

    def test_should_survive_hostile_inputs_and_frame_times(self):
        r = self.js("""let st=mk([rows('g'.repeat(12))]);let ok=true;
 for(const inp of [null,undefined,5,'x',{dx:NaN,dy:Infinity,jump:'yes',goTo:5},{dx:1e9,dy:-1e9},{goTo:{x:1e9,y:-1e9}},{goTo:{x:{},y:[]}},[],JSON.parse('{"__proto__":{"dx":1}}'),Object.create({dx:1}),{goTo:new Proxy({}, {get(){throw 1}})}])
 for(const dt of [NaN,-5,1e9,Infinity,undefined,0,'x']){try{const n=B.step(st,inp,dt);if(!['playing','won','lost'].includes(n.status))ok=false;if(n.hero.x<0||n.hero.x>11)ok=false;st=n.status==='playing'?n:st}catch(e){ok=false}}
 out(ok)""")
        self.assertTrue(r)

    def test_should_clamp_a_huge_frame_so_nothing_teleports(self):
        r = self.js("""const st=B.step(mk([rows('g'.repeat(12))]),{dx:1},1e9);out(st.t)""")
        self.assertEqual(r, 50)

    def test_should_not_move_after_the_game_has_ended(self):
        r = self.js("""let st=mk([rows('g'.repeat(12))]);st.status='lost';const n=B.step(st,{dx:1},16);out(n===st)""")
        self.assertTrue(r)


@unittest.skipUnless(NODE, "node not installed")
class EditTests(unittest.TestCase):
    HEAD = "const st0=()=>{const st=B.create(spec(),1);return st};const fresh=st0();"

    def js(self, body):
        return run_js(self.HEAD + body)

    def test_should_place_a_block_on_top_of_a_column(self):
        r = self.js("const h=B.heightAt(fresh.build,1,1);const r=B.edit(fresh,{op:'place',x:1,y:1,mat:'s'});out([r.ok,B.heightAt(r.state.build,1,1)-B.heightAt(fresh.build,1,1),B.topMaterial(r.state.build,1,1),r.state.events])")
        self.assertTrue(r[0])
        self.assertEqual(r[1:3], [1, "s"])
        self.assertEqual(r[3], [{"type": "place", "x": 1, "y": 1, "z": 0}])

    def test_should_remove_the_top_block(self):
        r = self.js("const r=B.edit(fresh,{op:'remove',x:6,y:3});out([r.ok,B.heightAt(fresh.build,6,3),B.heightAt(r.state.build,6,3),r.state.events[0].type])")
        self.assertEqual(r, [True, 2, 1, "remove"])

    def test_should_add_a_new_layer_when_stacking_past_the_top_layer(self):
        r = self.js("let st={state:fresh};for(let i=0;i<6;i++)st=B.edit(st.state,{op:'place',x:8,y:8,mat:'b'});out([st.state.build.layers.length,B.heightAt(st.state.build,8,8),B.validateBuild(st.state.build).ok])")
        self.assertEqual(r[0], 6)
        self.assertTrue(r[2])

    def test_should_refuse_to_place_on_a_full_column(self):
        r = self.js("let s=fresh;for(let i=0;i<8;i++)s=B.edit(s,{op:'place',x:8,y:8,mat:'b'}).state;const r=B.edit(s,{op:'place',x:8,y:8,mat:'b'});out([r.ok,r.reason,B.heightAt(s.build,8,8),r.state===s])")
        self.assertEqual(r, [False, "full", 6, True])

    def test_should_refuse_out_of_bounds_and_bad_coordinates(self):
        r = self.js("""const res=[];for(const [x,y] of [[-1,0],[0,-1],[12,0],[0,12],[1.5,1],['1',1],[NaN,1],[null,1],[undefined,1],[1e9,1]]){const q=B.edit(fresh,{op:'place',x,y,mat:'s'});res.push([q.ok,q.reason,q.state===fresh])}out(res)""")
        for x in r:
            self.assertEqual(x, [False, "out-of-range", True])

    def test_should_refuse_bad_ops_materials_and_commands(self):
        r = self.js("""const res=[];for(const c of [{op:'place',x:1,y:1,mat:'.'},{op:'place',x:1,y:1,mat:'x'},{op:'place',x:1,y:1,mat:'gg'},{op:'place',x:1,y:1},{op:'place',x:1,y:1,mat:5},{op:'place',x:1,y:1,mat:''},{op:'burn',x:1,y:1},{x:1,y:1},null,5,'x',[]]){const q=B.edit(fresh,c);res.push(q.ok===false&&q.state===fresh&&typeof q.reason==='string')}out(res)""")
        self.assertTrue(all(r), r)

    def test_should_not_place_or_remove_on_the_hero_column(self):
        r = self.js("""const h=fresh.hero;const a=B.edit(fresh,{op:'place',x:h.x,y:h.y,mat:'s'}),b=B.edit(fresh,{op:'remove',x:h.x,y:h.y});out([a.ok,a.reason,b.ok,b.reason])""")
        self.assertEqual(r, [False, "hero-here", False, "hero-here"])

    def test_should_refuse_to_remove_from_an_empty_column(self):
        self.assertEqual(self.js("const r=B.edit(fresh,{op:'remove',x:0,y:11});out([r.ok,r.reason])"), [False, "empty"])

    def test_should_refuse_to_remove_the_last_block(self):
        r = run_js("""const L=rows('.'.repeat(12));L[2]='...g........';const st=B.create(spec(s=>{s.build={layers:[L]}}),1);st.hero.x=0;st.hero.y=0;
 const q=B.edit(st,{op:'remove',x:3,y:2});out([q.ok,q.reason,q.state===st])""")
        self.assertEqual(r, [False, "last-block", True])

    def test_should_refuse_an_edit_that_would_leave_only_water(self):
        r = run_js("""const L=rows('.'.repeat(12));L[2]='...ga.......';const st=B.create(spec(s=>{s.build={layers:[L]}}),1);st.hero.x=4;st.hero.y=2;
 const q=B.edit(st,{op:'remove',x:3,y:2}),p=B.edit(st,{op:'place',x:3,y:2,mat:'a'});out([q.ok,q.reason,p.ok,p.reason])""")
        self.assertEqual(r, [False, "needs-land", False, "needs-land"])

    def test_should_move_items_and_critters_with_their_column(self):
        r = self.js("""const i=fresh.items[0],c=fresh.critters[0];let s=B.edit(fresh,{op:'place',x:i.x,y:i.y,mat:'s'}).state;s=B.edit(s,{op:'place',x:c.x,y:c.y,mat:'s'}).state;
 const i2=s.items.find(o=>o.id===i.id),c2=s.critters.find(o=>o.id===c.id);out([i2.z-i.z,c2.z-c.z,i2.z===B.heightAt(s.build,i2.x,i2.y),c2.z===B.heightAt(s.build,c2.x,c2.y)])""")
        self.assertEqual(r, [1, 1, True, True])

    def test_should_not_empty_a_column_that_holds_an_item(self):
        r = run_js("""const L=rows('.'.repeat(12));L[2]='.g..........';L[3]='gg..........';const st=B.create(spec(s=>{s.build={layers:[L]};s.goal.target=3}),1);
 const it=st.items[0];const q=B.edit(st,{op:'remove',x:it.x,y:it.y});out([q.ok,q.reason])""")
        self.assertEqual(r, [False, "occupied"])

    def test_should_clear_a_walk_in_progress_after_an_edit(self):
        r = self.js("""let s=B.step(fresh,{goTo:{x:2,y:2}},16);const had=s.path.length;s=B.edit(s,{op:'place',x:0,y:3,mat:'s'}).state;out([had>0,s.path.length])""")
        self.assertEqual(r, [True, 0])

    def test_should_never_mutate_the_state_it_was_given(self):
        r = self.js("""const snap=JSON.stringify(fresh);B.edit(fresh,{op:'place',x:1,y:1,mat:'s'});B.edit(fresh,{op:'remove',x:2,y:2});B.edit(fresh,{op:'zzz'});out(JSON.stringify(fresh)===snap)""")
        self.assertTrue(r)

    def test_should_give_a_valid_spec_with_the_edited_build_to_save(self):
        r = self.js("""const s=B.edit(fresh,{op:'place',x:1,y:1,mat:'p'}).state;const sp=B.toSpec(s);out([E.clientValidate(sp).ok,B.heightAt(sp.build,1,1),B.heightAt(spec().build,1,1),sp.title])""")
        self.assertTrue(r[0])
        self.assertEqual(r[1], r[2] + 1)
        self.assertEqual(r[3], "Sky Island")

    def test_should_return_null_from_tospec_for_invalid_state(self):
        r = run_js("out([B.toSpec(null),B.toSpec({}),B.toSpec(B.create({},1)),B.toSpec({spec:{},build:flat('a')})])")
        self.assertEqual(r, [None] * 4)

    def test_should_trim_empty_top_layers_after_removal(self):
        r = self.js("""let s=B.edit(fresh,{op:'place',x:8,y:8,mat:'b'}).state;const n=s.build.layers.length;for(let i=0;i<9;i++)s=B.edit(s,{op:'remove',x:8,y:8}).state;out([n>=1,B.validateBuild(s.build).ok])""")
        self.assertTrue(all(r))


@unittest.skipUnless(NODE, "node not installed")
class PlayTests(unittest.TestCase):
    def test_should_win_a_score_goal_by_collecting_every_item(self):
        for seed in (1, 7, 42):
            r = run_js(f"const st=sim(spec(s=>{{s.rules.lives=5;s.rules.spawnRate=1}}),{seed},BOTS.collect,120000);out([st.status,st.score,st.need,st.progress])")
            self.assertEqual(r, ["won", 5, 5, 1], seed)

    def test_should_win_a_reach_goal_by_getting_to_the_flag(self):
        for seed in (1, 7, 42):
            r = run_js(f"const st=sim(spec(s=>{{s.rules.lives=5;s.rules.spawnRate=1;s.goal.kind='reach'}}),{seed},BOTS.flag,120000);out([st.status,st.progress])")
            self.assertEqual(r, ["won", 1], seed)

    def test_should_win_a_survive_goal_by_lasting_long_enough(self):
        r = run_js("const st=sim(spec(s=>{s.rules.lives=5;s.goal.kind='survive';s.goal.target=3}),3,BOTS.idle,60000);out([st.status,st.t>=3000,st.progress])")
        self.assertEqual(r, ["won", True, 1])

    def test_should_lose_every_goal_kind_by_bumping_critters(self):
        for kind in ("score", "reach", "survive"):
            for seed in (1, 7):
                r = run_js(f"const st=sim(spec(s=>{{s.rules.lives=1;s.rules.spawnRate=5;s.goal.kind='{kind}';s.goal.target=50}}),{seed},BOTS.chase,120000,st=>{{if('{kind}'==='reach')st.items=[]}});out([st.status,st.lives,st.msg])")
                self.assertEqual(r[:2], ["lost", 0], (kind, seed))
                self.assertEqual(r[2], "The slimes wobbled you away. Try again!")

    def test_should_lose_a_life_per_bump_with_a_grace_period(self):
        r = run_js("""let st=B.create(spec(s=>{s.rules.lives=3}),1);st.critters=[{id:99,x:st.hero.x,y:st.hero.y,z:st.hero.z,cd:99999}];
 st=B.step(st,{},16);const a=st.lives,ev=st.events.map(e=>e.type);st.critters[0].x=st.hero.x;st.critters[0].y=st.hero.y;st=B.step(st,{},16);out([a,st.lives,ev,st.hero.inv>0])""")
        self.assertEqual(r[0], 2)
        self.assertEqual(r[1], 2)
        self.assertEqual(r[2], ["bad"])
        self.assertTrue(r[3])

    def test_should_emit_good_and_win_events(self):
        r = run_js("""let st=B.create(spec(s=>{s.goal.target=3}),1);st.items=st.items.slice(0,1);st.need=1;st.items[0].x=st.hero.x+1;st.items[0].y=st.hero.y;st.items[0].z=B.heightAt(st.build,st.hero.x+1,st.hero.y);st.critters=[];
 st=B.step(st,{dx:1},16);out([st.score,st.events.map(e=>e.type),st.status])""")
        self.assertEqual(r[0], 1)
        self.assertEqual(r[1], ["step", "good", "win"])
        self.assertEqual(r[2], "won")

    def test_should_clear_events_each_step(self):
        r = run_js("let st=B.step(B.create(spec(),1),{dx:1},16);const a=st.events.length;st=B.step(st,{},16);out([a>0,st.events.length])")
        self.assertEqual(r, [True, 0])

    def test_should_report_progress_between_0_and_1(self):
        r = run_js("""let ok=true;for(const k of ['score','reach','survive']){let st=B.create(spec(s=>{s.goal.kind=k;s.rules.lives=5}),2);for(let i=0;i<400;i++){st=B.step(st,BOTS.collect(st)||{},16);if(!(st.progress>=0&&st.progress<=1))ok=false}}out(ok)""")
        self.assertTrue(r)

    def test_should_be_deterministic_for_same_spec_seed_and_inputs(self):
        r = run_js("const a=sim(spec(),9,BOTS.collect,9000),b=sim(spec(),9,BOTS.collect,9000);out(JSON.stringify(a)===JSON.stringify(b))")
        self.assertTrue(r)

    def test_should_differ_between_seeds(self):
        self.assertTrue(run_js("out(JSON.stringify(B.create(spec(),1).items)!==JSON.stringify(B.create(spec(),2).items))"))

    def test_should_not_mutate_the_previous_state(self):
        r = run_js("""let s=B.create(spec(),5);for(let i=0;i<30;i++)s=B.step(s,{dx:1,jump:true},16);const snap=JSON.stringify(s);const n=B.step(s,{dx:-1,dy:1,goTo:{x:3,y:3},jump:true},50);out([JSON.stringify(s)===snap,n!==s])""")
        self.assertEqual(r, [True, True])

    def test_should_keep_critters_on_walkable_slopes(self):
        r = run_js("""let st=B.create(spec(s=>{s.rules.spawnRate=5}),3),ok=true;for(let i=0;i<600;i++){st=B.step(st,{},50);for(const c of st.critters){const h=B.heightAt(st.build,c.x,c.y);if(h===0||c.z!==h)ok=false}}out(ok)""")
        self.assertTrue(r)

    def test_should_do_bounded_work_per_step(self):
        r = run_js("""let st=B.create(spec(),1);const t=Date.now();for(let i=0;i<2000;i++)st=B.step(st,{goTo:{x:i%12,y:(i*7)%12}},16);out(Date.now()-t<4000)""")
        self.assertTrue(r)


@unittest.skipUnless(NODE, "node not installed")
class ProjectionTests(unittest.TestCase):
    def test_should_use_classic_two_to_one_isometric_axes(self):
        r = run_js("const v={tile:64,ox:100,oy:50};out([B.project(0,0,0,v),B.project(1,0,0,v),B.project(0,1,0,v),B.project(0,0,1,v)])")
        self.assertEqual(r[0], {"sx": 100, "sy": 50})
        self.assertEqual(r[1], {"sx": 132, "sy": 66})    # +x = down-right
        self.assertEqual(r[2], {"sx": 68, "sy": 66})     # +y = down-left
        self.assertEqual(r[3], {"sx": 100, "sy": 18})    # +z = up, tile/2 per level

    def test_should_invert_project_with_pick_on_every_block_centre(self):
        r = run_js("""let bad=0,n=0;
 for(const t of [8,17.3,64,100.7,333]){const v={tile:t,ox:37.5,oy:-12.25};
  for(let z=0;z<6;z++)for(let y=0;y<12;y++)for(let x=0;x<12;x++){const L=Array.from({length:6},()=>rows('.'.repeat(12)));L[z]=L[z].map((r,i)=>i===y?r.slice(0,x)+'g'+r.slice(x+1):r);
   const p=B.project(x,y,z,v),q=B.pick(p.sx,p.sy,{layers:L},v);n++;if(!q||q.x!==x||q.y!==y||q.z!==z||q.face!=='top')bad++}}
 out([bad,n])""")
        self.assertEqual(r, [0, 5 * 6 * 144])

    def test_should_pick_the_front_most_block_in_a_full_world(self):
        r = run_js("""const L=Array.from({length:3},()=>rows('g'.repeat(12)));const v={tile:64,ox:0,oy:0};
 const p=B.project(5,5,2,v),q=B.pick(p.sx,p.sy-8,{layers:L},v),c=B.project(11,11,2,v);out([q,B.pick(c.sx,c.sy,{layers:L},v)])""")
        self.assertEqual((r[0]["x"], r[0]["y"], r[0]["z"]), (5, 5, 2))
        self.assertEqual((r[1]["x"], r[1]["y"], r[1]["z"]), (11, 11, 2))

    def test_should_resolve_ties_towards_the_block_in_front(self):
        r = run_js("""const L=[rows('g'.repeat(12)),rows('g'.repeat(12))];const v={tile:64,ox:0,oy:0};
 const p=B.project(4,4,0,v),q=B.pick(p.sx,p.sy,{layers:L},v);out([q.x+q.y+q.z>=8])""")
        self.assertEqual(r, [True])

    def test_should_report_the_face_that_was_hit(self):
        r = run_js("""const b={layers:[rows('.'.repeat(12)).map((r,i)=>i===5?'...g........':r)]};const v={tile:64,ox:0,oy:0};const c=B.project(3,5,0,v);
 out([B.pick(c.sx,c.sy-10,b,v).face,B.pick(c.sx-20,c.sy+12,b,v).face,B.pick(c.sx+20,c.sy+12,b,v).face])""")
        self.assertEqual(r, ["top", "left", "right"])

    def test_should_return_null_when_nothing_is_under_the_pixel(self):
        r = run_js("const v={tile:64,ox:0,oy:0};out([B.pick(5000,5000,strip(),v),B.pick(0,0,strip(),v)])")
        self.assertEqual(r, [None, None])

    def test_should_return_null_for_bad_views_and_pixels(self):
        r = run_js("""const b=B.starterBuild(),res=[];for(const v of [null,{},{tile:0,ox:0,oy:0},{tile:-5,ox:0,oy:0},{tile:NaN,ox:0,oy:0},{tile:64,ox:'a',oy:0},{tile:64}])res.push(B.pick(1,1,b,v));
 for(const [x,y] of [[NaN,1],[1,Infinity],['1',1],[null,1]])res.push(B.pick(x,y,b,{tile:64,ox:0,oy:0}));out(res)""")
        self.assertEqual(r, [None] * 11)

    def test_should_still_project_with_a_bad_view_without_throwing(self):
        r = run_js("out([B.project(1,1,1,null),B.project('a',NaN,{},undefined),B.project(1,1,1,{tile:Infinity,ox:1,oy:1})].every(p=>typeof p.sx==='number'&&typeof p.sy==='number'))")
        self.assertTrue(r)


if __name__ == "__main__":
    unittest.main()
