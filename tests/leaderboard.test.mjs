import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { playerFixture } from "./server-mock.mjs";
import { LeaderboardManager,STORAGE_KEY,BOARD_TYPES } from "../behavior_pack/scripts/leaderboard/manager.js";
import { rankPlayers,validateCreate,leaderboardFields } from "../behavior_pack/scripts/leaderboard/logic.js";
import { PAGES,PAGE_IDS,UI,textCells } from "../behavior_pack/scripts/ui/layouts.js";
import { unpackGlyphs } from "../behavior_pack/scripts/ui/core.js";

const score=(name,value,type="Player",id=name)=>({score:value,participant:{id,displayName:name,type}});
function fixture(){
  const f=playerFixture(),data=new Map(),objectives=new Map();
  const world={getDynamicProperty:key=>data.get(key),setDynamicProperty:(key,value)=>data.set(key,value),
    scoreboard:{getObjective:id=>objectives.get(id)},getDimension:id=>id.replace("minecraft:","")==="overworld"?f.player.dimension:
      {id:`minecraft:${id.replace("minecraft:","")}`,getEntities:()=>[],getBlock:()=>undefined}};
  const objective={id:"kills",displayName:"Kills",scores:[score("Alice",4),score("Bob",20),score("Offline",12)],getScores(){return this.scores;}};
  objectives.set("kills",objective);const manager=new LeaderboardManager(world);manager.load();
  return {...f,world,data,objectives,objective,manager};
}
function displayed(f){
  const entities=f.entities.filter(e=>e.isValid&&e.typeId===BOARD_TYPES[1]).sort((a,b)=>a.properties["ns:layer"]-b.properties["ns:layer"]);
  const chars=entities.flatMap(e=>Array.from({length:UI.textPacks},(_,p)=>unpackGlyphs(e.properties[`ns:t${p}`]??0)).join("").split(""));
  const fields={};textCells(PAGES[PAGE_IDS.leaderboard]).forEach((c,i)=>{fields[c.field]=(fields[c.field]??"")+(chars[i]??" ");});
  return fields;
}
test("leaderboard ranks real players highest-first, keeps offline scores, rejects fake/entity entries and breaks ties predictably",()=>{
  assert.deepEqual(rankPlayers([score("Zoe",12),score("Offline",50),score("Alice",12),score("Fake",999,"FakePlayer"),score("Mob",777,"Entity"),score("Zero",0),score("Negative",-4)],15).map(p=>p.name),["Offline","Alice","Zoe","Zero","Negative"]);
});
test("amount must be an integer from 1 through 15; no silent clamping",()=>{
  for(const amount of [0,-1,16,1.5,NaN,"3"])assert.throws(()=>validateCreate("kills",amount),/1 to 15/);
  for(const amount of [1,15])assert.doesNotThrow(()=>validateCreate("kills",amount));
});
test("create uses the objective ID, places in front of the player, and sends the requested top count",()=>{
  const f=fixture(),board=f.manager.create(f.player,"kills",2),fields=displayed(f);
  assert.equal(board.amount,2);assert.equal(board.dimension,f.player.dimension.id);
  assert.ok(board.pose.center.z>f.player.head.z);assert.ok(f.entities.every(e=>e.rotation.y===board.pose.rotation.y));
  assert.equal(fields.player0.trim(),"BOB");assert.equal(fields.score0.trim(),"20");assert.equal(fields.player1.trim(),"OFFLINE");
  assert.equal(fields.player2.trim(),"");assert.equal(f.entities[0].properties["ns:transparent"],1);
  assert.equal(JSON.parse(f.data.get(STORAGE_KEY)).boards.length,1);
});
test("max 15 rows use seven property-limited layers; smaller boards spawn fewer",()=>{
  const small=fixture();small.manager.create(small.player,"kills",1);
  const large=fixture();large.manager.create(large.player,"kills",15);
  assert.equal(large.entities.filter(e=>e.typeId===BOARD_TYPES[1]).length,7);
  assert.ok(small.entities.length<large.entities.length);
  for(const e of large.entities)assert.ok(Object.keys(e.properties).length<=32);
});
test("missing objective or invalid amount leaves no actors or saved records",()=>{
  const f=fixture();assert.throws(()=>f.manager.create(f.player,"missing",4),/does not exist/);
  assert.throws(()=>f.manager.create(f.player,"kills",16),/1 to 15/);
  assert.equal(f.entities.length,0);assert.equal(f.data.has(STORAGE_KEY),false);
});

