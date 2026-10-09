"""Block Builder 3D world (AIXVoxel): generation, plot, walking, physics, raycast, place/break, critters, gems, time of day,
chunk geometry, hostile inputs and a source scan (node)."""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOXEL = ROOT / "ui" / "vg-aix-voxel.js"
BLOCKS = ROOT / "ui" / "vg-aix-blocks.js"
ENGINE = ROOT / "ui" / "vg-aix-engine.js"
NODE = shutil.which("node")

PRELUDE = r"""
const V=require(%s),B=require(%s),E=require(%s);
const out=(x)=>console.log(JSON.stringify(x));
const spec=(terrain,seed,build)=>{const s=E.defaultSpec('blocks');if(terrain)s.world.terrain=terrain;if(seed!==undefined)s.world.seed=seed;if(build)s.build=build;return s};
const world=(terrain,seed,build)=>V.generate(spec(terrain,seed,build));
const empty=()=>({v:1,data:new Uint8Array(48*48*24),seed:1,terrain:'meadow',plotDirty:false});
// a flat stone floor at z=0..4 so tests can stand on it, plot untouched
const flat=()=>{const w=empty();for(let y=0;y<48;y++)for(let x=0;x<48;x++)for(let z=0;z<=4;z++)w.data[(z*48+y)*48+x]=3;return w};
const P=(o)=>Object.assign({x:5.5,y:5.5,z:5,vx:0,vy:0,vz:0,yaw:0,pitch:0,onGround:false,inWater:false},o);
const run=(p,inp,w,frames,dt)=>{for(let i=0;i<frames;i++)p=V.physics(p,typeof inp==='function'?inp(i,p):inp,w,dt===undefined?16:dt);return p};
const hash=(w)=>{let h=2166136261;for(let i=0;i<w.data.length;i++){h^=w.data[i];h=Math.imul(h,16777619)>>>0}return h};
const TERR=['meadow','desert','snow','island','candy'];
// Independent flood fill (written for the test): stand = dry, 2 free cells, solid below. Step up 1 (with headroom), drop up to 3.
function flood(w,sx,sy,sz){
  const sol=(x,y,z)=>V.BLOCKS[V.get(w,x,y,z)].solid&&x>=0&&y>=0&&x<48&&y<48&&z>=0;
  const wet=(x,y,z)=>V.get(w,x,y,z)===7;
  const stand=(x,y,z)=>x>=0&&y>=0&&x<48&&y<48&&z>=1&&z<22&&!sol(x,y,z)&&!sol(x,y,z+1)&&!wet(x,y,z)&&!wet(x,y,z+1)&&sol(x,y,z-1);
  const seen=new Set(),key=(x,y,z)=>x+','+y+','+z,q=[[sx,sy,sz]];
  if(!stand(sx,sy,sz))return seen;seen.add(key(sx,sy,sz));
  for(let i=0;i<q.length;i++){const [x,y,z]=q[i];
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy;
      for(const dz of [1,0,-1,-2,-3]){const nz=z+dz;if(dz===1&&sol(x,y,z+2))continue;
        if(dz<0){let ok=true;for(let zz=nz;zz<=z+1;zz++)if(sol(nx,ny,zz))ok=false;if(!ok)continue}
        if(stand(nx,ny,nz)){if(!seen.has(key(nx,ny,nz))){seen.add(key(nx,ny,nz));q.push([nx,ny,nz])}break}}}}
  return seen;
}
""" % (json.dumps(str(VOXEL)), json.dumps(str(BLOCKS)), json.dumps(str(ENGINE)))


def run_js(body):
    p = subprocess.run([NODE, "-e", PRELUDE + body], capture_output=True, text=True)
    if p.returncode:
        raise AssertionError("node failed: " + p.stderr[-900:])
    return json.loads(p.stdout)


@unittest.skipUnless(NODE, "node not installed")
class ContractTests(unittest.TestCase):
    def test_should_expose_the_contract_constants(self):
        r = run_js("out([V.WX,V.WY,V.WZ,V.PLOT,V.CHUNK,V.chunkKey(1,2,3),V.BLOCKS[0].char,V.BLOCKS.length,V.TERRAINS])")
        self.assertEqual(r[:5], [48, 48, 24, {"x0": 18, "y0": 18, "size": 12, "base": 8}, 16])
        self.assertEqual(r[5], "1,2,3")
        self.assertEqual(r[6], ".")
        self.assertEqual(r[8], ["meadow", "desert", "snow", "island", "candy"])

    def test_should_reuse_the_plot_alphabet_ids_and_describe_every_block(self):
        r = run_js("out([...B.ALPHABET].map((c,i)=>V.BLOCKS[i].char===c&&(i===0||V.BLOCKS[i].name.length>0)))")
        self.assertTrue(all(r))
        r = run_js("out(V.BLOCKS.every(b=>Number.isInteger(b.top)&&Number.isInteger(b.side)&&Number.isInteger(b.bottom)&&b.top<V.TILES.length&&typeof b.solid==='boolean'&&typeof b.see==='boolean'))")
        self.assertTrue(r)
        names = run_js("out(['snow','cactus','trunk','flowerRed','flowerYellow','tallGrass','cobble'].map(n=>V.BLOCKS[V.ID[n]].name))")
        self.assertEqual(len(names), 7)

    def test_should_treat_water_glass_leaves_and_plants_as_see_through(self):
        r = run_js("out([V.ID.water,V.ID.glass,V.ID.leaves,V.ID.tallGrass].map(i=>V.BLOCKS[i].see))")
        self.assertEqual(r, [True] * 4)
        self.assertEqual(run_js("out([V.BLOCKS[V.ID.water].solid,V.BLOCKS[V.ID.flowerRed].solid,V.BLOCKS[V.ID.stone].solid])"), [False, False, True])


