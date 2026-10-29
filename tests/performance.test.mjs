import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {ALPHABET,UI,PAGES,PAGE_IDS,MAX_LAYERS,textCells} from "../behavior_pack/scripts/ui/layouts.js";
const json=async p=>JSON.parse(await readFile(new URL(p,import.meta.url),"utf8"));
const models=(await json("../resource_pack/models/entity/ns/text.geo.json"))["minecraft:geometry"];
const byId=new Map(models.map(m=>[m.description.identifier,m]));
const controllers=(await json("../resource_pack/render_controllers/ns_text.render_controllers.json")).render_controllers;

test("render controller optional part_visibility must be absent or nonempty, never []",async()=>{
  const directory=new URL("../resource_pack/render_controllers/",import.meta.url);
  for(const file of await readdir(directory)){
    if(!file.endsWith(".json"))continue;
    const data=JSON.parse(await readFile(new URL(file,directory),"utf8"));
    for(const [id,c] of Object.entries(data.render_controllers)){
      if(c.part_visibility===undefined)continue;
      assert.ok(Array.isArray(c.part_visibility)&&c.part_visibility.length>0,`${file}: ${id} has invalid empty part_visibility`);
    }
  }
});

test("every active glyph renderer binds exactly one quad with no whole-layer visibility work",async()=>{
  for(const name of ["text_layer","leaderboard_text"]){
    const client=(await json(`../resource_pack/entity/${name}.entity.json`))["minecraft:client_entity"].description;
    assert.equal(client.materials.animated,"player_animated");
    assert.equal(client.render_controllers.length,UI.cellsPerLayer);
    for(const entry of client.render_controllers){
      const [id,condition]=Object.entries(entry)[0];assert.match(condition,/v\.g\d+ != 0/);
      const c=controllers[id];assert.equal(c.part_visibility,undefined);
      for(const alias of c.arrays.geometries["Array.geo"]){
        const geometry=byId.get(client.geometry[alias.replace("Geometry.","")]);assert.ok(geometry);
        const cubes=geometry.bones.flatMap(b=>b.cubes??[]);assert.ok(cubes.length<=1);
      }
    }
    assert.equal(client.scripts.pre_animation.filter(s=>s.includes("q.property('ns:t")).length,UI.textPacks);
  }
});

test("static sheet UV plus glyph offset selects every original atlas cell exactly",()=>{
  for(const page of PAGES)for(const [index,cell] of textCells(page).entries()){
    const g=byId.get(`geometry.ns.text.${page.id}.${Math.floor(index/UI.cellsPerLayer)}.${index%UI.cellsPerLayer}`);
    const cube=g.bones.flatMap(b=>b.cubes??[])[0],uv=cube.uv.south;
    for(let glyph=0;glyph<ALPHABET.length;glyph++){
      assert.equal(uv.uv[0]+(glyph%8)/8*128,(glyph%8)*16);
      assert.equal(uv.uv[1]+Math.floor(glyph/8)/64*1024,cell.color*128+Math.floor(glyph/8)*16);
    }
  }
});

test("leaderboard client has no demo page references or looping animations",async()=>{
  const client=(await json("../resource_pack/entity/leaderboard_text.entity.json"))["minecraft:client_entity"].description;
  assert.equal(client.scripts.animate,undefined);assert.equal(client.animations,undefined);
  assert.ok(Object.keys(client.geometry).every(k=>k==="empty"||k.startsWith(`p${PAGE_IDS.leaderboard}l`)));
  for(const entry of client.render_controllers){
    const c=controllers[Object.keys(entry)[0]];assert.equal(c.arrays.geometries["Array.geo"].length,MAX_LAYERS);
    assert.equal(c.geometry,"Array.geo[v.layer]");
  }
  const panel=(await json("../resource_pack/entity/leaderboard_panel.entity.json"))["minecraft:client_entity"].description;
  assert.equal(panel.scripts.animate,undefined);assert.equal(Object.keys(panel.textures).length,1);
  const png=await readFile(new URL("../resource_pack/textures/entity/ns/leaderboard_frame.png",import.meta.url));
  assert.equal(png.readUInt32BE(16),16);assert.equal(png.readUInt32BE(20),16);
});

