import test from "node:test";
import assert from "node:assert/strict";
import { system, playerFixture } from "./server-mock.mjs";
import { InterfaceSession, spawnPose } from "../behavior_pack/scripts/ui/session.js";
import { UI } from "../behavior_pack/scripts/ui/layouts.js";
import { unpackPair } from "../behavior_pack/scripts/ui/core.js";

function fixture(item=UI.item) {
  system.currentTick=0;const f=playerFixture();f.inventory[0]={typeId:item,amount:1};
  return {...f,session:new InterfaceSession(f.player,()=>{},item)};
}
function aim(session,x,y) {
  const head=session.player.getHeadLocation();head.y+=0.1;
  const u=(x-UI.width/2)/UI.pxPerBlock,v=(UI.height/2-y)/UI.pxPerBlock;
  const target={x:session.pose.center.x+session.pose.right.x*u,y:session.pose.center.y+v,z:session.pose.center.z+session.pose.right.z*u};
  const d={x:target.x-head.x,y:target.y-head.y,z:target.z-head.z},length=Math.hypot(d.x,d.y,d.z);
  session.player.direction={x:d.x/length,y:d.y/length,z:d.z/length};
}
test("session creates panel and overflow layers; unchanged render sends no properties",()=>{
  const {session,writes}=fixture();assert.equal(session.panel.typeId,"ns:interface_panel");assert.ok(session.layers.length>1);
  writes.length=0;session.refresh();assert.equal(writes.length,0);
  session.close();assert.equal(session.closed,true);
});
test("item use navigates hovered control; stack back restores previous page",()=>{
  const {session}=fixture();aim(session,80,121);session.click();assert.equal(session.page.id,"controls");
  aim(session,36,22);session.click();assert.equal(session.page.id,"dashboard");
});
test("disabled controls cannot dispatch an action",()=>{
  const {session,titles}=fixture();session.state.enabled=false;session.navigate("controls");aim(session,250,71);session.click();
  assert.match(titles.at(-1)[0],/disabled/);assert.equal(session.page.id,"controls");
});
test("confirm and exact editor pop results to callbacks",()=>{
  const {session}=fixture(),results=[];
  session.confirm("TEST",r=>results.push(r));aim(session,90,142);session.click();assert.deepEqual(results,[true]);
  session.amount("AMOUNT",16,1,999999,r=>results.push(r));session.controller.action(session.context(),"digit:7");
  session.controller.action(session.context(),"done");assert.deepEqual(results,[true,7]);assert.equal(session.page.id,"dashboard");
});
test("slot tooltip follows hover and only changed packed glyphs are resent",()=>{
  const {session,inventory,writes}=fixture();inventory[1]={typeId:"minecraft:apple",amount:4};session.navigate("inventory");
  aim(session,88,77);session.refresh();assert.equal(session.panel.properties["ns:tip_on"],1);
  writes.length=0;session.refresh();assert.equal(writes.length,0);
  assert.ok(session.layers.some(e=>e.properties["ns:tip_on"]===1));
});
test("camera occlusion rejects clicks through terrain",()=>{
  const {session,player}=fixture();player.dimension.getBlockFromRay=()=>({block:{}});aim(session,80,121);session.click();assert.equal(session.closed,true);
});
test("off-panel use removes every entity and cancels pending editors",()=>{
  const {session,entities}=fixture(),results=[];session.keyboard("TEST","",20,r=>results.push(r));
  session.player.direction={x:1,y:0,z:0};session.click();assert.equal(session.closed,true);
  assert.ok(entities.every(e=>!e.isValid));assert.deepEqual(results,[undefined]);
});
for(const reason of ["walk","switch","die","dimension","invalid"]){
  test(`automatic close on ${reason}`,()=>{
    const {session,player,inventory}=fixture();
    if(reason==="walk")player.head.x=10;
    if(reason==="switch")inventory[0]={typeId:"minecraft:stick"};
    if(reason==="die")player.health=0;
    if(reason==="dimension")player.dimension={...player.dimension,id:"minecraft:nether"};
    if(reason==="invalid")session.layers[0].isValid=false;
    system.currentTick++;session.tick();assert.equal(session.closed,true);
  });
}
test("ground clipping raises the panel exactly one block",()=>{
  const f=playerFixture(),normal=spawnPose(f.player);f.player.dimension.getBlock=()=>({isAir:false,isLiquid:false});
  const lifted=spawnPose(f.player);assert.equal(lifted.center.y,normal.center.y+1);
});

