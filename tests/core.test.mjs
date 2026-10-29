import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { UI, THEME, ALPHABET, PAGES, MAX_LAYERS, textCells } from "../behavior_pack/scripts/ui/layouts.js";
import { packGlyphs, unpackGlyphs, packPair, unpackPair, intersectPanel, hitTest, stateMasks, wrapText, fieldCharacters, changedProperties } from "../behavior_pack/scripts/ui/core.js";
import { Raster, png, crc32, circleCursor, rgba } from "../tools/raster.mjs";
import { controllers, DEFAULTS, loadState } from "../behavior_pack/scripts/ui/controllers.js";

test("64 unique glyphs; all 24-bit packed positions round-trip exactly as float32",()=>{
  assert.equal(ALPHABET.length,64);assert.equal(new Set(ALPHABET).size,64);
  for(let i=0;i<64;i++)for(let place=0;place<4;place++) {
    const chars=Array(4).fill(" ");chars[place]=ALPHABET[i];
    const packed=packGlyphs(chars);assert.ok(packed<2**24);
    assert.equal(Math.fround(packed),packed);assert.equal(unpackGlyphs(packed),chars.join(""));
  }
  assert.equal(packGlyphs("~~~~"),16777215);assert.equal(unpackGlyphs(packGlyphs("abcd")),"ABCD");
});
test("coordinate packing clamps and remains exact",()=>{
  assert.deepEqual(unpackPair(packPair(UI.width,UI.height)),[UI.width,UI.height]);
  assert.deepEqual(unpackPair(packPair(-10,2000)),[0,1023]);
});
const pose={center:{x:0,y:1.7,z:2.5},normal:{x:0,y:0,z:-1},right:{x:-1,y:0,z:0}};
test("gaze plane uses UI pixels, rejects behind/parallel/out-of-bounds rays",()=>{
  assert.deepEqual(intersectPanel({x:0,y:1.7,z:0},{x:0,y:0,z:1},pose),{x:UI.width/2,y:UI.height/2,t:2.5});
  assert.equal(intersectPanel({x:0,y:1.7,z:4},{x:0,y:0,z:-1},pose),null);
  assert.equal(intersectPanel({x:0,y:1.7,z:0},{x:1,y:0,z:0},pose),null);
  assert.equal(intersectPanel({x:4,y:1.7,z:0},{x:0,y:0,z:1},pose),null);
  assert.equal(intersectPanel({x:-0.5,y:1.7,z:0},{x:0,y:0,z:1},pose).x,UI.width/2+UI.pxPerBlock/2);
  assert.equal(intersectPanel({x:-0.5,y:1.7,z:0},{x:0,y:0,z:1},pose,2).x,UI.width/2+UI.pxPerBlock/4);
});
test("every element hit-tests at its center and excludes hidden states",()=>{
  for(const p of PAGES)for(const e of p.elements){
    const [x,y,w,h]=e.rect,pt={x:x+w/2,y:y+h/2};
    assert.equal(hitTest(p,pt).id,e.id);assert.equal(hitTest(p,pt,{[e.id]:{hidden:true}}),null);
  }
});
test("state masks split at bit 24 with no precision loss",()=>{
  const p=PAGES.find(p=>p.id==="keyboard");const states=Object.fromEntries(p.elements.map(e=>[e.id,{disabled:true}]));
  const masks=stateMasks(p,states);assert.equal(masks["ns:disabled0"],16777215);
  assert.equal(masks["ns:disabled1"],2**(p.elements.length-24)-1);
});
test("text wrapping, field cells and overflow layers are stable",()=>{
  assert.equal(wrapText("ONE TWO THREE",7,2),"ONE TWO"+"THREE  ");
  assert.equal(wrapText("LONGWORD",4,2),"LONGWORD");
  for(const p of PAGES){
    assert.equal(fieldCharacters(textCells(p),{}).length,textCells(p).length);
    assert.ok(textCells(p).length<=MAX_LAYERS*UI.cellsPerLayer);
    assert.ok(p.elements.length<=UI.maxElements);
  }
  assert.ok(MAX_LAYERS>1);
});
test("only changed values are sent",()=>{
  const previous=new Map([["a",1],["b",0]]);assert.deepEqual(changedProperties(previous,{a:1,b:2,c:0}),[["b",2],["c",0]]);
});
test("PNG encoder writes valid chunk checksums and exact filter-0 RGBA",()=>{
  const r=new Raster(2,2);r.rect(0,0,2,2,"#abcdef");const bytes=png(r);let offset=8,compressed=[];
  assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
  while(offset<bytes.length){const size=bytes.readUInt32BE(offset),type=bytes.subarray(offset+4,offset+8).toString(),data=bytes.subarray(offset+8,offset+8+size);
    assert.equal(crc32(bytes.subarray(offset+4,offset+8+size)),bytes.readUInt32BE(offset+8+size));
    if(type==="IDAT")compressed.push(data);offset+=12+size;
  }
  const decoded=inflateSync(Buffer.concat(compressed));assert.equal(decoded.length,18);assert.deepEqual([...decoded.subarray(1,5)],[171,205,239,255]);
});
test("saved settings validate malformed values",()=>{
  assert.deepEqual(loadState({getDynamicProperty:()=>"broken"}),DEFAULTS);
  const s=loadState({getDynamicProperty:()=>JSON.stringify({enabled:"bad",amount:10000000,name:"X".repeat(60)})});
  assert.equal(s.enabled,true);assert.equal(s.amount,999999);assert.equal(s.name.length,44);
});
test("gaze keyboard and exact-amount editor return results via callbacks",()=>{
  const results=[],ctx={args:{initial:"OLD",prompt:"TEST",maxLength:8,min:1,max:999999},data:{},session:{back:v=>results.push(v)}};
  controllers.keyboard.enter(ctx);controllers.keyboard.action(ctx,"erase");controllers.keyboard.action(ctx,"key:A");controllers.keyboard.action(ctx,"done");
  assert.equal(results.pop(),"OLA");ctx.data={};ctx.args.initial=16;
  controllers.amount.enter(ctx);controllers.amount.action(ctx,"digit:9");controllers.amount.action(ctx,"digit:3");controllers.amount.action(ctx,"done");
  assert.equal(results.pop(),93);controllers.amount.action(ctx,"cancel");assert.equal(results.pop(),undefined);
});
test("read-only inventory maps actual container data and tooltips",()=>{
  const items=[{typeId:"minecraft:spruce_log",amount:12},{typeId:"minecraft:apple",amount:3}];
  const ctx={player:{getComponent:()=>({container:{getItem:i=>items[i]}})},data:{}};
  const view=controllers.inventory.view(ctx);assert.equal(view.fields.count0,"12");assert.equal(view.icons[0],2);
  assert.equal(controllers.inventory.tooltip(ctx,"slot0").title,"spruce log");
  assert.equal(controllers.inventory.tooltip(ctx,"slot2").title,"EMPTY SLOT");
});
test("circle cursor is symmetric, outlined and hollow at the gaze point",()=>{
  const r=circleCursor(),pixel=(x,y)=>[...r.data.subarray((y*r.width+x)*4,(y*r.width+x)*4+4)];
  assert.equal(r.width,9);assert.equal(r.height,9);assert.equal(pixel(4,4)[3],0);
  assert.deepEqual(pixel(4,1),[255,255,255,255]);assert.deepEqual(pixel(4,0),rgba(THEME.cursorDark));
  for(let y=0;y<9;y++)for(let x=0;x<9;x++){
    assert.deepEqual(pixel(x,y),pixel(8-x,y));assert.deepEqual(pixel(x,y),pixel(x,8-y));
  }
});
