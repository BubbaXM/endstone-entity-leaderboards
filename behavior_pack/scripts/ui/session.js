import { system } from "@minecraft/server";
import { UI, REMOTES, PAGES, PAGE_IDS, textCells } from "./layouts.js";
import { controllers, loadState } from "./controllers.js";
import { changedProperties, distance, fieldCharacters, hitTest, intersectPanel, packGlyphs, packPair, stateMasks, clamp } from "./core.js";

function valid(entity) { try{return entity?.isValid === true;}catch{return false;} }
function remove(entity) { try{if(valid(entity))entity.remove();}catch{} }
/** @param {import('@minecraft/server').Player} player */
function selectedItem(player) {
  return player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex)?.typeId;
}
function apply(entity,cache,properties) {
  for(const [key,value] of changedProperties(cache,properties)) {
    entity.setProperty(key,value);cache.set(key,value);
  }
}
/** @param {import('@minecraft/server').Player} player */
export function spawnPose(player) {
  const view=player.getViewDirection(),head=player.getHeadLocation(),length=Math.hypot(view.x,view.z);
  const yaw=player.getRotation().y*Math.PI/180;
  const forward=length>0.001?{x:view.x/length,z:view.z/length}:{x:-Math.sin(yaw),z:Math.cos(yaw)};
  const normal={x:-forward.x,y:0,z:-forward.z};
  const center={x:head.x+view.x*UI.distance,y:head.y+0.1+view.y*UI.distance,z:head.z+view.z*UI.distance};
  const right={x:normal.z,y:0,z:-normal.x};
  // Sample the entire bottom edge, not only the tiny entity collision box.
  let clips=false;
  for(let i=0;i<=8;i++) {
    const offset=(i/8-0.5)*UI.width/UI.pxPerBlock*UI.scale;
    const location={x:center.x+right.x*offset,y:center.y-UI.height*UI.scale/(2*UI.pxPerBlock),z:center.z+right.z*offset};
    try{const b=player.dimension.getBlock(location);if(b && !b.isAir && !b.isLiquid)clips=true;}catch{clips=true;}
  }
  if(clips)center.y+=1;
  // Keep the front-facing yaw correction. The builder separately converts UI
  // +X (screen right) to model -X; the logical gaze plane/basis is unchanged.
  const renderYaw=Math.atan2(-normal.x,normal.z)*180/Math.PI+180;
  return {center,normal,right,rotation:{x:0,y:((renderYaw+180)%360+360)%360-180}};
}
export class InterfaceSession {
  /** @param {import('@minecraft/server').Player} player */
  constructor(player,onClose,remoteItem=UI.item,options={}) {
    if(!Object.hasOwn(REMOTES,remoteItem))throw Error(`Unknown interface remote: ${remoteItem}`);
    this.remoteItem=remoteItem;this.transparent=REMOTES[remoteItem].transparent;
    this.requireRemote=options.requireRemote!==false;this.kind=options.kind??"demo";this.blackjack=options.blackjack;
    this.player=player;this.onClose=onClose;this.state=loadState(player);this.stack=[];
    this.layers=[];this.cache=new Map();this.layerCaches=[];this.closed=false;
    this.dimension=player.dimension.id;this.pose=spawnPose(player);this.toastUntil=0;this.toastText="";
    try {
      this.panel=player.dimension.spawnEntity("ns:interface_panel",this.pose.center);
      this.panel.addTag(`ns:owner:${player.id}`);this.panel.setDynamicProperty("ns:owner",player.id);
      this.panel.teleport(this.pose.center,{rotation:this.pose.rotation});
      this.navigate(options.page??"dashboard");
    } catch(error) { this.close();throw error; }
  }
  context() { const frame=this.stack.at(-1);return {player:this.player,session:this,state:this.state,args:frame.args,data:frame.data}; }
  get page() { return PAGES[PAGE_IDS[this.stack.at(-1).id]]; }
  get controller() { return controllers[this.stack.at(-1).id]; }
  navigate(id,args={}) {
    if(!controllers[id]||PAGE_IDS[id]===undefined)throw Error(`Unknown interface page: ${id}`);
    this.stack.push({id,args,data:{}});this.controller.enter?.(this.context());this.enterPage();
  }
  back(result) {
    if(this.stack.length<=1){this.close();return;}
    const old=this.stack.pop();this.enterPage();old.args.onResult?.(result);
    if(!this.closed)this.refresh();
  }
  confirm(message,onResult) { this.navigate("confirm",{message,onResult}); }
  keyboard(prompt,initial,maxLength,onResult) { this.navigate("keyboard",{prompt,initial,maxLength:clamp(maxLength,1,44),onResult}); }
  amount(prompt,initial,min,max,onResult) { this.navigate("amount",{prompt,initial,min,max,onResult}); }
  enterPage() {
    this.hover=null;this.point=null;this.cells=textCells(this.page);this.cellCount=Math.ceil(this.cells.length/UI.cellsPerLayer);
    while(this.layers.length>this.cellCount){remove(this.layers.pop());this.layerCaches.pop();}
    while(this.layers.length<this.cellCount) {
      const index=this.layers.length,entity=this.player.dimension.spawnEntity("ns:text_layer",{
        x:this.pose.center.x+this.pose.normal.x*(0.003+index*0.0005),y:this.pose.center.y,
        z:this.pose.center.z+this.pose.normal.z*(0.003+index*0.0005)});
      this.layers.push(entity);this.layerCaches.push(new Map());
      entity.addTag(`ns:owner:${this.player.id}`);entity.setDynamicProperty("ns:owner",this.player.id);
      entity.teleport(entity.location,{rotation:this.pose.rotation});
    }
    apply(this.panel,this.cache,{"ns:page":PAGE_IDS[this.page.id],"ns:scale":Math.round(UI.scale*1000),"ns:transparent":this.transparent?1:0});
    this.layers.forEach((e,i)=>apply(e,this.layerCaches[i],{"ns:page":PAGE_IDS[this.page.id],"ns:layer":i,"ns:scale":Math.round(UI.scale*1000)}));
    this.refresh();
  }
  refresh() {
    if(this.closed)return;
    this.view=this.controller.view(this.context());
    const point=this.gaze();this.point=point;this.hover=hitTest(this.page,point,this.view.states);
    this.render();this.lastRefresh=system.currentTick;
  }
  gaze() {
    if(this.requireRemote&&selectedItem(this.player)!==this.remoteItem)return null;
    const head=this.player.getHeadLocation();head.y+=0.1;
    const direction=this.player.getViewDirection();
    const point=intersectPanel(head,direction,this.pose,UI.scale);
    if(!point)return null;
    // Do not click through terrain between the camera and this panel.
    try {
      const block=this.player.dimension.getBlockFromRay(head,direction,{maxDistance:point.t,includeLiquidBlocks:false,includePassableBlocks:false});
      if(block)return null;
    } catch {return null;}
    return point;
  }
  tick() {
    if(this.closed)return;
    if(!valid(this.player)||!valid(this.panel)||this.player.dimension.id!==this.dimension ||
      (this.requireRemote&&selectedItem(this.player)!==this.remoteItem)||distance(this.player.getHeadLocation(),this.pose.center)>UI.maxDistance||
      this.player.getComponent("minecraft:health")?.currentValue<=0 || this.layers.some(e=>!valid(e))) {this.close();return;}
    const point=this.gaze(),hover=hitTest(this.page,point,this.view.states);
    const changed=hover?.id!==this.hover?.id;
    this.point=point;this.hover=hover;
    // Gaze is per-tick; inventory/controllers are refreshed only five times/sec.
    if(system.currentTick-this.lastRefresh>=4)this.refresh();
    else if(changed||this.toastUntil===system.currentTick)this.render();
    else apply(this.panel,this.cache,{"ns:cursor_on":point?1:0,"ns:cursor_xy":point?packPair(point.x,point.y):0});
    if(system.currentTick%100===0)for(const e of [this.panel,...this.layers])e.triggerEvent("ns:refresh");
  }
  ownsEntity(entity) { return !!entity && (entity.id===this.panel?.id || this.layers.some(e=>e.id===entity.id)); }
  interact(entity) {
    if(this.closed || !this.ownsEntity(entity) || (this.requireRemote&&selectedItem(this.player)!==this.remoteItem))return false;
    // Native selection hitboxes are broader than the flat panel. A near-edge
    // entity interaction must not close it or click outside the actual UI.
    this.click(false);return true;
  }
  click(closeOffPanel=true) {
    if(this.closed)return;
    if(this.requireRemote&&selectedItem(this.player)!==this.remoteItem){this.close();return;}
    // Re-test at item-use time; never dispatch a stale hover from a previous tick.
    this.refresh();
    if(!this.point){if(closeOffPanel)this.close();return;}
    if(!this.hover)return;
    const id=this.hover.id;
    if(this.view.states?.[id]?.disabled){this.toast("This control is disabled");return;}
    this.controller.action(this.context(),id);
    if(!this.closed)this.refresh();
  }
  render() {
    const tip=this.hover?this.controller.tooltip?.(this.context(),this.hover.id):null;
    const tooltipX=this.hover?clamp(this.hover.rect[0]+this.hover.rect[2]+6,4,UI.width-184):0;
    const tooltipY=this.hover?clamp(this.hover.rect[1]-4,34,UI.height-44):0;
    const props={...stateMasks(this.page,this.view.states??{}),
      "ns:hover_on":this.hover?1:0,"ns:hover_xy":this.hover?packPair(this.hover.rect[0],this.hover.rect[1]):0,
      "ns:hover_wh":this.hover?packPair(this.hover.rect[2],this.hover.rect[3]):0,
      "ns:cursor_on":this.point?1:0,"ns:cursor_xy":this.point?packPair(this.point.x,this.point.y):0,
      "ns:tip_on":tip?1:0,"ns:tip_xy":packPair(tooltipX,tooltipY),"ns:tip_wh":packPair(180,38)};
    for(let group=0;group<3;group++)props[`ns:icons${group}`]=Array.from({length:4},(_,i)=>
      clamp(Math.trunc(this.view.icons?.[group*4+i]??0),0,15)*64**i).reduce((a,b)=>a+b,0);
    for(let group=0;group<6;group++)props[`ns:cards${group}`]=Array.from({length:4},(_,i)=>
      clamp(Math.trunc(this.view.cards?.[group*4+i]??0),0,53)*64**i).reduce((a,b)=>a+b,0);
    apply(this.panel,this.cache,props);
    const hint=system.currentTick<this.toastUntil?this.toastText:this.hover?.tip??this.view.hint??"";
    const chars=fieldCharacters(this.cells,{...this.view.fields,hint,tipTitle:tip?.title??"",tipDetail:tip?.detail??""});
    this.layers.forEach((entity,layer)=>{
      const values={"ns:tip_on":tip?1:0,"ns:tip_xy":packPair(tooltipX,tooltipY)};
      for(let i=0;i<UI.textPacks;i++)values[`ns:t${i}`]=packGlyphs(chars.slice(layer*UI.cellsPerLayer+i*4,layer*UI.cellsPerLayer+i*4+4));
      apply(entity,this.layerCaches[layer],values);
    });
  }
  toast(text,force=false) {
    this.toastText=String(text).slice(0,48);this.toastUntil=system.currentTick+60;
    if(force||this.state.alerts)this.player.onScreenDisplay.setTitle(UI.toastPrefix+text,{
      fadeInDuration:4,stayDuration:50,fadeOutDuration:10});
    if(!this.closed)this.render();
  }
  close() {
    if(this.closed)return;this.closed=true;
    remove(this.panel);this.layers.forEach(remove);this.layers=[];
    this.onClose?.(this.player.id);
    // Every outstanding editor receives cancellation if the session disappears.
    for(const frame of this.stack.reverse()) {
      try{frame.args.onResult?.(undefined);}catch(error){console.warn(`[Entity UI] Cancellation callback: ${error}`);}
    }
    this.stack=[];
  }
}
