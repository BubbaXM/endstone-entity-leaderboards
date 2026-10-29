import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UI, THEME, PAGES, PAGE_IDS, ALPHABET, COLORS, ICONS, MAX_LAYERS, textCells } from "../behavior_pack/scripts/ui/layouts.js";
import { FONT, Raster, png, icon, circleCursor } from "./raster.mjs";
import { fieldCharacters } from "../behavior_pack/scripts/ui/core.js";
import { uiToModel as xyz, uiQuad as quad, uiOffsetExpression } from "./model-space.mjs";
import { CARD, playingCard } from "./cards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bp = path.join(root, "behavior_pack"), rp = path.join(root, "resource_pack");
const s = UI.texelScale;
// Leave a separate sprite shelf below the enlarged, 2x-texel page texture.
const nextPowerOfTwo=n=>2**Math.ceil(Math.log2(n));
const TW = UI.width*s;
const TH = nextPowerOfTwo(Math.max(1024,UI.height*s+1024));
const P = name => `q.property('ns:${name}')`;
const pairX = name => `math.mod(${P(name)}, 1024)`;
const pairY = name => `math.floor(${P(name)} / 1024)`;
const bit = (name, i) => `math.mod(math.floor(${P(name + Math.floor(i / 24))} / ${2 ** (i % 24)}), 2)`;
async function output(base, file, value) {
  const target = path.join(base, file); await mkdir(path.dirname(target), { recursive:true });
  await writeFile(target, Buffer.isBuffer(value) ? value : JSON.stringify(value,null,2)+"\n");
}
function geometry(id, bones, width=TW, height=TH) {
  return { description:{ identifier:id, texture_width:width, texture_height:height,
    visible_bounds_width:8, visible_bounds_height:6, visible_bounds_offset:[0,0,0] }, bones };
}
function baseBones() { return [{name:"root",pivot:[0,0,0]}]; }
function intProperty(max=16777215, def=0) { return {type:"int",range:[0,max],default:def,client_sync:true}; }
function entity(identifier, properties) {
  return { format_version:"1.21.90", "minecraft:entity":{
    description:{identifier,is_spawnable:false,is_summonable:true,properties},
    components:{ "minecraft:type_family":{family:["ns_interface"]},
      "minecraft:collision_box":{width:0.01,height:0.01},
      // Selection/interaction size is independent of the tiny physical box.
      "minecraft:custom_hit_test":{hitboxes:[{width:UI.width/UI.pxPerBlock*UI.scale,
        height:UI.height/UI.pxPerBlock*UI.scale,pivot:[0,0,0]}]},
      "minecraft:interact":{interactions:[{interact_text:"Choose button",swing:false,
        use_item:false,on_interact:{event:"ns:interact",target:"self"}}]},
      "minecraft:physics":{has_gravity:false,has_collision:false},
      "minecraft:pushable":{is_pushable:false,is_pushable_by_piston:false},
      "minecraft:damage_sensor":{triggers:[{cause:"all",deals_damage:"no"}]},
      "minecraft:health":{value:1,max:1}, "minecraft:persistent":{},
      "minecraft:loot":{table:"loot_tables/ns/empty.json"},
      // Time out if an owner leaves while its chunk is unloaded; refresh by script.
      "minecraft:timer":{looping:false,time:30,time_down_event:{event:"ns:expire",target:"self"}}
    }, component_groups:{"ns:remove":{"minecraft:instant_despawn":{}}},
    events:{"ns:interact":{},"ns:expire":{add:{component_groups:["ns:remove"]}},
      "ns:refresh":{remove:{component_groups:["ns:heartbeat"]},add:{component_groups:["ns:heartbeat"]}}}
  }};
}
// A resettable timer prevents panels surviving indefinitely in unloaded chunks.
function withHeartbeat(def) {
  const e=def["minecraft:entity"];
  e.component_groups["ns:heartbeat"]={"minecraft:timer":e.components["minecraft:timer"]};
  delete e.components["minecraft:timer"];
  e.events["minecraft:entity_spawned"]={add:{component_groups:["ns:heartbeat"]}};
  return def;
}
function nineSlice(bones,name,w,h,uv,z) {
  const origin=xyz(0,0,z); bones.push({name,parent:"root",pivot:origin});
  const t=THEME.borderPixels;
  // Fixed-thickness corners anchor to the outer edges. Middle slices anchor
  // to their inset, then translate AND scale to join both corners exactly.
  for(let row=0;row<3;row++)for(let col=0;col<3;col++) {
    const x=col===0?0:col===1?t:w-t, y=row===0?0:row===1?t:h-t;
    const cw=col===1?w-2*t:t, ch=row===1?h-2*t:t;
    const pivot=xyz(col===2?w:col===1?t:0,row===2?h:row===1?t:0,z);
    bones.push(quad(`${name}_${row}${col}`,[x,y,cw,ch],[uv[0]+col*t*s,uv[1]+row*t*s,t*s,t*s],z,name,pivot));
  }
}
function sliceAnimation(name,w,h,xy,wh) {
  const t=THEME.borderPixels;
  const width=`math.max(${2*t}, ${pairX(wh)})`, height=`math.max(${2*t}, ${pairY(wh)})`;
  const bones={ [name]:{position:[uiOffsetExpression(pairX(xy)),uiOffsetExpression(pairY(xy)),0],scale:[`${width} / ${w}`,`${height} / ${h}`,1]} };
  for(let row=0;row<3;row++)for(let col=0;col<3;col++)bones[`${name}_${row}${col}`]={
    position:[col===1?uiOffsetExpression(`${t} * ${w} / (${width}) - ${t}`):0,
      row===1?uiOffsetExpression(`${t} * ${h} / (${height}) - ${t}`):0,0],
    scale:[col===1?`(${width} - ${2*t}) * ${w} / ((${width}) * ${w-2*t})`:`${w} / (${width})`,
      row===1?`(${height} - ${2*t}) * ${h} / ((${height}) * ${h-2*t})`:`${h} / (${height})`,1]
  };
  return bones;
}
const mainProps={"ns:page":intProperty(PAGES.length-1),"ns:scale":intProperty(2000,1000),
  "ns:transparent":intProperty(1),
  "ns:hover_xy":intProperty(),"ns:hover_wh":intProperty(),"ns:hover_on":intProperty(1),
  "ns:cursor_xy":intProperty(),"ns:cursor_on":intProperty(1),
  "ns:tip_xy":intProperty(),"ns:tip_wh":intProperty(),"ns:tip_on":intProperty(1)};
