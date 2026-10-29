import { UI, PAGES, PAGE_IDS, textCells } from "../ui/layouts.js";
import { changedProperties, fieldCharacters, packGlyphs } from "../ui/core.js";
import { spawnPose } from "../ui/session.js";
import { validateCreate, validBoard, rankPlayers, leaderboardFields } from "./logic.js";

export const STORAGE_KEY="ns:leaderboards";
export const BOARD_TYPES=["ns:leaderboard_panel","ns:leaderboard_text"];
export const AUDIT_UPDATES=10;
const CELLS=textCells(PAGES[PAGE_IDS.leaderboard]);
function layerCount(board){
  const end=CELLS.findIndex(c=>c.field==="rank"+board.amount);
  return Math.ceil((end<0?CELLS.length:end)/UI.cellsPerLayer);
}
function valid(e){try{return e?.isValid===true;}catch{return false;}}
function remove(e){try{if(valid(e))e.remove();}catch{}}
function loaded(dimension,board){try{return !!dimension.getBlock(board.pose.center);}catch{return false;}}
export class LeaderboardManager {
  constructor(world){
    this.world=world;this.boards=[];this.nextId=1;this.ready=false;this.caches=new Map();
    this.runtimes=new Map();this.snapshots=new Map();this.updates=0;
    this.metrics={scans:0,scoreReads:0,payloadBuilds:0};
  }
  load(){
    const raw=this.world.getDynamicProperty(STORAGE_KEY);
    if(raw!==undefined){
      const stored=typeof raw==="string"?JSON.parse(raw):null;
      if(stored?.version!==1||!Array.isArray(stored.boards)||!stored.boards.every(validBoard)||
        new Set(stored.boards.map(b=>b.id)).size!==stored.boards.length||
        !Number.isSafeInteger(stored.nextId)||stored.nextId<1||stored.boards.some(b=>Number(b.id)>=stored.nextId))
        throw Error("Invalid leaderboard storage; original data preserved. Creation disabled until repaired.");
      this.boards=stored.boards;this.nextId=stored.nextId;
    }
    this.ready=true;this.audit();this.tick();
  }
  save(){this.world.setDynamicProperty(STORAGE_KEY,JSON.stringify({version:1,nextId:this.nextId,boards:this.boards}));}
  /** @param {import('@minecraft/server').Player} player */
  create(player,objective,amount){
    if(!this.ready)throw Error("Leaderboards are not ready; check the server content log.");
    validateCreate(objective,amount);
    if(!this.world.scoreboard.getObjective(objective))throw Error("Scoreboard '"+objective+"' does not exist. Use its objective ID.");
    const board={id:String(this.nextId),objective,amount,dimension:player.dimension.id,pose:spawnPose(player)},entities=[];
    try{
      const runtime=this.reconcile(board,player.dimension,entities);
      this.update(board,runtime,new Map());
      this.boards.push(board);this.nextId++;
      try{this.save();}catch(error){this.boards.pop();this.nextId--;throw error;}
      this.runtimes.set(board.id,runtime);
    }catch(error){for(const e of entities){remove(e);this.caches.delete(e.id);}throw error;}
    return board;
  }
  remove(id){
    if(!this.ready)throw Error("Leaderboards are not ready; check the server content log.");
    const value=String(id);
    if(!value.length||/[^0-9]/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)
      throw Error("Use /lb remove <id>, with the number shown when the leaderboard was created.");
    const key=String(Number(value)),board=this.boards.find(b=>b.id===key);
    if(!board)throw Error("Leaderboard #"+key+" does not exist.");
    // Persist first: a failed save must leave the display and registry intact.
    const previous=this.boards;
    this.boards=previous.filter(b=>b.id!==key);
    try{this.save();}catch(error){this.boards=previous;throw error;}
    const runtime=this.runtimes.get(key);
    for(const entity of runtime?[runtime.panel,...runtime.layers]:[]){remove(entity);this.caches.delete(entity.id);}
    this.runtimes.delete(key);
    if(!this.boards.some(b=>b.objective===board.objective))this.snapshots.delete(board.objective);
    // One command-time scan catches duplicates, including moved actors. Never
    // delete another board sharing the same scoreboard or touch player scores.
    for(const dimId of ["overworld","nether","the_end"]){
      try{
        const dimension=this.world.getDimension(dimId);
        for(const type of BOARD_TYPES)for(const entity of this.query(dimension,{type})){
          if(entity.getDynamicProperty("ns:leaderboard_id")!==key)continue;
          remove(entity);this.caches.delete(entity.id);
        }
      }catch(error){console.warn("[Leaderboard "+key+"] Actor cleanup deferred: "+error);}
    }
    return board;
  }
  entityLoaded(entity){
    if(!this.ready||!valid(entity)||!BOARD_TYPES.includes(entity.typeId))return;
    const id=entity.getDynamicProperty("ns:leaderboard_id"),board=this.boards.find(b=>b.id===id);
    // Event-driven cleanup also works after deleting the last board: no idle
    // entity scans, ticking areas or persistent tombstone list are necessary.
    if(!board||board.dimension!==entity.dimension.id){remove(entity);this.caches.delete(entity.id);}
  }
  query(dimension,options){this.metrics.scans++;return dimension.getEntities(options);}
  audit(){
    if(!this.ready)return;
    const records=new Map(this.boards.map(b=>[b.id,b])),live=new Set();
    for(const dimId of ["overworld","nether","the_end"]){
      const dimension=this.world.getDimension(dimId),groups=new Map();
      for(const type of BOARD_TYPES)for(const e of this.query(dimension,{type})){
        let id;try{id=e.getDynamicProperty("ns:leaderboard_id");}catch{continue;}
        const board=records.get(id);
        if(!board||board.dimension!==dimension.id){remove(e);continue;}
        if(!groups.has(id))groups.set(id,[]);groups.get(id).push(e);live.add(e.id);
      }
      for(const board of this.boards){
        if(board.dimension!==dimension.id||!loaded(dimension,board))continue;
        try{
          const entities=groups.get(board.id)??[],runtime=this.reconcile(board,dimension,entities);
          this.runtimes.set(board.id,runtime);
          entities.filter(valid).forEach(e=>live.add(e.id));
        }catch(error){console.warn("[Leaderboard "+board.id+"] Repair deferred: "+error);}
      }
    }
    for(const id of this.caches.keys())if(!live.has(id))this.caches.delete(id);
  }
  tick(){
    if(!this.ready||!this.boards.length)return;
    if(++this.updates%AUDIT_UPDATES===0)this.audit();
    const scoreCache=new Map(),dimensions=new Map();
    for(const board of this.boards){
      try{
        let runtime=this.runtimes.get(board.id);
        if(!runtime||!valid(runtime.panel)||runtime.layers.some(e=>!valid(e))){
          if(!dimensions.has(board.dimension))dimensions.set(board.dimension,this.world.getDimension(board.dimension.replace("minecraft:","")));
          const dimension=dimensions.get(board.dimension);
          if(!loaded(dimension,board))continue;
          // Repair searches only this board's vicinity. Global orphan/duplicate
          // discovery runs on startup and once every ten seconds, not every poll.
          const entities=BOARD_TYPES.flatMap(type=>this.query(dimension,{type,location:board.pose.center,maxDistance:8}))
            .filter(e=>e.getDynamicProperty("ns:leaderboard_id")===board.id);
          runtime=this.reconcile(board,dimension,entities);this.runtimes.set(board.id,runtime);
        }
        this.update(board,runtime,scoreCache);
      }catch(error){console.warn("[Leaderboard "+board.id+"] Update deferred: "+error);}
    }
  }
  reconcile(board,dimension,entities){
    const previous=this.runtimes.get(board.id),panels=entities.filter(e=>valid(e)&&e.typeId===BOARD_TYPES[0]);
    const panel=panels[0]??this.spawn(board,dimension,BOARD_TYPES[0],0,entities);panels.slice(1).forEach(remove);
    this.apply(panel,{"ns:page":PAGE_IDS.leaderboard,"ns:scale":Math.round(UI.scale*1000),"ns:transparent":1,
      "ns:hover_on":0,"ns:cursor_on":0,"ns:tip_on":0});
    const byLayer=new Map(),count=layerCount(board),layers=[];
    for(const e of entities){
      if(!valid(e)||e.typeId!==BOARD_TYPES[1])continue;
      const i=e.getDynamicProperty("ns:leaderboard_layer");
      if(!Number.isInteger(i)||i<0||i>=count||byLayer.has(i)){remove(e);continue;}
      byLayer.set(i,e);
    }
    for(let i=0;i<count;i++){
      const layer=byLayer.get(i)??this.spawn(board,dimension,BOARD_TYPES[1],i,entities);layers.push(layer);
      this.apply(layer,{"ns:page":PAGE_IDS.leaderboard,"ns:layer":i,"ns:scale":Math.round(UI.scale*1000),"ns:tip_on":0,"ns:tip_xy":0});
    }
    // Repaired actors need text even if the objective hasn't changed.
    const same=previous?.panel.id===panel.id&&previous.layers.length===layers.length&&layers.every((e,i)=>previous.layers[i].id===e.id);
    return {panel,layers,signature:same?previous.signature:null};
  }
  snapshot(objectiveId,scoreCache){
    if(scoreCache.has(objectiveId))return scoreCache.get(objectiveId);
    const objective=this.world.scoreboard.getObjective(objectiveId);
    this.metrics.scoreReads++;
    const entries=rankPlayers(objective?.getScores()??[],15);
    const key=JSON.stringify([objective?.displayName??null,entries]);
    let snapshot=this.snapshots.get(objectiveId);
    if(snapshot?.key!==key){snapshot={key,objective,entries,payloads:new Map()};this.snapshots.set(objectiveId,snapshot);}
    scoreCache.set(objectiveId,snapshot);return snapshot;
  }
  update(board,runtime,scoreCache){
    const snapshot=this.snapshot(board.objective,scoreCache);
    if(runtime.signature===snapshot.key)return; // No wrapping/packing/property iteration.
    let payload=snapshot.payloads.get(board.amount);
    if(!payload){
      this.metrics.payloadBuilds++;
      const fields=leaderboardFields(board,snapshot.objective,snapshot.entries.slice(0,board.amount));
      const chars=fieldCharacters(CELLS.slice(0,layerCount(board)*UI.cellsPerLayer),fields);
      payload=Array.from({length:layerCount(board)},(_,i)=>Object.fromEntries(Array.from({length:UI.textPacks},(_,p)=>
        ["ns:t"+p,packGlyphs(chars.slice(i*UI.cellsPerLayer+p*4,i*UI.cellsPerLayer+p*4+4))])));
      snapshot.payloads.set(board.amount,payload);
    }
    runtime.layers.forEach((e,i)=>this.apply(e,payload[i]));runtime.signature=snapshot.key;
  }
  spawn(board,dimension,type,layer,entities){
    const yaw=board.pose.rotation.y*Math.PI/180;
    const offset=type===BOARD_TYPES[1]?0.003+layer*0.0005:0;
    const center={x:board.pose.center.x+Math.sin(yaw)*offset,y:board.pose.center.y,z:board.pose.center.z-Math.cos(yaw)*offset};
    const e=dimension.spawnEntity(type,center);entities.push(e);
    e.setDynamicProperty("ns:leaderboard_id",board.id);e.setDynamicProperty("ns:leaderboard_layer",layer);
    e.addTag("ns:leaderboard:"+board.id);e.teleport(center,{rotation:board.pose.rotation});return e;
  }
  apply(entity,props){
    let cache=this.caches.get(entity.id);if(!cache){cache=new Map();this.caches.set(entity.id,cache);}
    for(const [key,value] of changedProperties(cache,props)){entity.setProperty(key,value);cache.set(key,value);}
  }
}