@unittest.skipUnless(NODE, "node not installed")
class GenerationTests(unittest.TestCase):
    def test_should_be_deterministic_for_the_same_spec_and_differ_by_seed_and_terrain(self):
        r = run_js("out([hash(world('meadow',5))===hash(world('meadow',5)),hash(world('meadow',5))!==hash(world('meadow',6)),hash(world('meadow',5))!==hash(world('desert',5))])")
        self.assertEqual(r, [True, True, True])

    def test_should_return_the_documented_world_shape(self):
        r = run_js("const w=world('snow',77);out([w.v,w.data.length,w.seed,w.terrain,w.plotDirty,w.data instanceof Uint8Array])")
        self.assertEqual(r, [1, 48 * 48 * 24, 77, "snow", False, True])

    def test_should_fall_back_to_meadow_seed_one_and_the_starter_for_garbage_specs(self):
        r = run_js("""const a=V.generate(null),b=V.generate({world:{terrain:'lava',seed:'x'},build:{layers:'no'}}),c=V.generate(spec('meadow',1));
        out([a.terrain,a.seed,b.terrain,b.seed,hash(a)===hash(c),hash(b)===hash(c)])""")
        self.assertEqual(r, ["meadow", 1, "meadow", 1, True, True])

    def test_should_clamp_the_seed(self):
        r = run_js("out([V.generate({world:{seed:99999999}}).seed,V.generate({world:{seed:-4}}).seed,V.generate({world:{seed:12.6}}).seed])")
        self.assertEqual(r, [999999, 0, 13])

    def test_should_copy_the_build_into_the_plot_and_level_the_ground(self):
        r = run_js("""const out2=[];
        for(const t of TERR){const sp=spec(t,3),w=V.generate(sp),b=sp.build;let same=true,ground=true,above=true;
          for(let k=0;k<b.layers.length;k++)for(let y=0;y<12;y++)for(let x=0;x<12;x++){
            const id=V.get(w,18+x,18+y,8+k);if(id!==B.ALPHABET.indexOf(b.layers[k][y][x]))same=false}
          for(let y=0;y<12;y++)for(let x=0;x<12;x++){const t0=V.get(w,18+x,18+y,7);if(!V.BLOCKS[t0].solid||V.get(w,18+x,18+y,0)!==3)ground=false;
            for(let z=8+b.layers.length;z<24;z++)if(V.get(w,18+x,18+y,z)!==0)above=false}
          out2.push([t,same,ground,above])}
        out(out2)""")
        for row in r:
            self.assertEqual(row[1:], [True, True, True], row)

    def test_should_use_a_terrain_matching_plot_surface(self):
        r = run_js("out(TERR.map(t=>V.get(world(t,2),18,18,7)))")
        self.assertEqual(r, [1, 8, 13, 1, 11])  # grass, sand, snow, grass, candy

    def test_should_make_terrain_with_the_expected_features(self):
        r = run_js("""const count=(w,id)=>{let n=0;for(let i=0;i<w.data.length;i++)if(w.data[i]===id)n++;return n};
        const m=world('meadow',1),d=world('desert',1),s=world('snow',1),i=world('island',1),c=world('candy',1);
        out({mTrunk:count(m,15)>0,mLeaf:count(m,5)>0,mFlower:count(m,16)+count(m,17)>0,mGrass:count(m,18)>0,mWater:count(m,7)>0,
             dCactus:count(d,14)>0,dSand:count(d,8)>count(d,1)*50+1,
             sSnow:count(s,13)>200,iWater:count(i,7)>800,iSand:count(i,8)>50,cCandy:count(c,11)>200,cCloud:count(c,10)>200})""")
        self.assertTrue(all(r.values()), r)

    def test_should_keep_hills_between_four_and_fourteen_for_the_ground(self):
        r = run_js("""const hs=[];for(const t of ['meadow','desert'])for(const sd of [1,9,33]){const w=world(t,sd);let mn=99,mx=0;
        for(let y=0;y<48;y++)for(let x=0;x<48;x++){for(let z=23;z>=0;z--){const id=V.get(w,x,y,z);if(id&&![5,15,14,16,17,18].includes(id)){mn=Math.min(mn,z);mx=Math.max(mx,z);break}}}hs.push([mn,mx])}out(hs)""")
        for mn, mx in r:
            self.assertGreaterEqual(mn, 4)
            self.assertLessEqual(mx, 14)

    def test_should_fill_every_empty_cell_below_sea_level_with_water_only_on_top_of_ground(self):
        r = run_js("""const w=world('island',4);let bad=0;for(let y=0;y<48;y++)for(let x=0;x<48;x++)for(let z=1;z<6;z++)if(V.get(w,x,y,z)===7&&!V.BLOCKS[V.get(w,x,y,z-1)].solid&&V.get(w,x,y,z-1)!==7)bad++;out(bad)""")
        self.assertEqual(r, 0)

    def test_should_be_fast_enough(self):
        r = run_js("""V.generate(spec());const t0=process.hrtime.bigint();for(let i=0;i<5;i++)V.generate(spec('meadow',i));out(Number(process.hrtime.bigint()-t0)/5e6)""")
        self.assertLess(r, 100)

    def test_should_never_throw_on_hostile_specs(self):
        r = run_js("""let n=0;for(const s of [undefined,null,0,'x',[],{},{world:null},{world:[]},{build:5},{world:{terrain:{},seed:{}},build:{layers:[1,2]}},Object.create(null)]){try{V.generate(s);n++}catch(e){}}out(n)""")
        self.assertEqual(r, 11)


@unittest.skipUnless(NODE, "node not installed")
class AccessAndPlotTests(unittest.TestCase):
    def test_should_get_zero_outside_the_world_and_for_junk(self):
        r = run_js("const w=world();out([V.get(w,-1,0,0),V.get(w,48,0,0),V.get(w,0,0,24),V.get(w,NaN,0,0),V.get(null,1,1,1),V.get(w,'a',0,0),V.get(w,0,0,0)])")
        self.assertEqual(r, [0, 0, 0, 0, 0, 0, 3])

    def test_should_set_with_bounds_and_type_checks(self):
        r = run_js("const w=world();out([V.set(w,1,1,20,3),V.set(w,-1,1,1,3),V.set(w,1,1,1.5,3),V.set(w,1,1,20,99),V.set(w,1,1,20,'3'),V.set(null,1,1,1,3),V.get(w,1,1,20)])")
        self.assertEqual(r[0], {"ok": True})
        for i in range(1, 6):
            self.assertFalse(r[i]["ok"], i)
            self.assertTrue(r[i]["reason"])
        self.assertEqual(r[6], 3)

    def test_should_mark_plot_dirty_only_for_saved_plot_cells(self):
        r = run_js("""const w=world();const d=[];V.set(w,2,2,12,3);d.push(w.plotDirty);V.set(w,20,20,7,3);d.push(w.plotDirty);V.set(w,20,20,20,3);d.push(w.plotDirty);
        V.set(w,20,20,9,V.get(w,20,20,9));d.push(w.plotDirty);V.set(w,20,20,13,3);d.push(w.plotDirty);out(d)""")
        self.assertEqual(r, [False, False, False, False, True])

    def test_should_round_trip_the_plot_through_validate_build(self):
        r = run_js("""const sp=spec('meadow',1),w=V.generate(sp),b=V.plotToBuild(w),v=B.validateBuild(b);out([v.ok,JSON.stringify(b)===JSON.stringify(B.validateBuild(sp.build).build)])""")
        self.assertEqual(r, [True, True])

    def test_should_reflect_edits_in_plot_to_build(self):
        r = run_js("""const w=world();V.set(w,18,18,13,V.ID.brick);V.set(w,19,18,13,V.ID.snow);const b=V.plotToBuild(w);out([B.validateBuild(b).ok,b.layers.length,b.layers[5][0].slice(0,2)])""")
        self.assertEqual(r, [True, 6, "bc"])

    def test_should_trim_empty_top_layers_and_return_null_when_nothing_left(self):
        r = run_js("""const w=world();const b=V.plotToBuild(w);for(let k=0;k<6;k++)for(let y=0;y<12;y++)for(let x=0;x<12;x++)V.set(w,18+x,18+y,8+k,0);out([b.layers.length,V.plotToBuild(w),V.plotToBuild(null),V.plotToBuild({})])""")
        self.assertEqual(r[1:], [None, None, None])

    def test_should_return_null_when_only_water_is_left_to_stand_on(self):
        r = run_js("""const w=world();for(let k=0;k<6;k++)for(let y=0;y<12;y++)for(let x=0;x<12;x++)V.set(w,18+x,18+y,8+k,0);V.set(w,20,20,8,V.ID.water);out(V.plotToBuild(w))""")
        self.assertIsNone(r)

    def test_heightmap_reports_top_solid_plus_one(self):
        r = run_js("const w=flat();w.data[(10*48+3)*48+3]=3;const h=V.heightmap(w);out([h[0],h[3*48+3],h.length])")
        self.assertEqual(r, [5, 11, 48 * 48])