for(const state of ["disabled","on","active","hidden"])for(let i=0;i<2;i++)mainProps[`ns:${state}${i}`]=intProperty();
for(let i=0;i<3;i++)mainProps[`ns:icons${i}`]=intProperty();
for(let i=0;i<6;i++)mainProps[`ns:cards${i}`]=intProperty();
const textProps={"ns:page":intProperty(PAGES.length-1),"ns:layer":intProperty(MAX_LAYERS-1),
  "ns:scale":intProperty(2000,1000),"ns:tip_xy":intProperty(),"ns:tip_on":intProperty(1)};
for(let i=0;i<UI.textPacks;i++)textProps[`ns:t${i}`]=intProperty();
// One generated contract for both runtimes: packet property indices must match
// the schema sent to the client, and glyph order must match the baked geometry.
await output(root,"server_bridge/ns_lb_bridge/layout.json",{
  version:1,protocols:[2193,2225],ui:UI,alphabet:ALPHABET,page:PAGE_IDS.leaderboard,
  cells:textCells(PAGES[PAGE_IDS.leaderboard]),
  schemas:{"ns:leaderboard_panel":mainProps,"ns:leaderboard_text":textProps}
});
if(ALPHABET.length!==64 || new Set(ALPHABET).size!==64)throw Error("Alphabet must contain exactly 64 unique characters");
for(const c of ALPHABET)if(!FONT[c])throw Error(`Missing font glyph ${c}`);
for(const props of [mainProps,textProps])if(Object.keys(props).length>32)throw Error("Entity property limit exceeded");
for(const page of PAGES) {
  if(page.elements.length>UI.maxElements)throw Error(`Too many controls in ${page.id}`);
  if(new Set(page.elements.map(e=>e.id)).size!==page.elements.length)throw Error(`Duplicate IDs in ${page.id}`);
  for(const e of page.elements)if(e.rect.some(n=>n<0)||e.rect[0]+e.rect[2]>UI.width||e.rect[1]+e.rect[3]>UI.height-20)throw Error(`Invalid rectangle ${e.id}`);
}
await output(bp,"entities/interface_panel.json",withHeartbeat(entity("ns:interface_panel",mainProps)));
await output(bp,"entities/text_layer.json",withHeartbeat(entity("ns:text_layer",textProps)));
// Permanent leaderboard actors deliberately have no heartbeat expiry, owner
// interaction or session cleanup. Their records live in world dynamic data.
for(const [identifier,properties] of [["leaderboard_panel",mainProps],["leaderboard_text",textProps]]){
  const def=entity(`ns:${identifier}`,properties),e=def["minecraft:entity"];
  delete e.components["minecraft:timer"];delete e.components["minecraft:interact"];
  delete e.components["minecraft:custom_hit_test"];e.events={};e.component_groups={};
  await output(bp,`entities/${identifier}.json`,def);
}
await output(bp,"loot_tables/ns/empty.json",{pools:[]});
const mainGeos=[],textGeos=[], pageTextures={}, mainGeometryNames={}, textGeometryNames={};
const mainControllers={};
const iconAtlas=new Raster(16*ICONS.length*s,16*s);
ICONS.forEach((name,i)=>iconAtlas.blit(icon(name),i*16*s,0,s));
await output(rp,"textures/entity/ns/icons.png",png(iconAtlas));
const cardsAtlas=new Raster(CARD.width*CARD.columns*s,CARD.height*CARD.rows*s);
for(let id=0;id<CARD.count;id++)cardsAtlas.blit(playingCard(id),(id%CARD.columns)*CARD.width*s,Math.floor(id/CARD.columns)*CARD.height*s,s);
await output(rp,"textures/entity/ns/playing_cards.png",png(cardsAtlas));
await output(rp,"textures/items/interface_remote.png",png(icon("remote")));
await output(rp,"textures/items/transparent_remote.png",png(icon("transparent_remote")));
const glyphAtlas=new Raster(128,1024);
COLORS.forEach((color,sheet)=>[...ALPHABET].forEach((char,i)=>glyphAtlas.text(char,(i%8)*16,(Math.floor(i/8)+sheet*8)*16,color,2)));
await output(rp,"textures/entity/ns/glyphs.png",png(glyphAtlas));

