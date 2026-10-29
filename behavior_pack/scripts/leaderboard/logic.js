export const MAX_ENTRIES=15;
export function validateCreate(objective,amount){
  if(typeof objective!=="string"||!objective.length||objective.length>128||/[\r\n\0]/.test(objective))throw Error("Provide an existing scoreboard objective ID.");
  if(!Number.isInteger(amount)||amount<1||amount>MAX_ENTRIES)throw Error("Amount must be a whole number from 1 to 15.");
}
export function rankPlayers(scores,amount){
  // Only retain the top 15, not a cloned/sorted array of every scored player.
  const limit=Math.max(0,Math.min(MAX_ENTRIES,Math.trunc(amount))),top=[];
  if(!limit)return top;
  for(const s of scores){
    if(s.participant?.type!=="Player"||!Number.isFinite(s.score))continue;
    if(top.length===limit&&s.score<top.at(-1).score)continue;
    const entry={id:s.participant.id,name:s.participant.displayName,score:s.score};
    let lo=0,hi=top.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(compareEntry(entry,top[mid])<0)hi=mid;else lo=mid+1;}
    if(lo>=limit)continue;
    top.splice(lo,0,entry);if(top.length>limit)top.pop();
  }
  return top;
}
function compareEntry(a,b){return b.score-a.score||compare(a.name,b.name)||compare(String(a.id),String(b.id));}
function compare(a,b){return a<b?-1:a>b?1:0;}
export function leaderboardFields(board,objective,entries){
  const fields={title:`LEADERBOARD / ${objective?.displayName??board.objective}`.replace(/§./g,""),
    objective:`SCOREBOARD: ${board.objective}`,headerRank:"#",headerName:"PLAYER",headerScore:"SCORE",
    status:objective?`TOP ${board.amount} / ${entries.length} PLAYERS / LIVE SCORES`:"SCOREBOARD MISSING - WAITING FOR OBJECTIVE"};
  for(let i=0;i<MAX_ENTRIES;i++){
    fields[`rank${i}`]=entries[i]?`${i+1}.`:"";
    fields[`player${i}`]=entries[i]?.name?.replace(/§./g,"")??"";
    fields[`score${i}`]=entries[i]?String(entries[i].score):"";
  }
  if(objective&&!entries.length)fields.status="NO PLAYER SCORES YET";
  return fields;
}
export function validBoard(b){
  try{validateCreate(b.objective,b.amount);}catch{return false;}
  return typeof b.id==="string"&&/^\d+$/.test(b.id)&&["minecraft:overworld","minecraft:nether","minecraft:the_end"].includes(b.dimension)&&
    [b.pose?.center?.x,b.pose?.center?.y,b.pose?.center?.z,b.pose?.rotation?.x,b.pose?.rotation?.y].every(Number.isFinite);
}
