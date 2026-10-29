import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { system,world,playerFixture,flushScheduled,sentScriptEvents,ScriptEventSource } from "./server-mock.mjs";
import { InterfaceSession } from "../behavior_pack/scripts/ui/session.js";
import { UI,PAGE_IDS,PAGES } from "../behavior_pack/scripts/ui/layouts.js";
import { CARD,playingCard } from "../tools/cards.mjs";
import "../behavior_pack/scripts/main.js";

const token="a".repeat(32),view=()=>({revision:1,balance:900,bet:100,phase:"player",active:0,
  dealer:[10,53],dealerTotal:"10 + ?",hands:[{cards:[5,6],total:11,soft:false,bet:100,result:"PLAYING"}],legal:["hit","stand","double","surrender"],message:"PLAY HAND 1"});
function fixture(){const f=playerFixture();f.inventory[0]=undefined;const blackjack={token,view:view(),pending:false};
  const session=new InterfaceSession(f.player,()=>{},UI.item,{page:"blackjack",kind:"blackjack",requireRemote:false,blackjack});
  return {...f,session,blackjack};}
function aim(panel,player,x,y){const head=player.getHeadLocation();head.y+=0.1;const d={x:panel.location.x-(x-UI.width/2)/UI.pxPerBlock-head.x,y:panel.location.y+(UI.height/2-y)/UI.pxPerBlock-head.y,z:panel.location.z-head.z};const n=Math.hypot(d.x,d.y,d.z);player.direction=Object.fromEntries(Object.entries(d).map(([k,v])=>[k,v/n]));}
test("blackjack opens without remote and owned entity interaction sends authenticated action once",()=>{
  const {session,player,blackjack}=fixture();sentScriptEvents.length=0;aim(session.panel,player,80,370);
  assert.equal(session.interact(session.panel),true);assert.equal(sentScriptEvents.length,1);
  assert.deepEqual(JSON.parse(sentScriptEvents[0].message),{token,action:"hit",revision:1});
  session.interact(session.panel);assert.equal(sentScriptEvents.length,1);assert.equal(blackjack.pending,true);session.close();
});
test("illegal/unaffordable blackjack buttons are disabled without sending actions",()=>{
  const {session,player}=fixture();sentScriptEvents.length=0;aim(session.panel,player,450,370);session.click();
  assert.equal(sentScriptEvents.length,0);session.close();
});
test("card property packing stays exact and hides unused cards",()=>{
  const {session}=fixture();assert.equal(session.panel.properties["ns:cards0"],10+53*64);
  assert.equal(session.panel.properties["ns:cards3"],5+6*64);
  for(let i=0;i<6;i++){const value=session.panel.properties[`ns:cards${i}`];assert.equal(Math.fround(value),value);assert.ok(value<2**24);}
  session.navigate("blackjack_rules");for(let i=0;i<6;i++)assert.equal(session.panel.properties[`ns:cards${i}`],0);session.close();
});
test("long player hands can be paged and split results inspected",()=>{
  const {session,blackjack}=fixture();blackjack.view.phase="settled";blackjack.view.legal=["bet","deal"];
  blackjack.view.hands[0].cards=Array.from({length:15},(_,i)=>i+1);blackjack.view.hands.push({cards:[20,21],total:19,bet:100,result:"WIN"});
  session.refresh();session.controller.action(session.context(),"cards_next");session.refresh();assert.equal(session.view.cards[12],13);
  session.controller.action(session.context(),"hand1");session.refresh();assert.equal(session.view.cards[12],20);session.close();
});
test("switching held items does not close a command-opened blackjack table",()=>{
  const {session,inventory}=fixture();inventory[0]={typeId:"minecraft:stick"};system.currentTick+=5;session.tick();assert.equal(session.closed,false);session.close();
});
test("server-origin open/view/close routes correctly and spoofed messages cannot open blackjack",()=>{
  world.afterEvents.playerLeave.emit({playerId:"player-1"});world.afterEvents.worldLoad.emit({});const f=playerFixture();f.inventory[0]=undefined;
  const payload={player:f.player.name,token,view:view()};
  system.afterEvents.scriptEventReceive.emit({id:"ns:bj_open",message:JSON.stringify(payload),sourceType:ScriptEventSource.Entity});flushScheduled();assert.equal(f.entities.length,0);
  system.afterEvents.scriptEventReceive.emit({id:"ns:bj_open",message:JSON.stringify(payload),sourceType:ScriptEventSource.Server});flushScheduled();
  const panel=f.entities.find(e=>e.typeId==="ns:interface_panel");assert.equal(panel.properties["ns:page"],PAGE_IDS.blackjack);
  aim(panel,f.player,80,370);system.currentTick+=10;sentScriptEvents.length=0;
  world.beforeEvents.playerInteractWithEntity.emit({player:f.player,target:panel});flushScheduled();assert.equal(sentScriptEvents[0].id,"ns:bj_action");
  system.afterEvents.scriptEventReceive.emit({id:"ns:bj_close",message:JSON.stringify({player:f.player.name,token}),sourceType:ScriptEventSource.Server});flushScheduled();
  assert.ok(f.entities.every(e=>!e.isValid));assert.equal(sentScriptEvents.length,1);
});
test("all 52 face sprites are distinct and a separate back is supplied",()=>{
  assert.equal(CARD.count,54);assert.equal(new Set(Array.from({length:52},(_,i)=>playingCard(i+1).data.toString("base64"))).size,52);
  assert.ok(playingCard(0).data.every(b=>b===0));assert.notDeepEqual(playingCard(53).data,playingCard(1).data);
});
test("blackjack glyph/button/card model positions use the existing front-facing UI mapping",async()=>{
  const client=JSON.parse(await readFile(new URL("../resource_pack/entity/interface_panel.entity.json",import.meta.url)))["minecraft:client_entity"].description;
  assert.equal(client.materials.animated,"player_animated");assert.equal(PAGES[PAGE_IDS.blackjack].playingCards.length,24);
  for(const slot of [0,11,12,23]){assert.equal(client.geometry[`bj_card${slot}`],`geometry.ns.bj_card${slot}`);}
});