test("ground detection covers the enlarged panel's entire five-block bottom edge",()=>{
  const f=playerFixture(),samples=[];
  f.player.dimension.getBlock=location=>{samples.push(location);return {isAir:true};};
  const pose=spawnPose(f.player),width=UI.width/UI.pxPerBlock*UI.scale,height=UI.height/UI.pxPerBlock*UI.scale;
  assert.equal(width,5);assert.equal(height,3);assert.equal(samples.length,9);
  assert.ok(Math.abs(Math.abs(samples[8].x-samples[0].x)-width)<1e-7);
  assert.ok(samples.every(p=>Math.abs(p.y-(pose.center.y-height/2))<1e-7));
  f.player.dimension.getBlock=location=>({isAir:Math.abs(location.x)<=1.1,isLiquid:false});
  assert.equal(spawnPose(f.player).center.y,pose.center.y+1,"New outer edges must trigger the ground lift too");
});

test("cursor uses the full enlarged canvas, including its far right and bottom",()=>{
  const {session}=fixture();
  for(const [x,y] of [[1,1],[UI.width-1,1],[1,UI.height-1],[UI.width-1,UI.height-1]]){
    aim(session,x,y);session.refresh();
    assert.equal(session.panel.properties["ns:cursor_on"],1);
    assert.deepEqual(unpackPair(session.panel.properties["ns:cursor_xy"]),[x,y]);
  }
});
test("panel and every glyph layer apply the corrected model heading in all four directions",()=>{
  for(const [x,z,expected] of [[0,1,0],[1,0,-90],[0,-1,-180],[-1,0,90]]) {
    const f=playerFixture();f.player.direction={x,y:0,z};const session=new InterfaceSession(f.player,()=>{});
    assert.equal(session.panel.rotation.y,expected);
    assert.ok(session.layers.every(e=>e.rotation.y===expected));
    // The 180-degree render correction must not mirror gaze coordinates.
    aim(session,80,121);session.refresh();assert.equal(session.hover.id,"controls");session.close();
  }
});
test("circle cursor tracks gaze every tick even inside the same button",()=>{
  const {session}=fixture();aim(session,60,121);session.refresh();
  assert.equal(session.panel.properties["ns:cursor_on"],1);
  const before=session.panel.properties["ns:cursor_xy"];aim(session,100,121);system.currentTick++;session.tick();
  assert.notEqual(session.panel.properties["ns:cursor_xy"],before);
  assert.deepEqual(unpackPair(session.panel.properties["ns:cursor_xy"]),[100,121]);
  session.player.direction={x:1,y:0,z:0};system.currentTick++;session.tick();
  assert.equal(session.panel.properties["ns:cursor_on"],0);
});
test("cursor is hidden without the selected remote",()=>{
  const {session,inventory}=fixture();inventory[0]={typeId:"minecraft:stick"};session.refresh();
  assert.equal(session.panel.properties["ns:cursor_on"],0);
});
test("owned panel/text-layer interactions select gaze buttons without off-panel closing",()=>{
  const {session}=fixture();aim(session,80,121);assert.equal(session.interact(session.panel),true);
  assert.equal(session.page.id,"controls");aim(session,36,22);session.interact(session.layers[0]);assert.equal(session.page.id,"dashboard");
  session.player.direction={x:1,y:0,z:0};session.interact(session.panel);assert.equal(session.closed,false);
});
test("foreign entities and interactions without a remote cannot select buttons",()=>{
  const {session,inventory}=fixture();aim(session,80,121);
  assert.equal(session.interact({id:"foreign-panel"}),false);assert.equal(session.page.id,"dashboard");
  inventory[0]={typeId:"minecraft:stick"};assert.equal(session.interact(session.panel),false);assert.equal(session.page.id,"dashboard");
});

test("transparent mode survives navigation, inventory tooltips and editor callbacks",()=>{
  const {session,inventory}=fixture("ns:transparent_remote"),results=[];
  assert.equal(session.panel.properties["ns:transparent"],1);
  inventory[1]={typeId:"minecraft:apple",amount:4};session.navigate("inventory");
  aim(session,88,77);session.refresh();assert.equal(session.panel.properties["ns:tip_on"],1);
  session.keyboard("TEST","AB",20,result=>results.push(result));
  session.controller.action(session.context(),"key:C");session.controller.action(session.context(),"done");
  assert.deepEqual(results,["ABC"]);assert.equal(session.page.id,"inventory");
  assert.equal(session.panel.properties["ns:transparent"],1);
});

test("each GUI closes when the player switches to the other remote",()=>{
  for(const [item,next] of [[UI.item,"ns:transparent_remote"],["ns:transparent_remote",UI.item]]){
    const {session,inventory,entities}=fixture(item);inventory[0]={typeId:next,amount:1};system.currentTick++;session.tick();
    assert.equal(session.closed,true);assert.ok(entities.every(e=>!e.isValid));
  }
});

test("invalid remote variants cannot create panel entities",()=>{
  const {player,entities}=playerFixture();
  assert.throws(()=>new InterfaceSession(player,()=>{},"minecraft:stick"),/Unknown interface remote/);
  assert.equal(entities.length,0);
});
