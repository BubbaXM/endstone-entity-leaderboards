import test from "node:test";
import assert from "node:assert/strict";
import { system, world, playerFixture, flushScheduled, scoreboardObjective, ScriptEventSource } from "./server-mock.mjs";
import { UI } from "../behavior_pack/scripts/ui/layouts.js";
import { leaderboards } from "../behavior_pack/scripts/main.js";

let remote;
system.beforeEvents.startup.emit({itemComponentRegistry:{registerCustomComponent:(id,c)=>{remote=c;}}});
world.afterEvents.worldLoad.emit({});
function opened(item=UI.item) {
  world.afterEvents.playerLeave.emit({playerId:"player-1"});system.currentTick+=10;
  const f=playerFixture();f.inventory[0]={typeId:item,amount:1};remote.onUse({source:f.player});flushScheduled();
  return {...f,panel:f.entities.find(e=>e.typeId==="ns:interface_panel")};
}
function aim(f,x,y) {
  const head=f.player.getHeadLocation();head.y+=0.1;
  const d={x:f.panel.location.x-(x-UI.width/2)/UI.pxPerBlock-head.x,
    y:f.panel.location.y+(UI.height/2-y)/UI.pxPerBlock-head.y,z:f.panel.location.z-head.z};
  const length=Math.hypot(d.x,d.y,d.z);f.player.direction=Object.fromEntries(Object.entries(d).map(([k,v])=>[k,v/length]));
}
function interact(f,target=f.panel,itemStack=f.inventory[0]) {
  const event={player:f.player,target,itemStack,cancel:false};
  world.beforeEvents.playerInteractWithEntity.emit(event);flushScheduled();return event;
}
test("native entity interaction routes to the owner's hovered button",()=>{
  const f=opened();assert.equal(f.panel.properties["ns:page"],0);aim(f,80,121);system.currentTick+=5;
  assert.equal(interact(f).cancel,true);assert.equal(f.panel.properties["ns:page"],1);
  aim(f,36,22);system.currentTick+=5;interact(f,f.entities.find(e=>e.typeId==="ns:text_layer"));
  assert.equal(f.panel.properties["ns:page"],0);
});
test("native interaction uses selected remote when the event omits itemStack",()=>{
  const f=opened();aim(f,80,121);system.currentTick+=5;
  const event={player:f.player,target:f.panel,cancel:false};world.beforeEvents.playerInteractWithEntity.emit(event);flushScheduled();
  assert.equal(event.cancel,true);assert.equal(f.panel.properties["ns:page"],1);
});
test("native interaction and item use share debounce to prevent double actions",()=>{
  const f=opened();aim(f,80,121);system.currentTick+=5;
  interact(f);aim(f,55,71);system.currentTick+=5;
  world.beforeEvents.playerInteractWithEntity.emit({player:f.player,target:f.panel,itemStack:f.inventory[0]});
  remote.onUse({source:f.player});flushScheduled();
  assert.equal(JSON.parse(f.player.data["ns:demo_settings"]).enabled,false);
  // Two dispatches would flip the same toggle back to true.
});
test("native interaction refuses a foreign panel or an unrelated held item",()=>{
  const f=opened();aim(f,80,121);system.currentTick+=5;
  assert.equal(interact(f,{id:"someone-else",typeId:"ns:interface_panel"}).cancel,true);
  assert.equal(f.panel.properties["ns:page"],0);
  f.inventory[0]={typeId:"minecraft:stick"};assert.equal(interact(f).cancel,true);assert.equal(f.panel.properties["ns:page"],0);
});

test("transparent remote opens its own variant and selects buttons through native interaction",()=>{
  const f=opened("ns:transparent_remote");assert.equal(f.panel.properties["ns:transparent"],1);
  aim(f,80,121);system.currentTick+=5;assert.equal(interact(f).cancel,true);
  assert.equal(f.panel.properties["ns:page"],1);assert.equal(f.panel.properties["ns:transparent"],1);
  aim(f,36,22);system.currentTick+=5;interact(f,f.entities.find(e=>e.typeId==="ns:text_layer"));
  assert.equal(f.panel.properties["ns:page"],0);
  f.player.direction={x:1,y:0,z:0};system.currentTick+=5;remote.onUse({source:f.player});flushScheduled();
  assert.ok(f.entities.every(e=>!e.isValid));
});

test("switching either remote replaces the previous variant safely before a cleanup tick",()=>{
  for(const [original,next] of [[UI.item,"ns:transparent_remote"],["ns:transparent_remote",UI.item]]){
    const f=opened(original),old=[...f.entities];f.inventory[0]={typeId:next,amount:1};system.currentTick+=5;
    remote.onUse({source:f.player});flushScheduled();
    assert.ok(old.every(e=>!e.isValid));
    const live=f.entities.filter(e=>e.isValid&&e.typeId==="ns:interface_panel");
    assert.equal(live.length,1);assert.equal(live[0].properties["ns:transparent"],next===UI.item?0:1);
  }
});