for(const [pg,page] of PAGES.entries()) {
  const image=new Raster(TW,TH), bones=baseBones(), visibility=[];
  const normalSprites=[],labelSprites=[],stateSprites=new Map();
  const rect=(r,color)=>image.rect(...r.map(n=>n*s),color);
  rect([0,0,UI.width,UI.height],THEME.panel);
  rect([2,2,UI.width-4,30],THEME.header); rect([2,UI.height-20,UI.width-4,18],THEME.footer);
  image.border(0,0,UI.width*s,UI.height*s,THEME.frame,THEME.borderPixels*s);
  image.border(2*s,2*s,(UI.width-4)*s,(UI.height-4)*s,THEME.frameInner,s);
  for(const card of page.cards){rect(card,THEME.card);image.border(...card.map(n=>n*s),THEME.cardBorder,THEME.borderPixels*s);}
  bones.push(quad("page",[0,0,UI.width,UI.height],[0,0,UI.width*s,UI.height*s],0));
  // Only the background/frame/cards disappear. Labels live on independent
  // transparent quads so both variants keep identical text and hit rectangles.
  visibility.push({page:`!${P("transparent")}`});
  // Sprite shelf below the visible page. Each state's pixels are baked once.
  let shelfX=0,shelfY=UI.height*s+16,rowH=0;
  const allocate=(w,h)=>{
    if(shelfX+w>TW){shelfX=0;shelfY+=rowH+2;rowH=0;}
    if(shelfY+h>TH)throw Error(`Texture sprite overflow: ${page.id}`);
    const uv=[shelfX,shelfY,w,h];shelfX+=w+2;rowH=Math.max(rowH,h);return uv;
  };
  const frameUV=allocate(THEME.borderPixels*s,THEME.borderPixels*s);
  image.rect(...frameUV,THEME.frame);
  const t=THEME.borderPixels;
  for(const [name,rect] of [["frame_top",[0,0,UI.width,t]],
    ["frame_bottom",[0,UI.height-t,UI.width,t]],
    ["frame_left",[0,t,t,UI.height-2*t]],["frame_right",[UI.width-t,t,t,UI.height-2*t]]])
    bones.push(quad(name,rect,frameUV,0.008));
  for(const [i,[x,y,label,color]] of page.labels.entries()) {
    const uv=allocate(label.length*6*s,7*s);
    image.text(label,uv[0],uv[1],COLORS[color],s);
    const rect=[x,y,label.length*6,7];
    bones.push(quad(`label${i}`,rect,uv,0.006));labelSprites.push({rect,uv});
  }
  for(const [i,e] of page.elements.entries()) {
    const [x,y,w,h]=e.rect;
    for(const state of ["normal","on","active","disabled"]) {
      const uv=allocate(w*s,h*s);
      const bg={normal:THEME.button,on:THEME.buttonOn,active:THEME.buttonActive,disabled:THEME.buttonDisabled}[state];
      image.rect(...uv,bg);image.border(...uv,state==="on"?THEME.onBorder:state==="disabled"?THEME.disabledBorder:THEME.buttonBorder,THEME.borderPixels*s);
      if(e.kind==="slot")image.border(uv[0]+2*s,uv[1]+2*s,w*s-4*s,h*s-4*s,THEME.footer,s);
      else {
        const label=e.label??"", lx=uv[0]+Math.floor((w-label.length*6)/2)*s;
        image.text(label,lx,uv[1]+Math.floor((h-7)/2)*s,state==="disabled"?COLORS[1]:COLORS[0],s);
      }
      const name=`e${i}_${state}`;bones.push(quad(name,e.rect,uv,0.012));
      stateSprites.set(`${e.id}:${state}`,{rect:e.rect,uv});
      if(state==="normal")normalSprites.push({id:e.id,rect:e.rect,uv});
      const hidden=bit("hidden",i),disabled=bit("disabled",i),active=bit("active",i),on=bit("on",i);
      const condition={normal:`!${disabled} && !${active} && !${on}`,on:`!${disabled} && !${active} && ${on}`,
        active:`!${disabled} && ${active}`,disabled}[state];
      visibility.push({[name]:`!${hidden} && (${condition})`});
    }
    if(e.kind==="slot") {
      // Separate render controllers use the 16x16 icon atlas and UV animation.
      const name=`icon${e.iconSlot}`;
      const q=quad(name,[x+10,y+5,16,16],[0,0,32,32],0.018);q.parent="root";
      const id=`geometry.ns.icon.${page.id}.${e.iconSlot}`;
      await output(rp,`models/entity/ns/icon_${page.id}_${e.iconSlot}.geo.json`,{format_version:"1.12.0","minecraft:geometry":[geometry(id,[...baseBones(),q],iconAtlas.width,iconAtlas.height)]});
      mainGeometryNames[name]=id;
      const digit=`math.mod(math.floor(${P(`icons${Math.floor(e.iconSlot/4)}`)} / ${64**(e.iconSlot%4)}), 64)`;
      mainControllers[`controller.render.ns.${name}`]={geometry:`Geometry.${name}`,materials:[{"*":"Material.animated"}],textures:["Texture.icons"],
        part_visibility:[{[name]:`v.pg == ${pg} && !${bit("hidden",i)}`}],
        uv_anim:{offset:[`${digit} / ${ICONS.length}`,0],scale:[1,1]}};
    }
  }
  for(const entry of page.playingCards??[]){
    const name=`bj_card${entry.slot}`,id=`geometry.ns.${name}`;
    const q=quad(name,entry.rect,[0,0,CARD.width*s,CARD.height*s],0.02);
    mainGeometryNames[name]=id;
    await output(rp,`models/entity/ns/${name}.geo.json`,{format_version:"1.12.0","minecraft:geometry":[geometry(id,[...baseBones(),q],cardsAtlas.width,cardsAtlas.height)]});
    const digit=`math.mod(math.floor(${P(`cards${Math.floor(entry.slot/4)}`)} / ${64**(entry.slot%4)}), 64)`;
    mainControllers[`controller.render.ns.${name}`]={geometry:`Geometry.${name}`,materials:[{"*":"Material.animated"}],textures:["Texture.cards"],
      part_visibility:[{[name]:`v.pg == ${pg} && ${digit} != 0`}],
      uv_anim:{offset:[`math.mod(${digit}, ${CARD.columns}) / ${CARD.columns}`,`math.floor(${digit} / ${CARD.columns}) / ${CARD.rows}`],scale:[1,1]}};
  }
  const sliceTexels=3*THEME.borderPixels*s;
  const hoverUV=allocate(sliceTexels,sliceTexels);
  image.rect(...hoverUV,[0,0,0,0]);image.border(...hoverUV,THEME.hover,THEME.borderPixels*s);
  // Opaque outline, no fade animation; separate depth avoids coplanar flicker.
  nineSlice(bones,"hover",8,8,hoverUV,0.09);
  const tipUV=allocate(sliceTexels,sliceTexels);
  image.rect(...tipUV,THEME.tooltip);image.border(...tipUV,THEME.tooltipBorder,THEME.borderPixels*s);
  nineSlice(bones,"tooltip",180,38,tipUV,0.035);
  for(let row=0;row<3;row++)for(let col=0;col<3;col++){
    visibility.push({[`hover_${row}${col}`]:P("hover_on")});visibility.push({[`tooltip_${row}${col}`]:P("tip_on")});
  }
  const cursor= circleCursor(),cursorUV=allocate(cursor.width*s,cursor.height*s);
  image.blit(cursor,cursorUV[0],cursorUV[1],s);
  // Render in front of glyph layers and tooltip geometry, centred on gaze.
  bones.push(quad("cursor",[-cursor.width/2,-cursor.height/2,cursor.width,cursor.height],cursorUV,0.12,"root",xyz(0,0,0)));
  visibility.push({cursor:P("cursor_on")});
  const id=`geometry.ns.panel.${page.id}`;mainGeometryNames[`p${pg}`]=id;
  // PNG compression doesn't save GPU memory. Trim the unused sprite shelf,
  // retaining authored texel density and UV coordinates exactly unchanged.
  const textureHeight=shelfY+rowH;
  pageTextures[`p${pg}`]=`textures/entity/ns/page_${page.id}`;
  if(page.passive){
    // No baked controls/background on passive boards: don't ship a redundant
    // multi-megabyte mostly blank texture solely to paint four solid borders.
    const solid=new Raster(4,4);solid.rect(0,0,4,4,THEME.frame);
    const frameBones=bones.filter(b=>b.name.startsWith("frame_")).map(b=>({...b,cubes:b.cubes.map(c=>({...c,uv:{south:{uv:[0,0],uv_size:[4,4]}}}))}));
    mainGeos.push(geometry(id,[...baseBones(),...frameBones],4,4));
    await output(rp,`textures/entity/ns/page_${page.id}.png`,png(solid));
  }else{
    mainGeos.push(geometry(id,bones,TW,textureHeight));
    await output(rp,`textures/entity/ns/page_${page.id}.png`,png({width:TW,height:textureHeight,data:image.data.subarray(0,TW*textureHeight*4)}));
  }
  // A CPU proof image of each page for visual QA, not an in-game screenshot.
  const makePreview=(transparent=false)=>{
  const preview=new Raster(UI.width*s,UI.height*s);
  const copy=(srcX,srcY,w,h,toX,toY)=>{for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
    const start=((srcY+yy)*image.width+srcX+xx)*4;
    // Alpha-tested label pixels leave the underlying background untouched.
    if(image.data[start+3])preview.pixel(toX+xx,toY+yy,[...image.data.subarray(start,start+4)]);
  }};
  if(!transparent)copy(0,0,preview.width,preview.height,0,0);
  preview.border(0,0,preview.width,preview.height,THEME.frame,THEME.borderPixels*s);
  const proofSprites=page.id==="blackjack"?normalSprites.filter(e=>!["insurance","decline","even_money"].includes(e.id))
    .map(e=>stateSprites.get(`${e.id}:${e.id==="hand0"?"active":["split","deal","minus","bet","plus","hand1","hand2","hand3","cards_prev","cards_next"].includes(e.id)?"disabled":"normal"}`)):normalSprites;
  for(const {rect:[x,y],uv:[u,v,w,h]} of [...labelSprites,...proofSprites])copy(u,v,w,h,x*s,y*s);
  for(const {slot,rect:[x,y]}of page.playingCards??[]){const demo={0:8,1:53,12:5,13:6}[slot];if(demo)preview.blit(playingCard(demo),x*s,y*s,s);}
  const sample={name:"MY PANEL",summary:"AMOUNT 16 / ENABLED",amount:"16",message:"RESET YOUR DEMO SETTINGS TO THEIR DEFAULTS?",prompt:page.id==="keyboard"?"ENTER A PANEL NAME":"AMOUNT: 1 TO 999999",input:page.id==="keyboard"?"MY PANEL_":"16_",hint:"LOOK AT A CONTROL. USE THE REMOTE.",description:"HOVER A SLOT FOR ITEM DETAILS"};
  if(page.passive){
    Object.assign(sample,{title:"LEADERBOARD / KILLS",objective:"SCOREBOARD: KILLS",headerRank:"#",headerName:"PLAYER",headerScore:"SCORE",status:"TOP 15 / LIVE SCORES"});
    for(let i=0;i<15;i++)Object.assign(sample,{[`rank${i}`]:`${i+1}.`,[`player${i}`]:i===0?"BUBBAXM":`PLAYER ${i+1}`,[`score${i}`]:String(1500-i*87)});
  }
  if(page.id==="blackjack")Object.assign(sample,{balance:"BALANCE 9900 COINS",bet:"BET 100 / LIMIT 10-100000 EVEN COINS",dealerTotal:"TOTAL 8 + ?",
    message:"PLAY HAND 1 OF 1",handTitle:"HAND 1 / 11 / BET 100 / PLAYING / CARDS 1-2",summary0:"11 / BET 100 / PLAYING",
    summary1:"NO HAND",summary2:"NO HAND",summary3:"NO HAND",hint:"GAZE + INTERACT TO PLAY / CLOSE AUTO-STANDS"});
  const previewCells=textCells(page),previewChars=fieldCharacters(previewCells,sample);
  previewCells.forEach((c,i)=>{if(!c.tooltip)preview.text(previewChars[i],c.x*s,c.y*s,COLORS[c.color],s*c.scale);});
  if(page.id==="inventory")page.elements.filter(e=>e.kind==="slot").forEach((e,i)=>preview.blit(icon(ICONS[i+2]),(e.rect[0]+10)*s,(e.rect[1]+5)*s,s));
  return preview;
  };
  const preview=makePreview();
  await output(root,`previews/${page.id}.png`,png(preview));
  await output(root,`previews/transparent_${page.id}.png`,png(makePreview(true)));
  if(page.id==="dashboard") {
    const hovered=page.elements.find(e=>e.id==="controls");
    preview.border(...hovered.rect.map(n=>n*s),THEME.hover,THEME.borderPixels*s);
    preview.blit(cursor,(80-cursor.width/2)*s,(121-cursor.height/2)*s,s);
    await output(root,"previews/cursor.png",png(preview));
  }
  mainControllers[`controller.render.ns.page_${pg}`]={
    arrays:{geometries:{"Array.geo":PAGES.map((_,i)=>`Geometry.p${i}`)},textures:{"Array.tex":PAGES.map((_,i)=>`Texture.p${i}`)}},
    geometry:"Array.geo[v.pg]",materials:[{"*":"Material.panel"}],textures:["Array.tex[v.pg]"],
    // Bedrock rejects an explicitly empty optional array, invalidating this
    // entire file. Passive geometry needs no visibility overrides: omit it.
    ...(page.passive?{}:{part_visibility:visibility})
  };
  const cells=textCells(page);
  for(let layer=0;layer<MAX_LAYERS;layer++) {
    cells.slice(layer*UI.cellsPerLayer,(layer+1)*UI.cellsPerLayer).forEach((c,i)=>{
      const id=`geometry.ns.text.${page.id}.${layer}.${i}`,bone=quad(`c${i}`,[c.x,c.y,8*c.scale,8*c.scale],[0,c.color*128,16,16],0);
      // One renderer, one quad, instead of hiding an entire 108-glyph model.
      // The colour sheet is a static UV, not a long Molang branch.
      delete bone.parent;
      const textBones=c.tooltip?[{name:"tip_text",pivot:xyz(0,0,0)},{...bone,parent:"tip_text"}]:[bone];
      textGeos.push(geometry(id,textBones,128,1024));textGeometryNames[`p${pg}l${layer}c${i}`]=id;
    });
  }
}
await output(rp,"models/entity/ns/pages.geo.json",{format_version:"1.12.0","minecraft:geometry":mainGeos});
textGeos.push(geometry("geometry.ns.text.empty",[{name:"empty",pivot:[0,0,0]}],128,1024));
textGeometryNames.empty="geometry.ns.text.empty";
await output(rp,"models/entity/ns/text.geo.json",{format_version:"1.12.0","minecraft:geometry":textGeos});
// Blank cells skip rendering altogether. Each packed int is read once per frame;
// decoded glyph values are shared by the render condition and UV animation.
const textControllers={}, textConditions=[], glyphPre=[];
for(let p=0;p<UI.textPacks;p++)glyphPre.push(`v.pack${p} = ${P(`t${p}`)};`);
for(let i=0;i<UI.cellsPerLayer;i++) {
  const digit=`v.g${i}`,tips=[];
  glyphPre.push(`${digit} = math.mod(math.floor(v.pack${Math.floor(i/4)} / ${64**(i%4)}), 64);`);
  const geometries=PAGES.flatMap((_,pg)=>Array.from({length:MAX_LAYERS},(_,l)=>
    `Geometry.${textGeometryNames[`p${pg}l${l}c${i}`]?`p${pg}l${l}c${i}`:"empty"}`));
  for(let pg=0;pg<PAGES.length;pg++)for(let layer=0;layer<MAX_LAYERS;layer++) {
    const cell=textCells(PAGES[pg])[layer*UI.cellsPerLayer+i], idx=pg*MAX_LAYERS+layer;
    if(cell?.tooltip)tips.push(`v.gi == ${idx}`);
  }
  const tip=tips.length?`(${tips.join(" || ")})`:"0";
  const visible=`${digit} != 0 && (!${tip} || ${P("tip_on")})`;
  textConditions.push({[`controller.render.ns.glyph_${i}`]:visible});
  textControllers[`controller.render.ns.glyph_${i}`]={
    arrays:{geometries:{"Array.geo":geometries}}, geometry:"Array.geo[v.gi]",
    materials:[{"*":"Material.animated"}],textures:["Texture.glyphs"],
    uv_anim:{offset:[`math.mod(${digit}, 8) / 8`,`math.floor(${digit} / 8) / 64`],scale:[1,1]}
  };
  // Leaderboards don't need page switching, tooltip conditions or demo models.
  textControllers[`controller.render.ns.lb_glyph_${i}`]={
    arrays:{geometries:{"Array.geo":Array.from({length:MAX_LAYERS},(_,l)=>
      `Geometry.${textGeometryNames[`p${PAGE_IDS.leaderboard}l${l}c${i}`]?`p${PAGE_IDS.leaderboard}l${l}c${i}`:"empty"}`)}},
    geometry:"Array.geo[v.layer]",materials:[{"*":"Material.animated"}],textures:["Texture.glyphs"],
    uv_anim:{offset:[`math.mod(${digit}, 8) / 8`,`math.floor(${digit} / 8) / 64`],scale:[1,1]}
  };
}
// Solid shallow strips avoid back-face/zero-depth culling of the opaque frame.
// A 16x16 solid swatch keeps normal entity texture sampling inexpensive.
const frameTextureSize=16;
const frameRaster=new Raster(frameTextureSize,frameTextureSize);frameRaster.rect(0,0,frameTextureSize,frameTextureSize,THEME.frame);
await output(rp,"textures/entity/ns/leaderboard_frame.png",png(frameRaster));
const t=THEME.borderPixels,frameRects=[[0,0,UI.width,t],[0,UI.height-t,UI.width,t],[0,t,t,UI.height-2*t],[UI.width-t,t,t,UI.height-2*t]];
const frameBones=frameRects.map((r,i)=>{
  const bone=quad(["frame_top","frame_bottom","frame_left","frame_right"][i],r,[0,0,frameTextureSize,frameTextureSize],0.008);
  for(const cube of bone.cubes){
    cube.size[2]=0.08;
    cube.uv=Object.fromEntries(["north","south","east","west","up","down"].map(face=>
      [face,{uv:[0,0],uv_size:[frameTextureSize,frameTextureSize]}]));
  }
  return bone;
});
await output(rp,"models/entity/ns/leaderboard_frame.geo.json",{format_version:"1.12.0","minecraft:geometry":[geometry("geometry.ns.leaderboard_frame",[...baseBones(),...frameBones],frameTextureSize,frameTextureSize)]});
// Keep the passive frame independent of demo-page renderer schema failures.
await output(rp,"render_controllers/ns_leaderboard.render_controllers.json",{format_version:"1.8.0",render_controllers:{
  "controller.render.ns.lb_frame":{geometry:"Geometry.default",materials:[{"*":"Material.panel"}],textures:["Texture.frame"],part_visibility:[{"*":true}]}
}});
await output(rp,"render_controllers/ns_panel.render_controllers.json",{format_version:"1.8.0",render_controllers:mainControllers});
await output(rp,"render_controllers/ns_text.render_controllers.json",{format_version:"1.8.0",render_controllers:textControllers});
await output(rp,"animations/ns_panel.animation.json",{format_version:"1.8.0",animations:{
  "animation.ns.panel":{loop:true,bones:{...sliceAnimation("hover",8,8,"hover_xy","hover_wh"),
    ...sliceAnimation("tooltip",180,38,"tip_xy","tip_wh"),
    cursor:{position:[uiOffsetExpression(pairX("cursor_xy")),uiOffsetExpression(pairY("cursor_xy")),0]}}},
  "animation.ns.text":{loop:true,bones:{tip_text:{position:[uiOffsetExpression(pairX("tip_xy")),uiOffsetExpression(pairY("tip_xy")),0]}}}
}});
const common={materials:{panel:"entity_alphatest",animated:"player_animated"},
  scripts:{pre_animation:[`v.pg = ${P("page")};`],scale:`${P("scale")} / 1000`,animate:["layout"]}};
