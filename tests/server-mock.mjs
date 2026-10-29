function signal() { const handlers=[];return {subscribe:fn=>handlers.push(fn),emit:event=>handlers.forEach(fn=>fn(event))}; }
const scheduled=[],dimensions=new Map(),players=new Map(),dynamic=new Map(),objectives=new Map();
export const ScriptEventSource={Server:"Server",Entity:"Entity",Block:"Block"};
export const sentScriptEvents=[],clearedRuns=[];
export const system={currentTick:0,beforeEvents:{startup:signal()},afterEvents:{scriptEventReceive:signal()},run:fn=>scheduled.push(fn),runInterval(){return 123;},clearRun:id=>clearedRuns.push(id),sendScriptEvent:(id,message)=>sentScriptEvents.push({id,message})};
export function flushScheduled(){while(scheduled.length)scheduled.shift()();}
export const world={beforeEvents:{playerInteractWithBlock:signal(),playerInteractWithEntity:signal()},
  afterEvents:{worldLoad:signal(),playerLeave:signal(),entityDie:signal(),entityLoad:signal()},
  getDimension:id=>dimensions.get(id.replace("minecraft:",""))??{id:`minecraft:${id.replace("minecraft:","")}`,getEntities:()=>[],getBlock:()=>undefined},
  getPlayers:()=>[...players.values()],getDynamicProperty:key=>dynamic.get(key),setDynamicProperty:(key,value)=>dynamic.set(key,value),
  scoreboard:{getObjective:id=>objectives.get(id)}};
export function scoreboardObjective(id,scores=[]){
  const objective={id,displayName:id,scores,getScores(){return this.scores;}};objectives.set(id,objective);return objective;
}
let entityId=0;
export function playerFixture() {
  const entities=[],titles=[],inventory=[{typeId:"ns:interface_remote",amount:1}],writes=[];
  const dimension={id:"minecraft:overworld",getBlock:()=>({isAir:true}),getBlockFromRay:()=>undefined,
    getEntities:({type})=>entities.filter(e=>e.isValid&&e.typeId===type),
    spawnEntity(typeId,location) {
      const e={id:`entity-${entityId++}`,typeId,dimension,isValid:true,location:{...location},properties:{},data:{},
        addTag(){},setDynamicProperty(key,value){this.data[key]=value;},getDynamicProperty(key){return this.data[key];},teleport(loc,options){this.location={...loc};this.rotation=options.rotation;},
        setProperty(key,value){this.properties[key]=value;writes.push([this.id,key,value]);},remove(){this.isValid=false;},triggerEvent(){}};
      entities.push(e);return e;
    }};
  dimensions.set("overworld",dimension);
  const player={id:"player-1",name:"BubbaXM",typeId:"minecraft:player",isValid:true,selectedSlotIndex:0,dimension,
    health:20,head:{x:0,y:1.62,z:0},direction:{x:0,y:0,z:1},data:{},
    getHeadLocation(){return {...this.head};},getViewDirection(){return {...this.direction};},getRotation(){return{x:0,y:0};},
    getComponent(name){if(name==="minecraft:health")return {currentValue:this.health};if(name==="minecraft:inventory")return{container:{getItem:i=>inventory[i]}};},
    getDynamicProperty(key){return this.data[key];},setDynamicProperty(key,value){this.data[key]=value;},
    onScreenDisplay:{setTitle:(...args)=>titles.push(args)}};
  players.set(player.id,player);return {player,entities,titles,inventory,writes};
}