test("transparent remote use on a block cancels the block interaction and selects the button",()=>{
  const f=opened("ns:transparent_remote");aim(f,80,121);system.currentTick+=5;
  const event={player:f.player,itemStack:f.inventory[0],isFirstEvent:true,cancel:false};
  world.beforeEvents.playerInteractWithBlock.emit(event);flushScheduled();
  assert.equal(event.cancel,true);assert.equal(f.panel.properties["ns:page"],1);
});

test("console /lb request creates a persistent display without a remote",()=>{
  const f=playerFixture();f.inventory[0]=undefined;scoreboardObjective("kills");
  const before=leaderboards.boards.length;
  system.afterEvents.scriptEventReceive.emit({id:"ns:lb_create",sourceType:ScriptEventSource.Server,
    message:JSON.stringify({player:f.player.name,objective:"kills",amount:15})});flushScheduled();
  assert.equal(leaderboards.boards.length,before+1);
  assert.equal(f.entities.filter(e=>e.typeId==="ns:leaderboard_panel").length,1);
  assert.equal(f.entities.filter(e=>e.typeId==="ns:interface_panel").length,0);
  assert.match(f.titles.at(-1)[0],/created - top 15/);
  const target=f.entities.find(e=>e.typeId==="ns:leaderboard_panel");
  f.inventory[0]={typeId:UI.item,amount:1};
  const event={player:f.player,target,itemStack:f.inventory[0],cancel:false};
  world.beforeEvents.playerInteractWithEntity.emit(event);flushScheduled();
  assert.equal(event.cancel,true);assert.equal(target.isValid,true);
  assert.equal(f.entities.filter(e=>e.typeId==="ns:interface_panel").length,0);
});

test("player-origin /lb script events cannot spoof a permission-checked request",()=>{
  const f=playerFixture(),before=leaderboards.boards.length;
  system.afterEvents.scriptEventReceive.emit({id:"ns:lb_create",sourceType:ScriptEventSource.Entity,
    message:JSON.stringify({player:f.player.name,objective:"kills",amount:5})});flushScheduled();
  assert.equal(leaderboards.boards.length,before);assert.equal(f.entities.length,0);
});

test("invalid console requests reject amounts and missing objectives before spawning",()=>{
  const f=playerFixture(),before=leaderboards.boards.length;
  for(const request of [{objective:"kills",amount:16},{objective:"absent",amount:5}]){
    system.afterEvents.scriptEventReceive.emit({id:"ns:lb_create",sourceType:ScriptEventSource.Server,
      message:JSON.stringify({player:f.player.name,...request})});flushScheduled();
  }
  assert.equal(leaderboards.boards.length,before);assert.equal(f.entities.length,0);
});

test("console /lb remove request deletes its board and confirms without opening a UI",()=>{
  const f=playerFixture();scoreboardObjective("remove-test");
  const board=leaderboards.create(f.player,"remove-test",15),before=leaderboards.boards.length;
  system.afterEvents.scriptEventReceive.emit({id:"ns:lb_remove",sourceType:ScriptEventSource.Server,
    message:JSON.stringify({player:f.player.name,id:board.id})});flushScheduled();
  assert.equal(leaderboards.boards.length,before-1);assert.ok(f.entities.every(e=>!e.isValid));
  assert.match(f.titles.at(-1)[0],new RegExp(`Leaderboard #${board.id} removed`));
  const late=f.player.dimension.spawnEntity("ns:leaderboard_text",board.pose.center);
  late.setDynamicProperty("ns:leaderboard_id",board.id);world.afterEvents.entityLoad.emit({entity:late});
  assert.equal(late.isValid,false);
});

test("spoofed, invalid or offline removal requests cannot delete a board",()=>{
  const f=playerFixture();scoreboardObjective("protected-test");
  const board=leaderboards.create(f.player,"protected-test",3);
  for(const request of [
    {sourceType:ScriptEventSource.Entity,player:f.player.name,id:board.id},
    {sourceType:ScriptEventSource.Server,player:f.player.name,id:"bad"},
    {sourceType:ScriptEventSource.Server,player:f.player.name,id:"99999"},
    {sourceType:ScriptEventSource.Server,player:"Offline",id:board.id},
  ]){
    system.afterEvents.scriptEventReceive.emit({id:"ns:lb_remove",sourceType:request.sourceType,message:JSON.stringify(request)});
    flushScheduled();assert.ok(leaderboards.boards.includes(board));assert.ok(f.entities.every(e=>e.isValid));
  }
});