await output(rp,"entity/interface_panel.entity.json",{format_version:"1.10.0","minecraft:client_entity":{description:{
  identifier:"ns:interface_panel",...common, textures:{...pageTextures,icons:"textures/entity/ns/icons",cards:"textures/entity/ns/playing_cards"},
  geometry:mainGeometryNames,animations:{layout:"animation.ns.panel"},
  render_controllers:[...PAGES.map((_,i)=>({[`controller.render.ns.page_${i}`]:`v.pg == ${i}`})),
    ...Object.keys(mainControllers).filter(k=>k.includes(".icon")||k.includes(".bj_card")).map(k=>{
      if(!k.includes(".bj_card"))return k;
      const slot=Number(k.split("bj_card")[1]);
      const digit=`math.mod(math.floor(${P(`cards${Math.floor(slot/4)}`)} / ${64**(slot%4)}), 64)`;
      return {[k]:`v.pg == ${PAGE_IDS.blackjack} && ${digit} != 0`};
    })]
}}});
await output(rp,"entity/text_layer.entity.json",{format_version:"1.10.0","minecraft:client_entity":{description:{
  identifier:"ns:text_layer",...common,
  scripts:{...common.scripts,pre_animation:[`v.pg = ${P("page")};`,`v.gi = v.pg * ${MAX_LAYERS} + ${P("layer")};`,...glyphPre]},
  textures:{glyphs:"textures/entity/ns/glyphs"},geometry:textGeometryNames,
  animations:{layout:"animation.ns.text"},render_controllers:textConditions
}}});
await output(rp,"entity/leaderboard_panel.entity.json",{format_version:"1.10.0","minecraft:client_entity":{description:{
  identifier:"ns:leaderboard_panel",materials:{panel:"entity_alphatest"},scripts:{scale:common.scripts.scale},
  textures:{frame:"textures/entity/ns/leaderboard_frame"},geometry:{default:"geometry.ns.leaderboard_frame"},
  render_controllers:["controller.render.ns.lb_frame"]
}}});
await output(rp,"entity/leaderboard_text.entity.json",{format_version:"1.10.0","minecraft:client_entity":{description:{
  identifier:"ns:leaderboard_text",...common,
  scripts:{scale:common.scripts.scale,pre_animation:[`v.layer = ${P("layer")};`,...glyphPre]},
  textures:{glyphs:"textures/entity/ns/glyphs"},geometry:Object.fromEntries(Object.entries(textGeometryNames).filter(([name])=>name==="empty"||name.startsWith(`p${PAGE_IDS.leaderboard}l`))),
  render_controllers:Array.from({length:UI.cellsPerLayer},(_,i)=>({[`controller.render.ns.lb_glyph_${i}`]:`v.g${i} != 0`}))
}}});
const toast=new Raster(16,16);toast.rect(0,0,16,16,THEME.panel);toast.border(0,0,16,16,THEME.frame,1);toast.border(1,1,14,14,THEME.frameInner,1);
await output(rp,"textures/ui/ns_toast.png",png(toast));
await output(rp,"textures/ui/ns_toast.json",{nineslice_size:[3,3,3,3],base_size:[16,16]});
await output(root,"build-report.json",{pages:PAGES.map(p=>({id:p.id,elements:p.elements.length,cells:textCells(p).length,layers:Math.ceil(textCells(p).length/UI.cellsPerLayer)})),
  properties:{panel:Object.keys(mainProps).length,textLayer:Object.keys(textProps).length},glyphs:ALPHABET.length,maxLayers:MAX_LAYERS,
  performance:{glyphQuadsPerRenderer:1,blankGlyphsSkipRenderer:true,
    pageTextureBytes:mainGeos.reduce((sum,g)=>sum+g.description.texture_width*g.description.texture_height*4,0),
    previousPageTextureBytes:PAGES.length*nextPowerOfTwo(Math.max(1024,UI.width*s))*TH*4,
    leaderboardFrameTextureBytes:frameTextureSize*frameTextureSize*4}});
console.log(`Built ${PAGES.length} pages; ${Object.keys(mainProps).length} panel properties, ${Object.keys(textProps).length} text-layer properties; up to ${MAX_LAYERS} text layers.`);