@unittest.skipUnless(NODE, "node not installed")
class SpawnAndReachTests(unittest.TestCase):
    def test_spawn_should_be_dry_free_and_next_to_the_plot_on_every_terrain(self):
        r = run_js("""const res=[];for(const t of TERR)for(const sd of [1,2,3,999]){const w=world(t,sd),s=V.spawn(w),x=Math.floor(s.x),y=Math.floor(s.y),z=Math.floor(s.z);
          const dx=Math.max(18-x,0,x-29),dy=Math.max(18-y,0,y-29);
          res.push([t,sd,V.get(w,x,y,z)===0,V.get(w,x,y,z+1)===0,V.BLOCKS[V.get(w,x,y,z-1)].solid,V.get(w,x,y,z)!==7,Math.hypot(dx,dy)<=14])}out(res)""")
        for row in r:
            self.assertEqual(row[2:], [True] * 5, row)

    def test_spawn_should_open_onto_a_big_walkable_region(self):
        r = run_js("""const res=[];for(const t of TERR){const w=world(t,5),s=V.spawn(w);res.push(flood(w,Math.floor(s.x),Math.floor(s.y),Math.floor(s.z)).size)}out(res)""")
        for n in r:
            self.assertGreater(n, 400)

    def test_gems_should_be_exactly_the_target_and_reachable_on_foot(self):
        r = run_js("""const res=[];for(const t of TERR)for(const target of [3,5,12]){const sp=spec(t,11);sp.goal={kind:'score',target};const w=V.generate(sp),s=V.spawn(w),reach=flood(w,Math.floor(s.x),Math.floor(s.y),Math.floor(s.z)),g=V.gems(w,sp,1);
          const uniq=new Set(g.map(p=>p.x+','+p.y+','+p.z)).size;
          res.push([t,target,g.length,uniq,g.every(p=>reach.has(p.x+','+p.y+','+p.z)),g.every(p=>{const dx=Math.max(18-p.x,0,p.x-29),dy=Math.max(18-p.y,0,p.y-29);return Math.hypot(dx,dy)<=20&&!(dx===0&&dy===0)})])}out(res)""")
        for t, target, n, uniq, reach, near in r:
            self.assertEqual(n, target, (t, target))
            self.assertEqual(uniq, n)
            self.assertTrue(reach, (t, target))
            self.assertTrue(near, (t, target))

    def test_gems_should_be_deterministic_and_vary_by_seed(self):
        r = run_js("const w=world('meadow',3),sp=spec('meadow',3);out([JSON.stringify(V.gems(w,sp,1))===JSON.stringify(V.gems(w,sp,1)),JSON.stringify(V.gems(w,sp,1))!==JSON.stringify(V.gems(w,sp,2))])")
        self.assertEqual(r, [True, True])

    def test_collect_should_take_only_gems_within_the_radius(self):
        r = run_js("""const gs=[{x:10,y:10,z:5},{x:20,y:20,z:5}],c=V.collect({x:10.5,y:10.5,z:5},gs),n=V.collect({x:10.5,y:12.5,z:5},gs);out([c.got,c.gems.length,n.got,n.gems.length,gs.length])""")
        self.assertEqual(r, [1, 1, 0, 2, 2])

    def test_collect_should_survive_junk(self):
        r = run_js("out([V.collect(null,null),V.collect({x:NaN,y:1,z:1},[{x:1,y:1,z:1}]),V.collect({x:1,y:1,z:1},[null,{x:'a'}]).got])")
        self.assertEqual(r[0], {"gems": [], "got": 0})
        self.assertEqual(r[1]["got"], 0)
        self.assertEqual(r[2], 0)