test("a failed persistence write rolls back actors, registry and next ID",()=>{
  const f=fixture();f.world.setDynamicProperty=()=>{throw Error("storage full");};
  assert.throws(()=>f.manager.create(f.player,"kills",3),/storage full/);
  assert.ok(f.entities.every(e=>!e.isValid));assert.equal(f.manager.boards.length,0);assert.equal(f.manager.nextId,1);
});
test("live updates reorder players and unchanged scores resend no properties",()=>{
  const f=fixture();f.manager.create(f.player,"kills",3);f.writes.length=0;f.manager.tick();assert.equal(f.writes.length,0);
  f.objective.scores=[score("Alice",100),score("Bob",20)];f.manager.tick();const fields=displayed(f);
  assert.equal(fields.player0.trim(),"ALICE");assert.equal(fields.score0.trim(),"100");assert.equal(fields.player2.trim(),"");
  f.writes.length=0;f.manager.tick();assert.equal(f.writes.length,0);
});
test("placed boards do not close on item changes, logout, death or walking away",()=>{
  const f=fixture();f.manager.create(f.player,"kills",3);f.player.head.x=100;f.player.health=0;f.player.isValid=false;f.inventory[0]={typeId:"minecraft:stick"};
  f.manager.tick();assert.ok(f.entities.every(e=>e.isValid));assert.equal(f.manager.boards.length,1);
});
test("restart reloads saved board definitions and reuses already loaded actors",()=>{
  const f=fixture();f.manager.create(f.player,"kills",3);const ids=f.entities.map(e=>e.id);
  const reloaded=new LeaderboardManager(f.world);reloaded.load();assert.deepEqual(f.entities.filter(e=>e.isValid).map(e=>e.id),ids);
  assert.equal(reloaded.boards[0].objective,"kills");assert.equal(reloaded.nextId,2);
});
test("missing text is repaired without duplicate panels; duplicate owned layers are removed",()=>{
  const f=fixture(),board=f.manager.create(f.player,"kills",3),panel=f.entities[0];
  f.entities.find(e=>e.typeId===BOARD_TYPES[1]).remove();f.manager.tick();
  assert.equal(f.entities.filter(e=>e.isValid&&e.typeId===BOARD_TYPES[0]).length,1);assert.equal(panel.isValid,true);
  const layer=f.entities.find(e=>e.isValid&&e.typeId===BOARD_TYPES[1]),extra=f.player.dimension.spawnEntity(BOARD_TYPES[1],layer.location);
  extra.setDynamicProperty("ns:leaderboard_id",board.id);extra.setDynamicProperty("ns:leaderboard_layer",layer.getDynamicProperty("ns:leaderboard_layer"));
  f.manager.audit();f.manager.tick();assert.equal(extra.isValid,false);
});
test("unloaded chunks are skipped, and a loaded chunk can restore actors from persisted definitions",()=>{
  const f=fixture();f.manager.create(f.player,"kills",3);f.entities.forEach(e=>e.remove());
  f.player.dimension.getBlock=()=>undefined;const count=f.entities.length;f.manager.tick();assert.equal(f.entities.length,count);
  f.player.dimension.getBlock=()=>({isAir:true});f.manager.tick();assert.ok(f.entities.some(e=>e.isValid));
});
test("an objective removed after creation clears stale scores and resumes if recreated",()=>{
  const f=fixture();f.manager.create(f.player,"kills",3);f.objectives.delete("kills");f.manager.tick();
  let fields=displayed(f);assert.equal(fields.player0.trim(),"");assert.match(fields.status,/MISSING/);
  f.objectives.set("kills",f.objective);f.manager.tick();assert.equal(displayed(f).player0.trim(),"BOB");
});
test("invalid stored data is preserved and does not enable creation or remove actors",()=>{
  const f=fixture();f.manager.create(f.player,"kills",3);f.data.set(STORAGE_KEY,"broken");
  const manager=new LeaderboardManager(f.world);assert.throws(()=>manager.load());assert.equal(manager.ready,false);
  assert.equal(f.data.get(STORAGE_KEY),"broken");assert.ok(f.entities.every(e=>e.isValid));
});
test("score read is shared across boards using the same objective in one update",()=>{
  const f=fixture();f.manager.create(f.player,"kills",2);f.manager.create(f.player,"kills",3);let calls=0;
  f.objective.getScores=function(){calls++;return this.scores;};f.manager.tick();assert.equal(calls,1);
});
test("permanent leaderboard entity definitions have no expiry timer or click/session components",async()=>{
  for(const name of ["leaderboard_panel","leaderboard_text"]){
    const e=JSON.parse(await readFile(new URL(`../behavior_pack/entities/${name}.json`,import.meta.url),"utf8"))["minecraft:entity"];
    assert.equal(e.components["minecraft:timer"],undefined);assert.equal(e.components["minecraft:interact"],undefined);
    assert.equal(e.components["minecraft:physics"].has_gravity,false);assert.equal(e.components["minecraft:physics"].has_collision,false);
    assert.equal(e.components["minecraft:persistent"]!==undefined,true);assert.deepEqual(e.events,{});
  }
});
test("empty objectives display a helpful status rather than fake player rows",()=>{
  const fields=leaderboardFields({objective:"kills",amount:15},{displayName:"Kills"},[]);
  assert.equal(fields.status,"NO PLAYER SCORES YET");assert.equal(fields.rank0,"");assert.equal(fields.player14,"");
});