test("leaderboard's actual bound border model has a root and four fully faced solid strips",async()=>{
  const panel=(await json("../resource_pack/entity/leaderboard_panel.entity.json"))["minecraft:client_entity"].description;
  const geos=(await json("../resource_pack/models/entity/ns/leaderboard_frame.geo.json"))["minecraft:geometry"];
  const geo=geos.find(g=>g.description.identifier===panel.geometry.default);assert.ok(geo);
  assert.ok(geo.bones.some(b=>b.name==="root"));
  const t=2,expected={frame_top:[0,0,UI.width,t],frame_bottom:[0,UI.height-t,UI.width,t],
    frame_left:[0,t,t,UI.height-2*t],frame_right:[UI.width-t,t,t,UI.height-2*t]};
  for(const [name,rect] of Object.entries(expected)){
    const bone=geo.bones.find(b=>b.name===name);assert.equal(bone.parent,"root");
    assert.equal(bone.cubes.length,1);
    const c=bone.cubes[0],f=16/UI.pxPerBlock;
    assert.ok(c.size.every(n=>n>0));
    const actual=[UI.width/2-(c.origin[0]+c.size[0])/f,UI.height/2-(c.origin[1]+c.size[1])/f,c.size[0]/f,c.size[1]/f];
    actual.forEach((n,i)=>assert.ok(Math.abs(n-rect[i])<1e-7));
    assert.deepEqual(Object.keys(c.uv).sort(),["down","east","north","south","up","west"]);
    for(const face of Object.values(c.uv))assert.deepEqual(face,{uv:[0,0],uv_size:[16,16]});
  }
  const allControllers=(await json("../resource_pack/render_controllers/ns_leaderboard.render_controllers.json")).render_controllers;
  assert.equal(panel.render_controllers.length,1);
  const controller=allControllers[panel.render_controllers[0]];
  assert.deepEqual(controller.part_visibility,[{"*":true}]);
  assert.equal(controller.geometry,"Geometry.default");assert.deepEqual(controller.textures,["Texture.frame"]);
  assert.ok(!JSON.stringify(controller).includes("q.property"),"Border is never gated by transparent/hover state");
  const report=await json("../build-report.json");assert.equal(report.performance.leaderboardFrameTextureBytes,1024);
});

test("border renderer is isolated from demo pages and passive page has no visibility override",async()=>{
  const frame=await json("../resource_pack/render_controllers/ns_leaderboard.render_controllers.json");
  const demo=await json("../resource_pack/render_controllers/ns_panel.render_controllers.json");
  assert.deepEqual(Object.keys(frame.render_controllers),["controller.render.ns.lb_frame"]);
  assert.equal(demo.render_controllers["controller.render.ns.lb_frame"],undefined);
  assert.equal(demo.render_controllers[`controller.render.ns.page_${PAGE_IDS.leaderboard}`].part_visibility,undefined);
});

test("trimmed atlases retain the original-page budget and bound the added blackjack pages",async()=>{
  const report=await json("../build-report.json");
  const pages=(await json("../resource_pack/models/entity/ns/pages.geo.json"))["minecraft:geometry"];
  const original=pages.filter(g=>!g.description.identifier.includes("blackjack"));
  const oldBytes=original.reduce((n,g)=>n+g.description.texture_width*g.description.texture_height*4,0);
  assert.ok(oldBytes<report.performance.previousPageTextureBytes*(original.length/pages.length)*0.4);
  assert.ok(report.performance.pageTextureBytes<report.performance.previousPageTextureBytes*0.5);
  for(const g of pages){
    const page=g.description.identifier.split(".").at(-1),bytes=await readFile(new URL(`../resource_pack/textures/entity/ns/page_${page}.png`,import.meta.url));
    assert.equal(bytes.readUInt32BE(16),g.description.texture_width);assert.equal(bytes.readUInt32BE(20),g.description.texture_height);
    assert.equal(g.description.texture_width,page==="leaderboard"?4:UI.width*UI.texelScale);
  }
});