@unittest.skipUnless(NODE, "node not installed")
class PhysicsTests(unittest.TestCase):
    def test_gravity_should_land_the_player_on_the_floor(self):
        r = run_js("const p=run(P({z:12}),{},flat(),120);out([p.z,p.onGround,p.vz])")
        self.assertAlmostEqual(r[0], 5, places=3)
        self.assertTrue(r[1])
        self.assertEqual(r[2], 0)

    def test_should_not_tunnel_through_the_floor_at_the_largest_frame(self):
        r = run_js("const p=run(P({z:20,vz:-40}),{},flat(),60,50);out(p.z)")
        self.assertAlmostEqual(r, 5, places=3)

    def test_should_walk_forward_and_strafe_with_the_documented_axes(self):
        r = run_js("""const w=flat(),f=run(P({onGround:true}),{mz:1},w,30),s=run(P({onGround:true}),{mx:1},w,30),b=run(P({onGround:true}),{mz:-1},w,30);
        out([f.y<5.5-1,Math.abs(f.x-5.5)<0.01,s.x>5.5+1,Math.abs(s.y-5.5)<0.01,b.y>5.5+1])""")
        self.assertEqual(r, [True] * 5)

    def test_yaw_should_turn_the_walking_direction(self):
        r = run_js("const p=run(P({onGround:true,yaw:Math.PI/2}),{mz:1},flat(),30);out([p.x<5.5-1,Math.abs(p.y-5.5)<0.05])")
        self.assertEqual(r, [True, True])

    def test_should_not_walk_through_a_wall(self):
        r = run_js("""const w=flat();for(let y=0;y<48;y++)for(let z=5;z<9;z++)w.data[(z*48+y)*48+8]=3;
        const p=run(P({x:5.5,y:5.5,onGround:true,yaw:-Math.PI/2}),{mz:1},w,200);out([p.x,p.x<8-0.3+1e-6])""")
        self.assertTrue(r[1])
        self.assertGreater(r[0], 7)

    def test_jump_should_clear_one_block_but_not_two(self):
        r = run_js("""const w=flat();let p=run(P({onGround:true}),{},w,5);let peak=0;
        p=run(p,(i,q)=>{peak=Math.max(peak,q.z-5);return {jump:i===0}},w,90);
        out([peak,p.z,p.onGround])""")
        self.assertGreater(r[0], 1.1)
        self.assertLess(r[0], 1.45)
        self.assertAlmostEqual(r[1], 5, places=3)

    def test_should_step_onto_a_one_block_ledge_by_jumping_but_not_a_two_block_one(self):
        r = run_js("""const mk=(h)=>{const w=flat();for(let y=0;y<48;y++)for(let z=5;z<5+h;z++)w.data[(z*48+y)*48+8]=3;for(let y=0;y<48;y++)for(let x=8;x<48;x++)for(let z=5;z<5+h;z++)w.data[(z*48+y)*48+x]=3;return w};
        const go=(h)=>run(P({x:6.5,y:20.5,onGround:true,yaw:-Math.PI/2}),(i)=>({mz:1,jump:true}),mk(h),120);
        out([go(1).x>9,go(2).x<8])""")
        self.assertEqual(r, [True, True])

    def test_should_bump_the_head_on_a_ceiling(self):
        r = run_js("""const w=flat();for(let y=0;y<48;y++)for(let x=0;x<48;x++)w.data[(8*48+y)*48+x]=3;const p=run(P({onGround:true}),(i)=>({jump:true}),w,60);out(p.z+1.8<=8+1e-6)""")
        self.assertTrue(r)

    def test_water_should_slow_sink_and_let_the_player_swim_up(self):
        r = run_js("""const w=flat();for(let y=0;y<48;y++)for(let x=0;x<48;x++)for(let z=5;z<14;z++)w.data[(z*48+y)*48+x]=7;
        const a=run(P({z:12}),{},w,10),b=run(P({z:12}),{},w,500),c=run(b,{jump:true},w,60);
        const dry=run(P({z:12}),{},flat(),10);out([a.inWater,12-a.z<12-dry.z,b.z>=5&&b.z<5.5,c.z>b.z+2,Math.abs(a.vz)<=2.51])""")
        self.assertEqual(r, [True] * 5)

    def test_should_move_slower_in_water(self):
        r = run_js("""const w=flat();for(let y=0;y<48;y++)for(let x=0;x<48;x++)for(let z=5;z<9;z++)w.data[(z*48+y)*48+x]=7;
        const wet=run(P({onGround:true,y:30.5}),{mz:1},w,40),dry=run(P({onGround:true,y:30.5}),{mz:1},flat(),40);out(30.5-wet.y<(30.5-dry.y)*0.8)""")
        self.assertTrue(r)

    def test_edge_of_the_world_should_be_a_soft_wall(self):
        r = run_js("""const w=flat();const p=run(P({x:2.5,y:20.5,onGround:true,yaw:Math.PI/2}),{mz:1,sprint:true},w,300);const q=run(P({x:44,y:20.5,onGround:true,yaw:-Math.PI/2}),{mz:1,sprint:true},w,300);
        out([p.x,q.x,p.x>=0.3-1e-6,q.x<=47.7+1e-6])""")
        self.assertEqual(r[2:], [True, True])

    def test_pitch_should_clamp_to_89_degrees(self):
        r = run_js("const p=V.physics(P(),{pitchDelta:100},flat(),16),q=V.physics(P(),{pitchDelta:-100},flat(),16);out([p.pitch*180/Math.PI,q.pitch*180/Math.PI])")
        self.assertAlmostEqual(r[0], 89, places=6)
        self.assertAlmostEqual(r[1], -89, places=6)

    def test_should_survive_nan_infinite_and_huge_input(self):
        r = run_js("""const w=flat();const bad=[NaN,Infinity,-Infinity,1e300,'x',null,{}];let ok=true;
        for(const v of bad){const p=V.physics(P({x:v,vx:v,vz:v,yaw:v,pitch:v}),{mx:v,mz:v,yawDelta:v,pitchDelta:v,jump:v},w,v);
          for(const k of ['x','y','z','vx','vy','vz','yaw','pitch'])if(!Number.isFinite(p[k]))ok=false;if(p.x<0.3-1e-9||p.x>47.7+1e-9)ok=false}
        for(const pl of [null,undefined,5,'s',[]])for(const wd of [null,{},5,w]){const p=V.physics(pl,null,wd,16);if(!Number.isFinite(p.x+p.y+p.z))ok=false}
        out(ok)""")
        self.assertTrue(r)

    def test_should_clamp_the_frame_time_to_fifty_ms(self):
        r = run_js("const a=V.physics(P({onGround:true}),{mz:1},flat(),50),b=V.physics(P({onGround:true}),{mz:1},flat(),99999);out([a.y===b.y,a.x===b.x,a.vz===b.vz])")
        self.assertEqual(r, [True] * 3)

    def test_should_be_pure(self):
        r = run_js("const w=flat(),h=hash(w),p=P({onGround:true}),s=JSON.stringify(p);const i={mz:1,jump:true},si=JSON.stringify(i);const q=V.physics(p,i,w,16);out([q!==p,JSON.stringify(p)===s,JSON.stringify(i)===si,hash(w)===h])")
        self.assertEqual(r, [True] * 4)

    def test_should_push_the_player_out_when_a_block_appears_on_them(self):
        r = run_js("const w=flat();w.data[(5*48+5)*48+5]=3;w.data[(6*48+5)*48+5]=3;const p=V.physics(P(),{},w,16);out(p.z>=7-1e-6)")
        self.assertTrue(r)

    def test_should_bounce_on_jelly(self):
        r = run_js("""const w=flat();for(let y=0;y<48;y++)for(let x=0;x<48;x++)w.data[(4*48+y)*48+x]=V.ID.jelly;let p=P({z:14}),top=0;
        p=run(p,(i,q)=>{if(i>40)top=Math.max(top,q.z);return {}},w,140);out(top>6)""")
        self.assertTrue(r)

    def test_look_dir_should_be_a_unit_vector(self):
        r = run_js("const d=V.lookDir(0.7,0.3),z=V.lookDir(0,0);out([Math.hypot(d.x,d.y,d.z),z.x,z.y,z.z,V.lookDir(NaN,NaN).y])")
        self.assertAlmostEqual(r[0], 1, places=9)
        self.assertEqual((r[2], r[3], r[4]), (-1, 0, -1))


