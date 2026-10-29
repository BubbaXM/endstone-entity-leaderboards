import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { THEME, UI, PAGES } from "../behavior_pack/scripts/ui/layouts.js";
import { rgba } from "../tools/raster.mjs";

const json=async file=>JSON.parse(await readFile(new URL(file,import.meta.url),"utf8"));
const geos=(await json("../resource_pack/models/entity/ns/pages.geo.json"))["minecraft:geometry"];
async function pixels(file) {
  const bytes=await readFile(new URL(file,import.meta.url)),width=bytes.readUInt32BE(16),chunks=[];
  for(let offset=8;offset<bytes.length;){
    const size=bytes.readUInt32BE(offset),type=bytes.subarray(offset+4,offset+8).toString();
    if(type==="IDAT")chunks.push(bytes.subarray(offset+8,offset+8+size));
    offset+=size+12;
  }
  const data=inflateSync(Buffer.concat(chunks)),stride=width*4+1;
  return (x,y)=>{
    assert.equal(data[y*stride],0,"Builder PNG must use filter zero");
    return [...data.subarray(y*stride+1+x*4,y*stride+5+x*4)];
  };
}

test("every generated hover border is fully opaque and separated from the button surface",async()=>{
  for(const geo of geos.filter(g=>!g.description.identifier.endsWith(".leaderboard"))){
    const page=geo.description.identifier.split(".").at(-1);
    const pixel=await pixels(`../resource_pack/textures/entity/ns/page_${page}.png`);
    for(let row=0;row<3;row++)for(let col=0;col<3;col++){
      const c=geo.bones.find(b=>b.name===`hover_${row}${col}`).cubes[0];
      assert.ok(c.origin[2]>=0.09);
      const {uv:[u,v],uv_size:[w,h]}=c.uv.south;
      assert.equal(w,THEME.borderPixels*UI.texelScale);assert.equal(h,w);
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        if(row===1&&col===1)assert.equal(pixel(u+x,v+y)[3],0);
        else assert.deepEqual(pixel(u+x,v+y),rgba(THEME.hover));
      }
    }
  }
  const animation=(await json("../resource_pack/animations/ns_panel.animation.json")).animations["animation.ns.panel"];
  assert.equal(animation.loop,true);
  for(const [name,bone] of Object.entries(animation.bones))if(name.startsWith("hover")){
    assert.equal(bone.rotation,undefined);
    assert.ok(!JSON.stringify(bone).includes("life_time"),"Hover must not decay over time");
  }
});

test("baked pages, all button states, remote and toast use midnight purple",async()=>{
  for(const geo of geos){
    const page=geo.description.identifier.split(".").at(-1);
    const pixel=await pixels(`../resource_pack/textures/entity/ns/page_${page}.png`);
    assert.deepEqual(pixel(0,0),rgba(THEME.frame));
    if(page==="leaderboard")continue;
    assert.deepEqual(pixel(10*UI.texelScale,100*UI.texelScale),rgba(THEME.panel));
    for(const bone of geo.bones.filter(b=>/^e\d+_(normal|on|active|disabled)$/.test(b.name))){
      const [u,v]=bone.cubes[0].uv.south.uv,state=bone.name.split("_").at(-1);
      const color=state==="on"?THEME.onBorder:state==="disabled"?THEME.disabledBorder:THEME.buttonBorder;
      assert.deepEqual(pixel(u,v),rgba(color));
    }
  }
  const remote=await pixels("../resource_pack/textures/items/interface_remote.png");
  assert.deepEqual(remote(3,1),rgba(THEME.remoteFrame));
  assert.deepEqual(remote(4,8),rgba(THEME.remoteBody));
  assert.deepEqual(remote(5,3),rgba(THEME.remoteScreen));
  const toast=await pixels("../resource_pack/textures/ui/ns_toast.png");
  assert.deepEqual(toast(0,0),rgba(THEME.frame));assert.deepEqual(toast(4,4),rgba(THEME.panel));
});

