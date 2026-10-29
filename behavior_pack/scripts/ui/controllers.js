import { ICONS } from "./layouts.js";
import { clamp } from "./core.js";
import { blackjackControllers } from "./blackjack-controller.js";

export const DEFAULTS = Object.freeze({ enabled: true, alerts: true, amount: 16, name: "MY PANEL" });
export function loadState(player) {
  try {
    const raw = JSON.parse(player.getDynamicProperty("ns:demo_settings") ?? "null");
    return { enabled: typeof raw?.enabled === "boolean" ? raw.enabled : true,
      alerts: typeof raw?.alerts === "boolean" ? raw.alerts : true,
      amount: clamp(Math.trunc(Number(raw?.amount) || 16),1,999999),
      name: typeof raw?.name === "string" ? raw.name.slice(0,44) : DEFAULTS.name };
  } catch { return { ...DEFAULTS }; }
}
export function saveState(player,state) { player.setDynamicProperty("ns:demo_settings", JSON.stringify(state)); }
function set(ctx,key,value) { ctx.state[key] = value; saveState(ctx.player,ctx.state); }
function rename(ctx) { ctx.session.keyboard("ENTER A PANEL NAME",ctx.state.name,44,value=>{
  if(value !== undefined) { set(ctx,"name",value || "MY PANEL"); ctx.session.toast("Panel name saved"); }
}); }
function getInventory(ctx) {
  const container = ctx.player.getComponent("minecraft:inventory")?.container;
  return Array.from({length:12},(_,i)=>container?.getItem(i));
}
function nameOf(item) {
  return item?.nameTag || item?.typeId.split(":").at(-1).replace(/_/g," ") || "EMPTY SLOT";
}
function iconOf(item) {
  if(!item)return 0;
  const type=item.typeId.split(":").at(-1);
  const exact=ICONS.indexOf(type);if(exact>=0)return exact;
  if(type.endsWith("_log")||type.endsWith("_wood")||type.endsWith("_stem")||type.endsWith("_hyphae"))return ICONS.indexOf("oak_log");
  if(type.endsWith("_sapling")||type.endsWith("_propagule"))return ICONS.indexOf("sapling");
  return ICONS.indexOf("warning"); // deliberately honest placeholder for unmapped vanilla/custom items
}
export const controllers = {
  ...blackjackControllers,
  dashboard: {
    view: ctx => ({ fields:{name:ctx.state.name,summary:`AMOUNT ${ctx.state.amount} / ${ctx.state.enabled?"ENABLED":"DISABLED"}`},
      states:{},icons:{},hint:"USE OFF-PANEL TO CLOSE" }),
    action(ctx,id) {
      if(id==="controls"||id==="inventory")ctx.session.navigate(id);
      else if(id==="rename")rename(ctx);
      else if(id==="toast")ctx.session.toast("Hello from your 3D panel!",true);
      else if(id==="close")ctx.session.close();
    }
  },
  controls: {
    view: ctx => ({fields:{name:ctx.state.name,amount:ctx.state.amount},
      states:{enabled:{on:ctx.state.enabled},alerts:{on:ctx.state.alerts},advanced:{disabled:!ctx.state.enabled},
        minus:{disabled:ctx.state.amount<=1},plus:{disabled:ctx.state.amount>=999999}},icons:{},hint:"SETTINGS SAVE TO THIS PLAYER"}),
    action(ctx,id) {
      if(id==="back")ctx.session.back();
      else if(id==="enabled"||id==="alerts")set(ctx,id,!ctx.state[id]);
      else if(id==="minus"||id==="plus")set(ctx,"amount",clamp(ctx.state.amount+(id==="minus"?-1:1),1,999999));
      else if(id==="name")rename(ctx);
      else if(id==="amount")ctx.session.amount("AMOUNT: 1 TO 999999",ctx.state.amount,1,999999,value=>{
        if(value!==undefined){set(ctx,"amount",value);ctx.session.toast("Amount saved");}
      });
      else if(id==="advanced")ctx.session.toast("Advanced control clicked");
      else if(id==="reset")ctx.session.confirm("Reset your demo settings to their defaults?",result=>{
        if(result){Object.assign(ctx.state,DEFAULTS);saveState(ctx.player,ctx.state);ctx.session.toast("Settings reset");}
      });
    }
  },
  inventory: {
    view(ctx) {
      ctx.data.items=getInventory(ctx);
      return { fields:Object.fromEntries([["description","HOVER A SLOT FOR ITEM DETAILS"],
        ...ctx.data.items.map((item,i)=>[`count${i}`,item?String(item.amount):""])]),
        icons:Object.fromEntries(ctx.data.items.map((item,i)=>[i,iconOf(item)])),states:{},hint:"REAL ITEMS / READ-ONLY DISPLAY" };
    },
    action(ctx,id) {
      if(id==="back")ctx.session.back();
      else if(id.startsWith("slot")) {
        const item=getInventory(ctx)[Number(id.slice(4))];
        ctx.session.toast(item?`${nameOf(item)} x${item.amount}`:"This slot is empty");
      }
    },
    tooltip(ctx,id) {
      if(!id.startsWith("slot"))return null;
      const i=Number(id.slice(4)),item=ctx.data.items?.[i];
      return {title:nameOf(item),detail:item?`${item.typeId} / COUNT ${item.amount}`:`INVENTORY SLOT ${i+1}`};
    }
  },
  confirm: {
    view: ctx => ({fields:{message:ctx.args.message},states:{yes:{active:true}},icons:{},hint:"CONFIRM OR CANCEL"}),
    action(ctx,id) { if(id==="yes"||id==="no")ctx.session.back(id==="yes"); }
  },
  keyboard: {
    enter(ctx) { ctx.data.value=String(ctx.args.initial ?? "").toUpperCase().slice(0,ctx.args.maxLength); },
    view: ctx => ({fields:{prompt:ctx.args.prompt,input:ctx.data.value+"_"},
      states:Object.fromEntries("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("").map(c=>[`key:${c}`,{disabled:ctx.data.value.length>=ctx.args.maxLength}])),
      icons:{},hint:`${ctx.data.value.length}/${ctx.args.maxLength} CHARACTERS`}),
    action(ctx,id) {
      if(id.startsWith("key:")&&ctx.data.value.length<ctx.args.maxLength)ctx.data.value+=id.slice(4);
      else if(id==="space"&&ctx.data.value.length<ctx.args.maxLength)ctx.data.value+=" ";
      else if(id==="erase")ctx.data.value=ctx.data.value.slice(0,-1);
      else if(id==="done")ctx.session.back(ctx.data.value.trim());
      else if(id==="cancel")ctx.session.back();
    }
  },
  amount: {
    enter(ctx) { ctx.data.value=String(ctx.args.initial);ctx.data.replace=true; },
    view(ctx) {
      const n=Number(ctx.data.value),valid=ctx.data.value.length>0&&Number.isSafeInteger(n)&&n>=ctx.args.min&&n<=ctx.args.max;
      return {fields:{prompt:ctx.args.prompt,input:ctx.data.value+"_"},states:{done:{disabled:!valid}},icons:{},hint:valid?"SAVE TO APPLY":"VALUE IS OUTSIDE THE ALLOWED RANGE"};
    },
    action(ctx,id) {
      if(id.startsWith("digit:")) {
        if(ctx.data.replace){ctx.data.value="";ctx.data.replace=false;}
        if(ctx.data.value.length<6)ctx.data.value+=id.slice(6);
      } else if(id==="erase"){ctx.data.value=ctx.data.value.slice(0,-1);ctx.data.replace=false;}
      else if(id==="done"){
        const n=Number(ctx.data.value);
        if(ctx.data.value&&Number.isSafeInteger(n)&&n>=ctx.args.min&&n<=ctx.args.max)ctx.session.back(n);
      } else if(id==="cancel")ctx.session.back();
    }
  }
};