@unittest.skipUnless(NODE, "node not installed")
class RaycastAndEditTests(unittest.TestCase):
    def test_raycast_should_hit_the_expected_block_and_face_on_every_axis(self):
        r = run_js("""const w=empty();V.set(w,10,10,10,V.ID.stone);const o=(x,y,z)=>({x,y,z});
        out([V.raycast(w,o(5.5,10.5,10.5),{x:1,y:0,z:0}),V.raycast(w,o(15.5,10.5,10.5),{x:-1,y:0,z:0}),V.raycast(w,o(10.5,5.5,10.5),{x:0,y:1,z:0}),
             V.raycast(w,o(10.5,10.5,15.5),{x:0,y:0,z:-1}),V.raycast(w,o(10.5,10.5,5.5),{x:0,y:0,z:1}),V.raycast(w,o(10.5,15.5,10.5),{x:0,y:-3,z:0})])""")
        faces = [(-1, 0, 0), (1, 0, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1), (0, 1, 0)]
        for hit, f in zip(r, faces):
            self.assertEqual((hit["x"], hit["y"], hit["z"], hit["id"]), (10, 10, 10, 3))
            self.assertEqual((hit["face"]["nx"], hit["face"]["ny"], hit["face"]["nz"]), f)

    def test_raycast_should_hit_diagonally_and_respect_max_distance(self):
        r = run_js("""const w=empty();V.set(w,10,10,10,3);const d={x:1,y:1,z:1};out([V.raycast(w,{x:7.6,y:7.6,z:7.6},d,6),V.raycast(w,{x:7.6,y:7.6,z:7.6},d,1),V.raycast(w,{x:0.5,y:0.5,z:0.5},{x:1,y:0,z:0},6),V.raycast(w,{x:5.5,y:10.5,z:10.5},{x:1,y:0,z:0},2)])""")
        self.assertEqual((r[0]["x"], r[0]["y"], r[0]["z"]), (10, 10, 10))
        self.assertIsNone(r[1])
        self.assertIsNone(r[2])
        self.assertIsNone(r[3])

    def test_raycast_should_see_through_water_and_hit_the_bed(self):
        r = run_js("""const w=empty();V.set(w,10,10,5,3);V.set(w,10,10,6,V.ID.water);V.set(w,10,10,7,V.ID.water);out(V.raycast(w,{x:10.5,y:10.5,z:9.5},{x:0,y:0,z:-1},6))""")
        self.assertEqual((r["z"], r["id"], r["face"]["nz"]), (5, 3, 1))

    def test_raycast_should_hit_plants(self):
        r = run_js("const w=empty();V.set(w,10,10,5,V.ID.flowerRed);out(V.raycast(w,{x:10.5,y:10.5,z:8.5},{x:0,y:0,z:-1},6).id)")
        self.assertEqual(r, 16)

    def test_raycast_should_be_total(self):
        r = run_js("""const w=world();let n=0;const bad=[null,undefined,5,'x',{},{x:NaN,y:0,z:0},{x:0,y:0,z:0}];
        for(const o of bad)for(const d of bad){V.raycast(w,o,d,6);n++}V.raycast(null,{x:1,y:1,z:1},{x:1,y:0,z:0});V.raycast(w,{x:1,y:1,z:1},{x:1,y:0,z:0},NaN);V.raycast(w,{x:1e9,y:1e9,z:1e9},{x:1,y:1,z:1},1e9);out(n)""")
        self.assertEqual(r, 49)

    def test_raycast_should_work_from_the_player_eye_through_look_dir(self):
        r = run_js("""const w=flat();V.set(w,5,2,6,3);const p=P({y:5.5,yaw:0}),d=V.lookDir(p.yaw,0);const h=V.raycast(w,{x:p.x,y:p.y,z:p.z+V.EYE},d,6);out(h)""")
        self.assertEqual((r["x"], r["y"], r["z"]), (5, 2, 6))
        self.assertEqual(r["face"]["ny"], 1)

    def test_place_should_put_the_block_against_the_hit_face(self):
        r = run_js("""const w=flat();const hit=V.raycast(w,{x:10.5,y:10.5,z:9.5},{x:0,y:0,z:-1},6);const res=V.place(w,P({x:10.5,y:12.5,z:5}),hit,V.ID.brick);out([hit.z,res,V.get(w,10,10,5)])""")
        self.assertEqual(r[0], 4)
        self.assertTrue(r[1]["ok"])
        self.assertEqual(r[2], 6)

    def test_place_should_refuse_inside_the_player(self):
        r = run_js("""const w=flat();const hit={x:10,y:10,z:4,face:{nx:0,ny:0,nz:1},id:3};const res=V.place(w,P({x:10.5,y:10.5,z:5}),hit,3);out([res,V.get(w,10,10,5)])""")
        self.assertEqual(r[0], {"ok": False, "reason": "inside-player"})
        self.assertEqual(r[1], 0)

    def test_place_should_allow_non_solid_blocks_inside_the_player(self):
        r = run_js("""const w=flat();const hit={x:10,y:10,z:4,face:{nx:0,ny:0,nz:1},id:3};out(V.place(w,P({x:10.5,y:10.5,z:5}),hit,V.ID.water).ok)""")
        self.assertTrue(r)

    def test_place_should_refuse_out_of_reach_occupied_and_out_of_world(self):
        r = run_js("""const w=flat();const hit={x:10,y:10,z:4,face:{nx:0,ny:0,nz:1},id:3};
        out([V.place(w,P({x:30.5,y:30.5,z:5}),hit,3),V.place(w,P({x:10.5,y:12.5,z:5}),{x:10,y:10,z:3,face:{nx:0,ny:0,nz:1},id:3},3),
             V.place(w,P({x:10.5,y:12.5,z:5}),{x:10,y:10,z:23,face:{nx:0,ny:0,nz:1},id:3},3),V.place(w,P({x:10.5,y:12.5,z:5}),{x:0,y:10,z:4,face:{nx:-1,ny:0,nz:0},id:3},3)])""")
        self.assertEqual([x["reason"] for x in r], ["too-far", "occupied", "out-of-range", "out-of-range"])

    def test_place_should_validate_ids_and_hits(self):
        r = run_js("""const w=flat(),h={x:10,y:10,z:4,face:{nx:0,ny:0,nz:1},id:3};
        out([0,20,-1,1.5,'3',null,NaN].map(id=>V.place(w,P({x:10.5,y:12.5}),h,id).ok).concat([null,{},{x:1,y:1,z:1},{x:1,y:1,z:1,face:{nx:2,ny:0,nz:0}},{x:1.5,y:1,z:1,face:{nx:1,ny:0,nz:0}}].map(hh=>V.place(w,P(),hh,3).ok)))""")
        self.assertEqual(r, [False] * 12)

    def test_place_should_replace_water_and_plants(self):
        r = run_js("""const w=flat();V.set(w,10,10,5,V.ID.water);V.set(w,10,10,6,V.ID.tallGrass);const h={x:10,y:10,z:4,face:{nx:0,ny:0,nz:1},id:3};
        const a=V.place(w,P({x:10.5,y:13.5,z:5}),h,3);const h2={x:10,y:10,z:5,face:{nx:0,ny:0,nz:1},id:3};const b=V.place(w,P({x:10.5,y:13.5,z:5}),h2,3);out([a.ok,b.ok,V.get(w,10,10,5),V.get(w,10,10,6)])""")
        self.assertEqual(r, [True, True, 3, 3])

    def test_break_should_remove_the_block_and_report_its_id(self):
        r = run_js("const w=flat();const res=V.breakBlock(w,{x:3,y:3,z:4,face:{nx:0,ny:0,nz:1},id:3});out([res,V.get(w,3,3,4)])")
        self.assertEqual(r, [{"ok": True, "id": 3}, 0])

    def test_break_should_never_remove_the_bottom_row(self):
        r = run_js("const w=flat();const res=V.breakBlock(w,{x:3,y:3,z:0,face:{nx:0,ny:0,nz:1},id:3});out([res,V.get(w,3,3,0)])")
        self.assertEqual(r, [{"ok": False, "reason": "bedrock"}, 3])

    def test_break_should_refuse_air_water_far_and_junk(self):
        r = run_js("""const w=flat();V.set(w,9,9,5,V.ID.water);const f={nx:0,ny:0,nz:1};
        out([V.breakBlock(w,{x:3,y:3,z:10,face:f,id:0}),V.breakBlock(w,{x:9,y:9,z:5,face:f,id:7}),V.breakBlock(w,{x:3,y:3,z:4,face:f},P({x:40.5,y:40.5,z:5})),V.breakBlock(null,null),V.breakBlock(w,{x:99,y:3,z:4,face:f}),V.breakBlock(w,{x:3,y:3,z:4,face:{nx:5,ny:0,nz:0}})].map(x=>x.reason))""")
        self.assertEqual(r, ["empty", "empty", "too-far", "bad-input", "out-of-range", "bad-input"])

    def test_breaking_inside_the_plot_should_flag_it_dirty_and_the_build_updates(self):
        r = run_js("""const w=world();const before=JSON.stringify(V.plotToBuild(w));const hit=V.raycast(w,{x:24,y:24,z:20},{x:0,y:0,z:-1},40);const res=V.breakBlock(w,hit);out([res.ok,w.plotDirty,JSON.stringify(V.plotToBuild(w))!==before])""")
        self.assertEqual(r, [True, True, True])


