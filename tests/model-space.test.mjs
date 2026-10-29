import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { UI, THEME, PAGES, MAX_LAYERS, textCells } from "../behavior_pack/scripts/ui/layouts.js";
import { intersectPanel, hitTest, packPair } from "../behavior_pack/scripts/ui/core.js";
import { spawnPose } from "../behavior_pack/scripts/ui/session.js";
import { playerFixture } from "./server-mock.mjs";
import { uiToModel, uiQuad, MODEL_UNITS_PER_PIXEL as f } from "../tools/model-space.mjs";

const json=async p=>JSON.parse(await readFile(new URL(p,import.meta.url),"utf8"));
const pages=(await json("../resource_pack/models/entity/ns/pages.geo.json"))["minecraft:geometry"];
const layers=(await json("../resource_pack/models/entity/ns/text.geo.json"))["minecraft:geometry"];
const glyphModels=new Map(layers.map(g=>[g.description.identifier,g]));
const animations=(await json("../resource_pack/animations/ns_panel.animation.json")).animations;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} should equal ${b}`);
function rectOf(bone) {
  const c=bone.cubes[0];
  // South-facing model's U=0 / visible left edge is maximum local X.
  return [UI.width/2-(c.origin[0]+c.size[0])/f,
    UI.height/2-(c.origin[1]+c.size[1])/f,c.size[0]/f,c.size[1]/f];
}
function assertRect(actual,expected) { actual.forEach((n,i)=>near(n,expected[i])); }
function evalOffset(expression,properties) {
  // Evaluate only our generated, arithmetic Molang subset, not arbitrary input.
  const expr=expression.replace(/q\.property\('([^']+)'\)/g,(_,id)=>String(properties[id]??0))
    .replaceAll("math.mod","mod").replaceAll("math.floor","Math.floor").replaceAll("math.max","Math.max");
  assert.match(expr,/^[0-9\s().,+*/\-a-zA-Z]+$/);
  return Function("mod",`return (${expr});`)((a,b)=>a%b);
}
function animatedRect(child,parent,animation,properties) {
  const transform=(point,bone)=>{
    const a=animation[bone.name]??{};
    return point.map((n,i)=>bone.pivot[i]+(n-bone.pivot[i])*evalOffset(String(a.scale?.[i]??1),properties)+
      evalOffset(String(a.position?.[i]??0),properties));
  };
  const c=child.cubes[0];
  const lo=transform(transform(c.origin,child),parent);
  const hi=transform(transform(c.origin.map((n,i)=>n+c.size[i]),child),parent);
  return [UI.width/2-hi[0]/f,UI.height/2-hi[1]/f,(hi[0]-lo[0])/f,(hi[1]-lo[1])/f];
}

test("nine-slice edges join all corners with constant two-pixel thickness",()=>{
  const animation=animations["animation.ns.panel"].bones,t=THEME.borderPixels;
  assert.equal(t,2);
  for(const geo of pages.filter(g=>!g.description.identifier.endsWith(".leaderboard")))for(const name of ["hover","tooltip"]){
    const prefix=name==="hover"?"hover":"tip",parent=geo.bones.find(b=>b.name===name);
    const targets=[...PAGES.flatMap(p=>p.elements.map(e=>e.rect)),[7,21,180,38],[33,80,250,54],[0,0,4,4]];
    for(const [x,y,w,h] of targets){
      const props={[`ns:${prefix}_xy`]:packPair(x,y),[`ns:${prefix}_wh`]:packPair(w,h)};
      for(let row=0;row<3;row++)for(let col=0;col<3;col++){
        const child=geo.bones.find(b=>b.name===`${name}_${row}${col}`);
        assertRect(animatedRect(child,parent,animation,props),[
          x+(col===0?0:col===1?t:w-t),y+(row===0?0:row===1?t:h-t),
          col===1?w-2*t:t,row===1?h-2*t:t]);
      }
    }
  }
});
test("UI coordinates map screen-right to model-negative-X, with positive cube sizes",()=>{
  assert.ok(uiToModel(20,0)[0]>uiToModel(300,0)[0]);
  assertRect(rectOf(uiQuad("sample",[20,30,100,40],[7,9,200,80],0)),[20,30,100,40]);
  const cube=uiQuad("sample",[20,30,100,40],[7,9,200,80],0).cubes[0];
  assert.deepEqual(cube.uv.south,{uv:[7,9],uv_size:[200,80]});
});
test("generated page/control geometry matches authored left-to-right rectangles",()=>{
  for(const [pg,p] of PAGES.entries()){
    const geo=pages[pg];if(p.passive)continue;
    assertRect(rectOf(geo.bones.find(b=>b.name==="page")),[0,0,UI.width,UI.height]);
    for(const [i,e] of p.elements.entries())for(const state of ["normal","disabled","on","active"])
      assertRect(rectOf(geo.bones.find(b=>b.name===`e${i}_${state}`)),e.rect);
  }
});

test("canvas is 2.5 times wider and taller with unchanged widget pixel density",async()=>{
  assert.equal(UI.width,320*2.5);assert.equal(UI.height,192*2.5);assert.equal(UI.pxPerBlock,160);assert.equal(UI.scale,1);
  for(const geo of pages.filter(g=>!g.description.identifier.endsWith(".leaderboard"))){
    const cube=geo.bones.find(b=>b.name==="page").cubes[0];
    assert.deepEqual(cube.size,[5*16,3*16,0]);
    assert.deepEqual(cube.uv.south.uv_size,[UI.width*UI.texelScale,UI.height*UI.texelScale]);
    assert.ok(geo.description.texture_width>=UI.width*UI.texelScale);
    assert.ok(geo.description.texture_height>UI.height*UI.texelScale);
    for(const b of geo.bones.filter(b=>/^e\d+_/.test(b.name)))assert.ok(b.cubes[0].uv.south.uv[1]>=UI.height*UI.texelScale);
  }
  for(const name of ["interface_panel","text_layer"]){
    const e=(await json(`../behavior_pack/entities/${name}.json`))["minecraft:entity"];
    assert.deepEqual(e.components["minecraft:custom_hit_test"].hitboxes,[{width:5,height:3,pivot:[0,0,0]}]);
  }
  for(const p of PAGES)if(!p.passive)assert.equal(textCells(p).find(c=>c.field==="hint").y,UI.height-14);
});
test("generated glyph cells preserve reading order without reversing strings or UVs",()=>{
  for(const [pg,p] of PAGES.entries())for(const [index,cell] of textCells(p).entries()){
    const geo=glyphModels.get(`geometry.ns.text.${p.id}.${Math.floor(index/UI.cellsPerLayer)}.${index%UI.cellsPerLayer}`);
    const bone=geo.bones.find(b=>b.name===`c${index%UI.cellsPerLayer}`);
    assertRect(rectOf(bone),[cell.x,cell.y,8*cell.scale,8*cell.scale]);
    assert.deepEqual(bone.cubes[0].uv.south,{uv:[0,cell.color*128],uv_size:[16,16]});
  }
});
test("generated icon geometry remains aligned with its actual slot",async()=>{
  const p=PAGES.find(p=>p.id==="inventory");
  for(const e of p.elements.filter(e=>e.kind==="slot")){
    const data=await json(`../resource_pack/models/entity/ns/icon_inventory_${e.iconSlot}.geo.json`);
    const bone=data["minecraft:geometry"][0].bones.find(b=>b.name===`icon${e.iconSlot}`);
    assertRect(rectOf(bone),[e.rect[0]+10,e.rect[1]+5,16,16]);
  }
});
test("cursor, hover and both tooltip parents move right together in rendered geometry",()=>{
  const panel=animations["animation.ns.panel"].bones,text=animations["animation.ns.text"].bones;
  for(const [bone,property] of [[panel.cursor,"cursor_xy"],[panel.hover,"hover_xy"],[panel.tooltip,"tip_xy"],[text.tip_text,"tip_xy"]]){
    for(const [x,y] of [[10,20],[160,96],[290,150]]) {
      const props={[`ns:${property}`]:packPair(x,y)};
      near(evalOffset(bone.position[0],props),-x*f);near(evalOffset(bone.position[1],props),-y*f);
    }
  }
  const cursor=pages[0].bones.find(b=>b.name==="cursor"),cube=cursor.cubes[0];
  for(const x of [10,160,290]) {
    const delta=evalOffset(panel.cursor.position[0],{"ns:cursor_xy":packPair(x,96)});
    const modelCenter=cube.origin[0]+cube.size[0]/2+delta;
    near(UI.width/2-modelCenter/f,x);
  }
  // Top-left -> bottom-right anchor direction must be corrected too.
  assert.ok(pages[0].bones.find(b=>b.name==="hover_00").pivot[0]>
    pages[0].bones.find(b=>b.name==="hover_22").pivot[0]);
});
test("generated visible button centers raycast back to the same IDs at varied headings",()=>{
  for(const degrees of [0,30,45,90,135,180,225,270,315]){
    const theta=degrees*Math.PI/180,{player}=playerFixture();
    player.direction={x:-Math.sin(theta),y:0,z:Math.cos(theta)};
    const pose=spawnPose(player),yaw=pose.rotation.y*Math.PI/180;
    for(const [pg,p] of PAGES.entries())for(const [i,e] of p.elements.entries()){
      const cube=pages[pg].bones.find(b=>b.name===`e${i}_normal`).cubes[0];
      const mx=(cube.origin[0]+cube.size[0]/2)/16,my=(cube.origin[1]+cube.size[1]/2)/16;
      const target={x:pose.center.x+mx*Math.cos(yaw),y:pose.center.y+my,z:pose.center.z+mx*Math.sin(yaw)};
      const origin=player.getHeadLocation();origin.y+=0.1;
      const ray={x:target.x-origin.x,y:target.y-origin.y,z:target.z-origin.z},len=Math.hypot(ray.x,ray.y,ray.z);
      const point=intersectPanel(origin,{x:ray.x/len,y:ray.y/len,z:ray.z/len},pose);
      assert.equal(hitTest(p,point)?.id,e.id,`${degrees} degrees / ${p.id} / ${e.id}`);
    }
  }
});
