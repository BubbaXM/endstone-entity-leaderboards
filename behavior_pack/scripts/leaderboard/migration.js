// One-time handoff only. After acknowledgement no Script API LB polling remains.
import { system, world, ScriptEventSource } from "@minecraft/server";
import { BOARD_TYPES, STORAGE_KEY } from "./manager.js";
import { validBoard } from "./logic.js";
export const PACKET_MARKER="ns:lb_packet_backend";
export class PacketHandoff {
  constructor(manager,stopLegacy){this.manager=manager;this.stopLegacy=stopLegacy;this.ready=false;this.active=false;this.nonce="";}
  load(){this.ready=true;this.active=world.getDynamicProperty(PACKET_MARKER)===true;}
  cleanup(entity){if(this.active&&BOARD_TYPES.includes(entity.typeId)&&entity.isValid)entity.remove();}
  send(message){system.sendScriptEvent("ns:lb_packet_import",JSON.stringify(message));}
  /** @param {import('@minecraft/server').ScriptEventCommandMessageAfterEvent} event */
  handle(event){
    if(!["ns:lb_packet_export","ns:lb_packet_ack"].includes(event.id))return false;
    if(event.sourceType!==ScriptEventSource.Server)return true;
    system.run(()=>{
      try{
        if(!this.ready)return;
        const request=JSON.parse(event.message),nonce=request.nonce;
        if(typeof nonce!=="string"||!/^[a-f0-9]{32}$/.test(nonce))return;
        if(event.id==="ns:lb_packet_export"){
          this.nonce=nonce;
          if(this.active){this.send({nonce,kind:"active"});return;}
          const raw=world.getDynamicProperty(STORAGE_KEY);
          const registry=raw===undefined?{version:1,nextId:1,boards:[]}:JSON.parse(String(raw));
          if(registry.version!==1||!Array.isArray(registry.boards)||!registry.boards.every(validBoard)||
             !Number.isSafeInteger(registry.nextId)||registry.nextId<1||
             new Set(registry.boards.map(b=>b.id)).size!==registry.boards.length||
             registry.boards.some(b=>Number(b.id)>=registry.nextId))throw Error("Invalid legacy registry; preserving old displays.");
          const scores={};
          for(const id of new Set(registry.boards.map(b=>b.objective))){
            const objective=world.scoreboard.getObjective(id);
            scores[id]=(objective?.getScores()??[]).filter(s=>s.participant.type==="Player")
              .map(s=>({id:String(s.participant.id),name:s.participant.displayName,score:s.score}));
          }
          // ASCII chunks cannot split a surrogate pair or exceed the engine's
          // message byte limit; JSON parsing restores Unicode at the other end.
          const data=JSON.stringify({registry,scores}).replace(/[^\x00-\x7f]/g,c=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0")),size=400,chunks=Math.ceil(data.length/size);
          if(chunks>8192)throw Error("Migration payload too large; old displays preserved.");
          this.send({nonce,kind:"begin",chunks});
          for(let index=0;index<chunks;index++)this.send({nonce,kind:"chunk",index,data:data.slice(index*size,(index+1)*size)});
          this.send({nonce,kind:"end"});return;
        }
        if(nonce!==this.nonce)return;
        // ACK is sent only after a durable Endstone registry write. Retain the
        // old world registry as a rollback snapshot, but never read it again.
        world.setDynamicProperty(PACKET_MARKER,true);this.active=true;
        this.manager.ready=false;this.stopLegacy();
        for(const id of ["overworld","nether","the_end"])
          for(const type of BOARD_TYPES)for(const entity of world.getDimension(id).getEntities({type}))this.cleanup(entity);
        this.send({nonce,kind:"complete"});
      }catch(error){console.warn(`[Leaderboard migration] ${error}`);}
    });
    return true;
  }
}