@unittest.skipUnless(NODE, "node not installed")
class CritterTests(unittest.TestCase):
    def test_should_make_six_to_ten_friendly_kinds_on_dry_land(self):
        r = run_js("""const res=[];for(const t of TERR)for(const sd of [1,2,3]){const w=world(t,sd),a=V.critters(w,sd);
          res.push([a.length,a.every(c=>['llama','goat','piglet','duckling'].includes(c.kind)),a.every(c=>!V.BLOCKS[V.get(w,c.x,c.y,c.z)].solid&&V.get(w,c.x,c.y,c.z)!==7&&V.BLOCKS[V.get(w,c.x,c.y,c.z-1)].solid)])}out(res)""")
        for n, kinds, land in r:
            self.assertTrue(6 <= n <= 10, n)
            self.assertTrue(kinds)
            self.assertTrue(land)

    def test_should_use_all_four_kinds_and_be_deterministic(self):
        r = run_js("const w=world('meadow',2),a=V.critters(w,4);out([new Set(a.map(c=>c.kind)).size,JSON.stringify(a)===JSON.stringify(V.critters(w,4)),JSON.stringify(a)!==JSON.stringify(V.critters(w,5))])")
        self.assertEqual(r, [4, True, True])

    def test_should_wander_but_stay_on_land_in_bounds_and_off_the_plot(self):
        r = run_js("""const w=world('island',3);let a=V.critters(w,1),moved=0;const start=a.map(c=>[c.x,c.y]);let bad=0;
        for(let i=0;i<3000;i++){a=V.stepCritters(a,w,50);for(const c of a){const x=Math.floor(c.x),y=Math.floor(c.y),z=c.z;
          if(V.get(w,x,y,z)===7||V.get(w,x,y,z-1)===7||!V.BLOCKS[V.get(w,x,y,z-1)].solid||V.BLOCKS[V.get(w,x,y,z)].solid)bad++;
          if(x<1||y<1||x>46||y>46)bad++;if(x>=18&&x<=29&&y>=18&&y<=29)bad++}}
        a.forEach((c,i)=>{if(Math.hypot(c.x-start[i][0],c.y-start[i][1])>1)moved++});out([bad,moved,a.length])""")
        self.assertEqual(r[0], 0)
        self.assertGreater(r[1], 0)

    def test_should_not_mutate_its_input_and_survive_junk(self):
        r = run_js("""const w=world();const a=V.critters(w,1),s=JSON.stringify(a);V.stepCritters(a,w,16);const same=JSON.stringify(a)===s;
        out([same,V.stepCritters(null,w,16),V.stepCritters(a,null,16),V.stepCritters([null,5,{kind:'wolf'},{kind:'llama',x:NaN}],w,NaN).length,V.critters(null,1),V.critters(w,NaN).length>0])""")
        self.assertEqual(r[0], True)
        self.assertEqual(r[1:4], [[], [], 1])
        self.assertEqual(r[4], [])
        self.assertTrue(r[5])


