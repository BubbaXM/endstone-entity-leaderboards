import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { world, system, sentScriptEvents, flushScheduled, ScriptEventSource, playerFixture, scoreboardObjective } from "./server-mock.mjs";
import { PacketHandoff, PACKET_MARKER } from "../behavior_pack/scripts/leaderboard/migration.js";
import { UI, PAGES, PAGE_IDS, ALPHABET, textCells } from "../behavior_pack/scripts/ui/layouts.js";
const nonce="a".repeat(32);
const event=(id,message={},sourceType=ScriptEventSource.Server)=>({id,sourceType,message:JSON.stringify({nonce,...message})});
function setup(){world.setDynamicProperty(PACKET_MARKER,undefined);world.setDynamicProperty("ns:leaderboards",undefined);sentScriptEvents.length=0;const manager={ready:true},stops=[];const handoff=new PacketHandoff(manager,()=>stops.push(1));handoff.load();return {handoff,manager,stops};}
test("generated packet contract has exactly the baked glyph order and BP property indices",async()=>{
  const layout=JSON.parse(await readFile(new URL("../server_bridge/ns_lb_bridge/layout.json",import.meta.url)));
  assert.deepEqual(layout.cells,textCells(PAGES[PAGE_IDS.leaderboard]));assert.deepEqual(layout.ui,UI);assert.equal(layout.alphabet,ALPHABET);
  for(const [kind,schema] of Object.entries(layout.schemas)){
    const bp=JSON.parse(await readFile(new URL(`../behavior_pack/entities/${kind.split(":")[1]}.json`,import.meta.url)));
    assert.deepEqual(schema,bp["minecraft:entity"].description.properties);assert.ok(Object.keys(schema).length<=32);
  }
});
test("legacy export includes offline player scores only, uses chunks and does not stop/remove before ACK",()=>{
  const {handoff,manager,stops}=setup(),f=playerFixture();
  const board={id:"1",objective:"migration",amount:15,dimension:f.player.dimension.id,pose:{center:{x:0,y:2,z:3},rotation:{x:0,y:0}}};
  const original=JSON.stringify({version:1,nextId:2,boards:[board]});world.setDynamicProperty("ns:leaderboards",original);
  scoreboardObjective("migration",[{participant:{id:20,type:"Player",displayName:"Offline 💜"},score:10},{participant:{id:21,type:"FakePlayer",displayName:"fake"},score:99}]);
  const old=f.player.dimension.spawnEntity("ns:leaderboard_panel",board.pose.center);
  handoff.handle(event("ns:lb_packet_export"));flushScheduled();
  const messages=sentScriptEvents.map(e=>JSON.parse(e.message));
  assert.equal(messages[0].kind,"begin");assert.equal(messages.at(-1).kind,"end");
  const payload=JSON.parse(messages.filter(e=>e.kind==="chunk").map(e=>e.data).join(""));
  assert.deepEqual(payload.registry.boards,[board]);assert.deepEqual(payload.scores.migration,[{id:"20",name:"Offline 💜",score:10}]);
  assert.ok(messages.filter(e=>e.kind==="chunk").every(e=>/^[\x00-\x7f]*$/.test(e.data)&&e.data.length<=400));
  assert.equal(manager.ready,true);assert.equal(old.isValid,true);assert.equal(stops.length,0);
  handoff.handle(event("ns:lb_packet_ack"));flushScheduled();
  assert.equal(world.getDynamicProperty(PACKET_MARKER),true);assert.equal(manager.ready,false);assert.equal(old.isValid,false);assert.equal(stops.length,1);
  assert.equal(world.getDynamicProperty("ns:leaderboards"),original);assert.equal(JSON.parse(sentScriptEvents.at(-1).message).kind,"complete");
});
test("spoofed origins and wrong-nonce acknowledgements cannot migrate or delete actors",()=>{
  const {handoff,manager}=setup();
  handoff.handle(event("ns:lb_packet_export",{},ScriptEventSource.Entity));flushScheduled();assert.equal(sentScriptEvents.length,0);
  handoff.handle(event("ns:lb_packet_ack",{nonce:"b".repeat(32)}));flushScheduled();assert.equal(manager.ready,true);assert.equal(handoff.active,false);
});
test("already migrated startup never exports stale registry/scores and cleans late old actors",()=>{
  const {handoff}=setup();world.setDynamicProperty(PACKET_MARKER,true);world.setDynamicProperty("ns:leaderboards","invalid stale data");handoff.load();
  handoff.handle(event("ns:lb_packet_export"));flushScheduled();assert.deepEqual(JSON.parse(sentScriptEvents[0].message),{nonce,kind:"active"});
  const f=playerFixture(),old=f.player.dimension.spawnEntity("ns:leaderboard_text",{x:0,y:0,z:0}),interactive=f.player.dimension.spawnEntity("ns:text_layer",{x:0,y:0,z:0});
  handoff.cleanup(old);handoff.cleanup(interactive);assert.equal(old.isValid,false);assert.equal(interactive.isValid,true);
});
test("invalid legacy storage is preserved and no export acknowledgement can occur",()=>{
  const {handoff}=setup();world.setDynamicProperty("ns:leaderboards",JSON.stringify({version:1,nextId:1,boards:[{id:"broken"}]}));
  handoff.handle(event("ns:lb_packet_export"));flushScheduled();assert.equal(sentScriptEvents.length,0);assert.equal(handoff.active,false);
});
