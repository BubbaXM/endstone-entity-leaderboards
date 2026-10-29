import { system, world, ScriptEventSource } from "@minecraft/server";
import { UI, REMOTES } from "./ui/layouts.js";
import { InterfaceSession } from "./ui/session.js";
import { LeaderboardManager, BOARD_TYPES } from "./leaderboard/manager.js";
import { PacketHandoff } from "./leaderboard/migration.js";
export const leaderboards=new LeaderboardManager(world);
let leaderboardTimer;
export const packetHandoff=new PacketHandoff(leaderboards,()=>{if(leaderboardTimer!==undefined){system.clearRun(leaderboardTimer);leaderboardTimer=undefined;}});

const sessions=new Map(),lastUse=new Map();
let ready=false;
function use(player,target) {
  if(!ready)return;
  const blackjack=sessions.get(player.id);
  if(blackjack?.kind==="blackjack"){
    if(target&&!blackjack.ownsEntity(target))return;
    const now=system.currentTick;
    if(now-(lastUse.get(player.id)??-100)<4)return;
    lastUse.set(player.id,now);
    if(target)blackjack.interact(target);else blackjack.click(false);
    return;
  }
  const held=player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex)?.typeId;
  if(!Object.hasOwn(REMOTES,held??""))return;
  // Entity clicks select the owner's existing panel, never open another session
  // or operate a different player's UI. Keep the same debounce as remote use.
  if(target && !sessions.get(player.id)?.ownsEntity(target))return;
  const now=system.currentTick;
  if(now-(lastUse.get(player.id)??-100)<4)return;
  lastUse.set(player.id,now);
  try {
    let session=sessions.get(player.id);
    // If use arrives before the next cleanup tick, switching remotes still
    // closes the old variant. Entity clicks cannot open a replacement panel.
    if(session && session.remoteItem!==held){session.close();session=undefined;if(target)return;}
    if(session){if(target)session.interact(target);else session.click();}
    else {
      const created=new InterfaceSession(player,id=>sessions.delete(id),held);
      if(!created.closed)sessions.set(player.id,created);
    }
  } catch(error) {
    sessions.get(player.id)?.close();
    console.warn(`[Entity UI] Could not use panel: ${error}`);
    player.onScreenDisplay.setTitle(UI.toastPrefix+"Panel error - check the content log",{fadeInDuration:0,stayDuration:50,fadeOutDuration:10});
  }
}
// Stable custom component V2. Remote use never opens a form or consumes an item.
system.beforeEvents.startup.subscribe(event=>{
  event.itemComponentRegistry.registerCustomComponent("ns:interface_remote",{
    onUse(event){if(event.source.typeId==="minecraft:player")system.run(()=>use(event.source));}
  });
});
// Cancel block interactions, while treating use-on-block as the same remote click.
world.beforeEvents.playerInteractWithBlock.subscribe(event=>{
  if(sessions.get(event.player.id)?.kind==="blackjack"&&sessions.get(event.player.id).gaze()){
    event.cancel=true;if(event.isFirstEvent)system.run(()=>use(event.player));return;
  }
  if(!Object.hasOwn(REMOTES,event.itemStack?.typeId??""))return;
  event.cancel=true;if(event.isFirstEvent)system.run(()=>use(event.player));
});
world.beforeEvents.playerInteractWithEntity.subscribe(event=>{
  const {player,target,itemStack}=event;
  if(BOARD_TYPES.includes(target.typeId)){event.cancel=true;return;}
  if(target.typeId==="ns:interface_panel" || target.typeId==="ns:text_layer") {
    event.cancel=true;
    if(sessions.get(player.id)?.kind==="blackjack"){
      if(sessions.get(player.id).ownsEntity(target))system.run(()=>use(player,target));return;
    }
    const held=player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex);
    if(!Object.hasOwn(REMOTES,itemStack?.typeId??held?.typeId??""))return;
    if(!sessions.get(player.id)?.ownsEntity(target))return;
    system.run(()=>use(player,target));return;
  }
  if(!Object.hasOwn(REMOTES,itemStack?.typeId??""))return;
  event.cancel=true;system.run(()=>use(player));
});
function sweep() {
  const live=new Set([...sessions.values()].flatMap(s=>[s.panel?.id,...s.layers.map(e=>e.id)]));
  for(const dimension of ["overworld","nether","the_end"]) {
    for(const type of ["ns:interface_panel","ns:text_layer"]) {
      for(const entity of world.getDimension(dimension).getEntities({type}))if(!live.has(entity.id))entity.remove();
    }
  }
}
world.afterEvents.worldLoad.subscribe(()=>{
  // Includes entities left behind by a previous script reload/server shutdown.
  sweep();ready=true;
  packetHandoff.load();
  if(!packetHandoff.active){
    try{leaderboards.load();}catch(error){console.warn(`[Leaderboard] ${error}`);}
    leaderboardTimer=system.runInterval(()=>{try{leaderboards.tick();}catch(error){console.warn(`[Leaderboard] Update failed: ${error}`);}},20);
  }
});
world.afterEvents.entityLoad.subscribe(({entity})=>{
  try{if(packetHandoff.active)packetHandoff.cleanup(entity);else leaderboards.entityLoaded(entity);}catch(error){console.warn(`[Leaderboard] Loaded actor cleanup deferred: ${error}`);}
});
// Exact /lb is registered by the small Endstone bridge. Only server-origin
// messages are accepted; players cannot spoof a requester via /scriptevent.
system.afterEvents.scriptEventReceive.subscribe(event=>{
  if(["ns:bj_open","ns:bj_view","ns:bj_close"].includes(event.id)){
    if(event.sourceType!==ScriptEventSource.Server)return;
    system.run(()=>{
      try{
        const request=JSON.parse(event.message),player=world.getPlayers().find(p=>p.name===request.player);
        if(!player||!ready)return;
        let session=sessions.get(player.id);
        if(event.id==="ns:bj_open"){
          if(typeof request.token!=="string"||!/^[a-f0-9]{32}$/.test(request.token))return;
          if(session){if(session.blackjack)session.blackjack.suppressClose=true;session.close();}
          const blackjack={token:request.token,view:request.view,pending:false,suppressClose:false};
          session=new InterfaceSession(player,id=>{
            sessions.delete(id);
            if(!blackjack.suppressClose)system.sendScriptEvent("ns:bj_close_request",JSON.stringify({token:blackjack.token}));
          },UI.item,{kind:"blackjack",requireRemote:false,page:"blackjack",blackjack});
          sessions.set(player.id,session);
        }else if(session?.kind==="blackjack"&&session.blackjack.token===request.token){
          if(event.id==="ns:bj_close"){session.blackjack.suppressClose=true;session.close();}
          else if(request.view.revision>=session.blackjack.view.revision){
            session.blackjack.view=request.view;session.blackjack.pending=false;session.blackjack.error=request.error??"";session.refresh();
          }
        }
      }catch(error){console.warn(`[Blackjack UI] ${error}`);}
    });return;
  }
  if(packetHandoff.handle(event)||packetHandoff.active)return;
  if(!["ns:lb_create","ns:lb_remove"].includes(event.id)||event.sourceType!==ScriptEventSource.Server)return;
  system.run(()=>{
    let player;
    try{
      const request=JSON.parse(event.message);
      player=world.getPlayers().find(p=>p.name===request.player);
      if(!player)throw Error("Leaderboard requester is no longer online.");
      const removing=event.id==="ns:lb_remove";
      const board=removing?leaderboards.remove(request.id):leaderboards.create(player,request.objective,request.amount);
      const message=removing?`Leaderboard #${board.id} removed`:`Leaderboard #${board.id} created - top ${board.amount}`;
      player.onScreenDisplay.setTitle(UI.toastPrefix+message,{fadeInDuration:0,stayDuration:70,fadeOutDuration:10});
    }catch(error){
      console.warn(`[Leaderboard] ${event.id==="ns:lb_remove"?"Remove":"Create"} failed: ${error}`);
      player?.onScreenDisplay.setTitle(UI.toastPrefix+String(error.message??error),{fadeInDuration:0,stayDuration:90,fadeOutDuration:10});
    }
  });
},{namespaces:["ns"]});
world.afterEvents.playerLeave.subscribe(event=>{
  sessions.get(event.playerId)?.close();lastUse.delete(event.playerId);
});
world.afterEvents.entityDie.subscribe(event=>sessions.get(event.deadEntity.id)?.close());
system.runInterval(()=>{
  if(!ready)return;
  for(const session of sessions.values()) {
    try{session.tick();}catch(error){console.warn(`[Entity UI] Session closed after error: ${error}`);session.close();}
  }
},1);
// The initial sweep can only see loaded chunks. Re-check loaded chunks periodically;
// resettable entity timers are the second defence against late-loaded orphans.
system.runInterval(()=>{if(ready)sweep();},200);