@unittest.skipUnless(NODE, "node not installed")
class TimeOfDayTests(unittest.TestCase):
    def test_should_stay_in_bounds_and_never_go_fully_dark(self):
        r = run_js("""let ok=true,minA=9,maxS=0,minS=9;for(let t=0;t<720000;t+=1500){const d=V.timeOfDay(t);
          if(!(d.sun>=0&&d.sun<=1&&d.ambient>=0.4&&d.ambient<=1)||!/^#[0-9a-f]{6}$/.test(d.skyTop)||!/^#[0-9a-f]{6}$/.test(d.skyBottom))ok=false;minA=Math.min(minA,d.ambient);maxS=Math.max(maxS,d.sun);minS=Math.min(minS,d.sun)}
        out([ok,minA,maxS,minS])""")
        self.assertTrue(r[0])
        self.assertGreaterEqual(r[1], 0.4)
        self.assertEqual(r[2], 1)
        self.assertEqual(r[3], 0)

    def test_should_repeat_every_six_minutes_and_handle_junk(self):
        r = run_js("""const a=V.timeOfDay(1000),b=V.timeOfDay(1000+360000);out([JSON.stringify(a)===JSON.stringify(b),V.timeOfDay(NaN).sun>=0,V.timeOfDay('x').ambient>0,V.timeOfDay(-5000).sun<=1,V.timeOfDay(Infinity).sun>=0])""")
        self.assertEqual(r, [True] * 5)

    def test_should_change_smoothly(self):
        r = run_js("""let max=0,prev=V.timeOfDay(0);for(let t=100;t<360000;t+=100){const d=V.timeOfDay(t);max=Math.max(max,Math.abs(d.sun-prev.sun),Math.abs(d.ambient-prev.ambient));prev=d}out(max)""")
        self.assertLess(r, 0.02)


@unittest.skipUnless(NODE, "node not installed")
class GeometryTests(unittest.TestCase):
    def test_a_lone_block_should_have_six_faces(self):
        r = run_js("""const w=empty();V.set(w,5,5,5,V.ID.stone);const g=V.buildChunkGeometry(w,0,0,0);out([g.opaque.positions.length/3,g.opaque.indices.length,g.transparent.indices.length,g.opaque.colors.length/3,g.opaque.uvs.length/2])""")
        self.assertEqual(r, [24, 36, 0, 24, 24])

    def test_touching_blocks_should_hide_the_shared_faces(self):
        r = run_js("""const w=empty();V.set(w,5,5,5,3);V.set(w,6,5,5,3);V.set(w,5,6,5,3);V.set(w,5,5,6,3);const g=V.buildChunkGeometry(w,0,0,0);out(g.opaque.indices.length/6)""")
        self.assertEqual(r, 24 - 6)

    def test_a_solid_cube_should_only_show_its_skin(self):
        r = run_js("""const w=empty();for(let z=2;z<5;z++)for(let y=2;y<5;y++)for(let x=2;x<5;x++)V.set(w,x,y,z,3);out(V.buildChunkGeometry(w,0,0,0).opaque.indices.length/6)""")
        self.assertEqual(r, 54)

    def test_should_split_water_glass_leaves_and_plants_into_the_transparent_set(self):
        r = run_js("""const w=empty();V.set(w,2,2,2,V.ID.water);V.set(w,5,5,2,V.ID.glass);V.set(w,8,8,2,V.ID.leaves);V.set(w,11,11,2,V.ID.flowerRed);V.set(w,13,13,2,3);
        const g=V.buildChunkGeometry(w,0,0,0);out([g.opaque.indices.length/6,g.transparent.indices.length/6])""")
        self.assertEqual(r, [6, 6 + 6 + 6 + 4])

    def test_opaque_blocks_should_still_show_faces_against_see_through_neighbours(self):
        r = run_js("""const w=empty();V.set(w,5,5,5,3);V.set(w,6,5,5,V.ID.glass);const g=V.buildChunkGeometry(w,0,0,0);out([g.opaque.indices.length/6,g.transparent.indices.length/6])""")
        self.assertEqual(r, [6, 5])  # the glass face touching the stone is hidden

    def test_same_see_through_blocks_should_merge(self):
        r = run_js("""const w=empty();V.set(w,5,5,5,V.ID.glass);V.set(w,6,5,5,V.ID.glass);out(V.buildChunkGeometry(w,0,0,0).transparent.indices.length/6)""")
        self.assertEqual(r, 10)

    def test_water_surface_should_sit_lower_than_a_full_block(self):
        r = run_js("""const w=empty();V.set(w,5,5,5,V.ID.water);const p=V.buildChunkGeometry(w,0,0,0).transparent.positions;let mx=0;for(let i=1;i<p.length;i+=3)mx=Math.max(mx,p[i]);
        V.set(w,5,5,6,V.ID.water);const q=V.buildChunkGeometry(w,0,0,0).transparent.positions;let mx2=0;for(let i=1;i<q.length;i+=3)mx2=Math.max(mx2,q[i]);out([mx,mx2])""")
        self.assertAlmostEqual(r[0], 5.9, places=5)
        self.assertAlmostEqual(r[1], 6.9, places=5)

    def test_should_keep_array_lengths_and_indices_consistent_with_finite_data(self):
        r = run_js("""const w=world('meadow',1);const res=[];for(let cx=0;cx<3;cx++)for(let cy=0;cy<3;cy++)for(let cz=0;cz<2;cz++){const g=V.buildChunkGeometry(w,cx,cy,cz);
          for(const s of [g.opaque,g.transparent]){const n=s.positions.length/3;let ok=s.normals.length===n*3&&s.colors.length===n*3&&s.uvs.length===n*2&&s.indices.length%3===0;
            ok=ok&&s.positions instanceof Float32Array&&s.indices instanceof Uint32Array&&s.uvs instanceof Float32Array&&s.colors instanceof Float32Array&&s.normals instanceof Float32Array;
            for(const i of s.indices)if(i>=n)ok=false;
            for(const a of [s.positions,s.normals,s.uvs,s.colors])for(const v of a)if(!Number.isFinite(v))ok=false;
            for(const v of s.uvs)if(v<0||v>1)ok=false;for(const v of s.colors)if(v<0||v>1)ok=false;
            res.push(ok)}}out(res)""")
        self.assertTrue(all(r) and len(r) == 36)

    def test_triangles_should_face_outwards_along_their_normals(self):
        r = run_js("""const w=world('candy',2);let bad=0,tris=0;for(let cx=0;cx<3;cx++)for(let cy=0;cy<3;cy++)for(let cz=0;cz<2;cz++){const g=V.buildChunkGeometry(w,cx,cy,cz).opaque,p=g.positions,n=g.normals;
          for(let t=0;t<g.indices.length;t+=3){const a=g.indices[t]*3,b=g.indices[t+1]*3,c=g.indices[t+2]*3;
            const ux=p[b]-p[a],uy=p[b+1]-p[a+1],uz=p[b+2]-p[a+2],vx=p[c]-p[a],vy=p[c+1]-p[a+1],vz=p[c+2]-p[a+2];
            const cxp=uy*vz-uz*vy,cyp=uz*vx-ux*vz,czp=ux*vy-uy*vx;if(cxp*n[a]+cyp*n[a+1]+czp*n[a+2]<=0)bad++;tris++}}out([bad,tris>1000])""")
        self.assertEqual(r, [0, True])

    def test_normals_should_be_unit_axis_vectors(self):
        r = run_js("""const g=V.buildChunkGeometry(world(),1,1,0).opaque;let ok=true;for(let i=0;i<g.normals.length;i+=3){const l=Math.abs(g.normals[i])+Math.abs(g.normals[i+1])+Math.abs(g.normals[i+2]);if(l!==1)ok=false}out(ok)""")
        self.assertTrue(r)

    def test_should_bake_the_face_shade_and_ambient_occlusion(self):
        r = run_js("""const w=empty();V.set(w,5,5,5,3);let g=V.buildChunkGeometry(w,0,0,0).opaque;const shades={};
        for(let i=0;i<g.normals.length;i+=3){const k=g.normals.slice(i,i+3).join();shades[k]=Math.max(shades[k]||0,g.colors[i])}
        V.set(w,6,5,6,3);const g2=V.buildChunkGeometry(w,0,0,0).opaque;const min1=Math.min(...g.colors),min2=Math.min(...g2.colors);out([shades,min1,min2])""")
        s = r[0]
        self.assertEqual(s["0,1,0"], 1)
        self.assertAlmostEqual(s["0,-1,0"], 0.5)
        self.assertAlmostEqual(s["1,0,0"], 0.8)
        self.assertAlmostEqual(s["0,0,1"], 0.7)
        self.assertAlmostEqual(r[1], 0.5)  # the bottom face of a lone block, fully open
        self.assertLess(r[2], r[1] + 1e-9)

    def test_ambient_occlusion_should_darken_an_inner_corner(self):
        r = run_js("""const w=empty();V.set(w,5,5,5,3);V.set(w,6,5,6,3);const g=V.buildChunkGeometry(w,0,0,0).opaque;const tops=[];
        for(let i=0;i<g.normals.length;i+=3)if(g.normals[i+1]===1&&g.positions[i+1]===6&&g.positions[i]<=6&&g.positions[i+2]<=6&&g.positions[i]>=5&&g.positions[i+2]>=5&&g.positions[i]!==undefined)tops.push([g.positions[i],g.positions[i+2],g.colors[i]]);
        const near=tops.filter(t=>t[0]===6&&t[1]>=5).map(t=>t[2]),far=tops.filter(t=>t[0]===5).map(t=>t[2]);out([Math.min(...near),Math.max(...far)])""")
        self.assertLess(r[0], r[1])

    def test_should_map_uvs_into_the_tile_of_the_block(self):
        r = run_js("""const w=empty();V.set(w,5,5,5,V.ID.grass);const g=V.buildChunkGeometry(w,0,0,0).opaque;const tiles=new Set();
        for(let i=0;i<g.uvs.length;i+=2){const col=Math.floor(g.uvs[i]*16+1e-6),row=15-Math.floor(g.uvs[i+1]*16+1e-6);tiles.add(row*16+col)}out([...tiles].sort((a,b)=>a-b))""")
        self.assertEqual(r, sorted([0, 1, 2]))

    def test_should_not_draw_walls_at_the_world_edge_but_should_draw_the_open_top(self):
        r = run_js("""const w=empty();V.set(w,0,0,0,3);V.set(w,0,0,23,3);out([V.buildChunkGeometry(w,0,0,0).opaque.indices.length/6,V.buildChunkGeometry(w,0,0,1).opaque.indices.length/6])""")
        self.assertEqual(r, [3, 4])  # floor corner: +x,+y,+z; roof corner: +x,+y,+z and the open bottom

    def test_should_return_empty_geometry_for_bad_chunk_coordinates_and_worlds(self):
        r = run_js("""const w=world();out([[w,-1,0,0],[w,9,0,0],[w,0,0,5],[w,1.5,0,0],[null,0,0,0],[{},0,0,0],[w,'a',0,0],[w,NaN,0,0]].map(a=>{const g=V.buildChunkGeometry(...a);return g.opaque.indices.length+g.transparent.indices.length}))""")
        self.assertEqual(r, [0] * 8)

    def test_should_report_the_dirty_chunks_for_an_edit(self):
        r = run_js("out([V.dirtyChunks(5,5,5).length,V.dirtyChunks(16,5,5).length,V.dirtyChunks(15,15,15).length,V.dirtyChunks(0,0,0).length,V.dirtyChunks(1.5,1,1)])")
        self.assertEqual(r, [1, 2, 4, 1, []])

    def test_should_be_fast(self):
        r = run_js("""const w=world('meadow',1);V.buildChunkGeometry(w,1,1,0);const t0=process.hrtime.bigint();for(let i=0;i<9;i++)V.buildChunkGeometry(w,i%3,(i/3|0)%3,0);out(Number(process.hrtime.bigint()-t0)/9e6)""")
        self.assertLess(r, 25)