test("transparent variant hides only the background, with independently alpha-tested labels",async()=>{
  const client=(await json("../resource_pack/entity/interface_panel.entity.json"))["minecraft:client_entity"].description;
  assert.equal(client.materials.panel,"entity_alphatest");
  const controllers=(await json("../resource_pack/render_controllers/ns_panel.render_controllers.json")).render_controllers;
  for(const [pg,page] of PAGES.entries()){
    const controller=controllers[`controller.render.ns.page_${pg}`];
    if(!page.passive)assert.deepEqual(controller.part_visibility.find(v=>Object.hasOwn(v,"page")),{page:"!q.property('ns:transparent')"});
    const pixel=await pixels(`../resource_pack/textures/entity/ns/page_${page.id}.png`);
    for(const [i,label] of page.labels.entries()){
      const bone=geos[pg].bones.find(b=>b.name===`label${i}`),{uv:[u,v],uv_size:[w,h]}=bone.cubes[0].uv.south;
      assert.ok(!controller.part_visibility.some(p=>Object.hasOwn(p,bone.name)),"Labels remain visible in both variants");
      assert.equal(w,label[2].length*6*UI.texelScale);assert.equal(h,7*UI.texelScale);
      let visible=0,clear=0;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        const alpha=pixel(u+x,v+y)[3];assert.ok(alpha===0||alpha===255);if(alpha)visible++;else clear++;
      }
      assert.ok(visible>0&&clear>0,"Only glyph pixels are opaque, not the label rectangle");
    }
    const preview=await pixels(`../previews/transparent_${page.id}.png`);
    assert.deepEqual(preview(0,0),rgba(THEME.frame));
    for(const [x,y] of [[10,100],[UI.width-10,100],[UI.width/2,UI.height/2]])assert.equal(preview(x*UI.texelScale,y*UI.texelScale)[3],0);
    for(const e of page.elements){
      const hidden=page.id==="blackjack"&&["insurance","decline","even_money"].includes(e.id);
      assert.equal(preview(e.rect[0]*UI.texelScale,e.rect[1]*UI.texelScale)[3],hidden?0:255);
    }
  }
});

test("transparent and leaderboard frame strips join into one continuous outer border",()=>{
  for(const geo of geos){
    const t=THEME.borderPixels,expected={frame_top:[0,0,UI.width,t],frame_bottom:[0,UI.height-t,UI.width,t],
      frame_left:[0,t,t,UI.height-2*t],frame_right:[UI.width-t,t,t,UI.height-2*t]};
    for(const [name,rect] of Object.entries(expected)){
      const cube=geo.bones.find(b=>b.name===name).cubes[0],f=16/UI.pxPerBlock;
      const actual=[UI.width/2-(cube.origin[0]+cube.size[0])/f,UI.height/2-(cube.origin[1]+cube.size[1])/f,cube.size[0]/f,cube.size[1]/f];
      actual.forEach((v,i)=>assert.ok(Math.abs(v-rect[i])<1e-7));
    }
  }
});

test("both remotes have separate item definitions and textures using the same stable component",async()=>{
  const atlas=(await json("../resource_pack/textures/item_texture.json")).texture_data;
  for(const [file,item] of [["interface_remote",UI.item],["transparent_remote","ns:transparent_remote"]]){
    const def=(await json(`../behavior_pack/items/${file}.json`))["minecraft:item"];
    assert.equal(def.description.identifier,item);assert.ok(Object.hasOwn(def.components,"ns:interface_remote"));
    assert.equal(atlas[def.components["minecraft:icon"]].textures,`textures/items/${file}`);
  }
  const remote=await pixels("../resource_pack/textures/items/transparent_remote.png");
  assert.deepEqual(remote(3,1),rgba(THEME.remoteFrame));assert.equal(remote(7,4)[3],0);
});
