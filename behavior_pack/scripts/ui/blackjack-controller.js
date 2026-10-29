import { system } from "@minecraft/server";
const RULES=["6 DECKS / DEALER STANDS ON ALL 17",
  "BLACKJACK 3:2 / OTHER WINS 1:1 / TIES PUSH",
  "DOUBLE ANY FIRST TWO CARDS / DOUBLE AFTER SPLIT",
  "SPLIT EQUAL VALUES / MAX 4 HANDS / NO RESPLIT ACES",
  "SPLIT ACES: ONE CARD EACH / SPLIT 21 IS NOT BLACKJACK",
  "INSURANCE 2:1 / LATE SURRENDER HALF YOUR BET",
  "DEALER PEEKS UNDER ACE OR TEN / EVEN COIN BETS"];
export function sendBlackjack(session,action,amount){
  const game=session.blackjack;
  if(!game||game.pending)return;
  game.pending=true;
  system.sendScriptEvent("ns:bj_action",JSON.stringify({token:game.token,action,amount,revision:game.view.revision}));
}
export const blackjackControllers={
  blackjack:{
    view(ctx){
      const game=ctx.session.blackjack,v=game.view,legal=new Set(v.legal);
      const live=v.phase==="player"||v.phase==="insurance";
      if(live)game.selected=v.active??0;
      const index=Math.min(game.selected??0,Math.max(0,v.hands.length-1)),h=v.hands[index];
      const page=Math.max(0,Math.min(game.cardsPage??0,Math.ceil((h?.cards.length??0)/12)-1));
      const cards=[...v.dealer.slice(0,12),...Array(Math.max(0,12-v.dealer.length)).fill(0),...(h?.cards.slice(page*12,page*12+12)??[])];
      /** @type {Record<string,{disabled?:boolean,hidden?:boolean,active?:boolean}>} */
      const states=Object.fromEntries(["hit","stand","double","split","surrender","deal","insurance","decline","even_money"]
        .map(id=>[id,{disabled:game.pending||!legal.has(id),hidden:["insurance","decline","even_money"].includes(id)&&v.phase!=="insurance"}]));
      for(const id of ["minus","bet","plus"])states[id]={disabled:game.pending||live};
      states.minus.disabled ||=v.bet<=10;states.plus.disabled ||=v.bet>=100000;
      states.cards_prev={disabled:page===0};states.cards_next={disabled:(page+1)*12>=(h?.cards.length??0)};
      for(let i=0;i<4;i++)states[`hand${i}`]={disabled:!v.hands[i]||(live&&i!==index),active:i===index&&!!h};
      return {fields:{balance:`BALANCE ${v.balance} COINS`,bet:`BET ${v.bet} / LIMIT 10-100000 EVEN COINS`,
        dealerTotal:`TOTAL ${v.dealerTotal||"--"}`,message:game.pending?"WAITING FOR SERVER...":game.error||v.message,
        handTitle:h?`HAND ${index+1} / ${h.soft?"SOFT ":""}${h.total} / BET ${h.bet} / ${h.result} / CARDS ${page*12+1}-${Math.min(h.cards.length,(page+1)*12)}`:"YOUR CARDS WILL APPEAR HERE",
        ...Object.fromEntries(Array.from({length:4},(_,i)=>[`summary${i}`,v.hands[i]?`${v.hands[i].total} / BET ${v.hands[i].bet} / ${v.hands[i].result}`:"NO HAND"]))},
        cards,states,icons:{},hint:"GAZE + INTERACT TO PLAY / CLOSE AUTO-STANDS"};
    },
    action(ctx,id){
      const game=ctx.session.blackjack;
      if(id==="close")ctx.session.close();
      else if(id==="rules")ctx.session.navigate("blackjack_rules");
      else if(id.startsWith("hand")){game.selected=Number(id.slice(4));game.cardsPage=0;}
      else if(id==="cards_prev"||id==="cards_next")game.cardsPage=(game.cardsPage??0)+(id==="cards_prev"?-1:1);
      else if(id==="bet")ctx.session.amount("EVEN COIN BET: 10 TO 100000",game.view.bet,10,100000,value=>{
        if(value!==undefined){if(value%2)ctx.session.toast("Use an even number of coins");else sendBlackjack(ctx.session,"bet",value);}
      });
      else if(id==="minus"||id==="plus")sendBlackjack(ctx.session,"bet",Math.max(10,Math.min(100000,game.view.bet+(id==="minus"?-10:10))));
      else sendBlackjack(ctx.session,id);
    }
  },
  blackjack_rules:{view:()=>({fields:Object.fromEntries(RULES.map((s,i)=>[`rule${i}`,s])),states:{},icons:{},hint:"CLOSING AN ACTIVE ROUND AUTO-STANDS ALL HANDS"}),action(ctx,id){if(id==="back")ctx.session.back();}}
};