@unittest.skipUnless(NODE, "node not installed")
class SafetyTests(unittest.TestCase):
    def test_every_public_function_should_survive_hostile_arguments(self):
        r = run_js("""const junk=[undefined,null,NaN,Infinity,-1,1e300,'x',{},[],true,()=>1,{data:new Uint8Array(3)},Symbol.iterator];
        const names=Object.keys(V).filter(k=>typeof V[k]==='function');let calls=0,thrown=[];
        for(const n of names)for(const a of junk)for(const b of junk){for(const args of [[a],[a,b],[a,b,a,b],[b,a,b,a,b]]){try{V[n](...args)}catch(e){thrown.push(n+':'+e.message)}calls++}}
        out([names.length,calls>1000,thrown.slice(0,5)])""")
        self.assertGreater(r[0], 15)
        self.assertEqual(r[2], [])

    def test_should_not_mutate_a_frozen_spec(self):
        r = run_js("""const s=spec('snow',4);const f=(o)=>{Object.freeze(o);Object.values(o).forEach(v=>typeof v==='object'&&v&&f(v));return o};f(s);out(V.generate(s).terrain)""")
        self.assertEqual(r, "snow")

    def test_source_should_have_no_unsafe_calls_or_forbidden_words(self):
        src = VOXEL.read_text()
        for bad in ["eval(", "new Function", "innerHTML", "fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "document.", "window.", "Math.random", "Date.now", "new Date", "require('child"]:
            self.assertNotIn(bad, src, bad)
        self.assertIsNone(re.search(r"mine\s*craft|mojang|creeper|steve|notch", src, re.I))
        for word in ["lava", "tnt", "zombie", "skeleton", "sword", "gun"]:
            self.assertIsNone(re.search(r"\b" + word + r"\b", src, re.I), word)


if __name__ == "__main__":
    unittest.main()