test("ordinary unchanged polls do no entity scans, payload builds or property writes",()=>{
  const f=fixture();f.manager.create(f.player,"kills",15);f.manager.updates=0;
  f.manager.metrics={scans:0,scoreReads:0,payloadBuilds:0};f.writes.length=0;
  for(let i=0;i<9;i++)f.manager.tick();
  assert.deepEqual(f.manager.metrics,{scans:0,scoreReads:9,payloadBuilds:0});assert.equal(f.writes.length,0);
  f.manager.tick();assert.equal(f.manager.metrics.scans,6);
  assert.equal(f.manager.metrics.payloadBuilds,0);assert.equal(f.writes.length,0);
});

test("same-objective/same-size boards share packed text even across create requests",()=>{
  const f=fixture();f.manager.create(f.player,"kills",15);f.manager.create(f.player,"kills",15);
  assert.equal(f.manager.metrics.payloadBuilds,1);
  f.manager.metrics={scans:0,scoreReads:0,payloadBuilds:0};
  f.objective.scores[0].score=500;f.manager.tick();
  assert.equal(f.manager.metrics.scoreReads,1);assert.equal(f.manager.metrics.payloadBuilds,1);
  assert.equal(f.manager.metrics.scans,0);
});

test("scores below the visible top 15 don't cause text packing or property writes",()=>{
  const f=fixture();f.objective.scores=Array.from({length:1000},(_,i)=>score(`P${i}`,1000-i));
  f.manager.create(f.player,"kills",15);f.manager.metrics.payloadBuilds=0;f.writes.length=0;
  f.objective.scores[999].score=-500;f.manager.tick();
  assert.equal(f.manager.metrics.payloadBuilds,0);assert.equal(f.writes.length,0);
});

test("zero configured boards do no background scans or scoreboard work",()=>{
  const f=fixture();f.manager.metrics={scans:0,scoreReads:0,payloadBuilds:0};
  for(let i=0;i<100;i++)f.manager.tick();assert.deepEqual(f.manager.metrics,{scans:0,scoreReads:0,payloadBuilds:0});
});

test("bounded ranking matches full sorting for a large tied/negative scoreboard",()=>{
  const scores=Array.from({length:10000},(_,i)=>score(`P${String(i).padStart(5,"0")}`,((i*97)%501)-250));
  const expected=scores.map(s=>({id:s.participant.id,name:s.participant.displayName,score:s.score}))
    .sort((a,b)=>b.score-a.score||(a.name<b.name?-1:a.name>b.name?1:0)).slice(0,15);
  for(const amount of [1,3,15])assert.deepEqual(rankPlayers(scores,amount),expected.slice(0,amount));
});

test("repair uses a local search and cached text when scores have not changed",()=>{
  const f=fixture();f.manager.create(f.player,"kills",15);
  const layer=f.entities.find(e=>e.typeId===BOARD_TYPES[1]);layer.remove();
  f.manager.metrics={scans:0,scoreReads:0,payloadBuilds:0};f.manager.tick();
  assert.equal(f.manager.metrics.scans,2);assert.equal(f.manager.metrics.payloadBuilds,0);
  assert.equal(displayed(f).player0.trim(),"BOB");
  assert.equal(f.entities.filter(e=>e.isValid&&e.typeId===BOARD_TYPES[1]).length,7);
});

test("remove deletes only the selected board, its layers and duplicates, not its scoreboard",()=>{
  const f=fixture(),first=f.manager.create(f.player,"kills",3),second=f.manager.create(f.player,"kills",15);
  const duplicate=f.player.dimension.spawnEntity(BOARD_TYPES[1],first.pose.center);
  duplicate.setDynamicProperty("ns:leaderboard_id",first.id);
  const demo=f.player.dimension.spawnEntity("ns:interface_panel",first.pose.center);
  const scores=JSON.stringify(f.objective.scores);
  assert.equal(f.manager.remove(first.id),first);
  assert.deepEqual(f.manager.boards.map(b=>b.id),[second.id]);
  assert.ok(f.entities.filter(e=>e.data["ns:leaderboard_id"]===first.id).every(e=>!e.isValid));
  assert.ok(f.entities.filter(e=>e.data["ns:leaderboard_id"]===second.id).every(e=>e.isValid));
  assert.equal(demo.isValid,true);assert.equal(JSON.stringify(f.objective.scores),scores);
  assert.equal(f.objectives.get("kills"),f.objective);assert.equal(f.manager.runtimes.has(first.id),false);
  assert.equal(f.manager.snapshots.has("kills"),true);
  assert.deepEqual(JSON.parse(f.data.get(STORAGE_KEY)).boards.map(b=>b.id),[second.id]);
});

test("removed boards stay removed after restart, IDs are not reused and last-board caches are freed",()=>{
  const f=fixture(),board=f.manager.create(f.player,"kills",15);
  f.manager.remove(board.id);assert.equal(f.manager.caches.size,0);assert.equal(f.manager.snapshots.size,0);
  f.manager.metrics={scans:0,scoreReads:0,payloadBuilds:0};
  for(let i=0;i<100;i++)f.manager.tick();assert.deepEqual(f.manager.metrics,{scans:0,scoreReads:0,payloadBuilds:0});
  const reloaded=new LeaderboardManager(f.world);reloaded.load();
  assert.equal(reloaded.boards.length,0);assert.ok(f.entities.every(e=>!e.isValid));
  assert.equal(reloaded.create(f.player,"kills",3).id,"2");
});

test("failed removal persistence keeps all actors, caches, next ID and saved data intact",()=>{
  const f=fixture(),board=f.manager.create(f.player,"kills",15),saved=f.data.get(STORAGE_KEY);
  const runtime=f.manager.runtimes.get(board.id),count=f.manager.caches.size;
  f.world.setDynamicProperty=()=>{throw Error("storage full");};
  assert.throws(()=>f.manager.remove(board.id),/storage full/);
  assert.equal(f.manager.boards[0],board);assert.ok(f.entities.every(e=>e.isValid));
  assert.equal(f.manager.runtimes.get(board.id),runtime);assert.equal(f.manager.caches.size,count);
  assert.equal(f.manager.nextId,2);assert.equal(f.data.get(STORAGE_KEY),saved);
});

test("unknown or invalid removal IDs do not save, query or delete anything",()=>{
  const f=fixture(),board=f.manager.create(f.player,"kills",3),saved=f.data.get(STORAGE_KEY);
  f.manager.metrics.scans=0;
  for(const id of [undefined,null,"",0,-1,1.5,"kills","1\n",true,{},9007199254740992,999])assert.throws(()=>f.manager.remove(id));
  assert.equal(f.manager.metrics.scans,0);assert.equal(f.data.get(STORAGE_KEY),saved);
  assert.ok(f.entities.every(e=>e.isValid));assert.equal(f.manager.boards[0],board);
  const disabled=new LeaderboardManager(f.world);assert.throws(()=>disabled.remove(board.id),/not ready/);
});

test("late-loaded removed actors are cleaned up even after restart with zero boards",()=>{
  const f=fixture(),board=f.manager.create(f.player,"kills",3);
  // Hide a detached duplicate to represent a chunk outside the loaded query.
  const hidden=f.player.dimension.spawnEntity(BOARD_TYPES[1],board.pose.center);f.entities.pop();
  hidden.setDynamicProperty("ns:leaderboard_id",board.id);
  f.manager.remove(board.id);assert.equal(hidden.isValid,true);
  const reloaded=new LeaderboardManager(f.world);reloaded.load();reloaded.entityLoaded(hidden);
  assert.equal(hidden.isValid,false);assert.equal(reloaded.boards.length,0);
  const demo=f.player.dimension.spawnEntity("ns:interface_panel",board.pose.center);
  reloaded.entityLoaded(demo);assert.equal(demo.isValid,true);
});

test("entity load preserves configured boards, rejects wrong-dimension orphans and respects unready storage",()=>{
  const f=fixture(),board=f.manager.create(f.player,"kills",3);
  for(const e of f.entities)f.manager.entityLoaded(e);assert.ok(f.entities.every(e=>e.isValid));
  const stray=f.player.dimension.spawnEntity(BOARD_TYPES[0],board.pose.center);
  stray.setDynamicProperty("ns:leaderboard_id",board.id);stray.dimension={id:"minecraft:nether"};
  const unready=new LeaderboardManager(f.world);unready.entityLoaded(stray);assert.equal(stray.isValid,true);
  f.manager.entityLoaded(stray);assert.equal(stray.isValid,false);
});
