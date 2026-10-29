import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { UI, PAGES, MAX_LAYERS, textCells } from "../behavior_pack/scripts/ui/layouts.js";
import { crc32 } from "./raster.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
async function files(dir){const entries=await readdir(dir,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]))).flat();}
const all=[...await files(path.join(root,"behavior_pack")),...await files(path.join(root,"resource_pack"))];
const parsed=new Map();for(const file of all.filter(f=>f.endsWith(".json")))parsed.set(file,JSON.parse(await readFile(file,"utf8")));
const entityDef=name=>parsed.get(path.join(root,`behavior_pack/entities/${name}.json`))["minecraft:entity"];
const entityNames=["interface_panel","text_layer","leaderboard_panel","leaderboard_text"];
for(const name of entityNames){
  const e=entityDef(name);assert.ok(Object.keys(e.description.properties).length<=32);
  for(const p of Object.values(e.description.properties)){assert.equal(p.type,"int");assert.equal(p.client_sync,true);assert.ok(p.range[1]<2**24);}
  assert.equal(e.components["minecraft:physics"].has_gravity,false);assert.equal(e.components["minecraft:physics"].has_collision,false);
  assert.deepEqual(e.components["minecraft:collision_box"],{width:0.01,height:0.01});assert.equal(e.components["minecraft:damage_sensor"].triggers[0].deals_damage,"no");
  if(name.startsWith("leaderboard_")){
    assert.equal(e.components["minecraft:timer"],undefined);
    assert.equal(e.components["minecraft:interact"],undefined);
    assert.ok(e.components["minecraft:persistent"]);
  }else{
    assert.deepEqual(e.components["minecraft:custom_hit_test"].hitboxes,[{width:UI.width/UI.pxPerBlock*UI.scale,height:UI.height/UI.pxPerBlock*UI.scale,pivot:[0,0,0]}]);
    assert.equal(e.components["minecraft:interact"].interactions[0].use_item,false);
    assert.ok(Object.hasOwn(e.events,"ns:interact"));
  }
}
const geos=new Map(), controllers=new Map();
for(const data of parsed.values()){
  for(const geo of data["minecraft:geometry"]??[]) {
    assert.ok(!geos.has(geo.description.identifier),"Duplicate geometry");geos.set(geo.description.identifier,geo);
    const names=new Set(geo.bones.map(b=>b.name));assert.equal(names.size,geo.bones.length);
    for(const bone of geo.bones){if(bone.parent)assert.ok(names.has(bone.parent));for(const c of bone.cubes??[]){
      assert.ok(c.size.every(n=>n>=0));for(const face of Object.values(c.uv)){
        assert.ok(face.uv[0]>=0&&face.uv[1]>=0);
        assert.ok(face.uv[0]+face.uv_size[0]<=geo.description.texture_width);
        assert.ok(face.uv[1]+face.uv_size[1]<=geo.description.texture_height);
      }
    }}
  }
  for(const [name,c]of Object.entries(data.render_controllers??{})){
    assert.ok(!controllers.has(name));
    if(c.part_visibility!==undefined)assert.ok(Array.isArray(c.part_visibility)&&c.part_visibility.length>0,`${name}: empty part_visibility is rejected by Bedrock`);
    controllers.set(name,c);
  }
}
for(const name of entityNames){
  const client=parsed.get(path.join(root,`resource_pack/entity/${name}.entity.json`))["minecraft:client_entity"].description;
  const properties=entityDef(name).description.properties;
  for(const id of Object.values(client.geometry))assert.ok(geos.has(id),`Missing geometry ${id}`);
  for(const entry of client.render_controllers){const id=typeof entry==="string"?entry:Object.keys(entry)[0];assert.ok(controllers.has(id),`Missing controller ${id}`);}
  for(const tex of Object.values(client.textures))assert.ok(all.includes(path.join(root,"resource_pack",`${tex}.png`)),`Missing texture ${tex}`);
  for(const id of client.render_controllers){
    const c=controllers.get(typeof id==="string"?id:Object.keys(id)[0]);
    for(const match of JSON.stringify(c).matchAll(/q\.property\('([^']+)'\)/g))assert.ok(properties[match[1]],`Undefined property ${match[1]}`);
    if(c.uv_anim)assert.equal(client.materials.animated,"player_animated");
  }
}
for(const p of PAGES){
  const pg=PAGES.indexOf(p);assert.ok(geos.has(`geometry.ns.panel.${p.id}`));
  if(!p.passive){
    const cursor=geos.get(`geometry.ns.panel.${p.id}`).bones.find(b=>b.name==="cursor").cubes[0];
    assert.deepEqual(cursor.size,[9*16/UI.pxPerBlock,9*16/UI.pxPerBlock,0]);
    assert.equal(cursor.origin[2],0.12);assert.deepEqual(cursor.uv.south.uv_size,[18,18]);
  }
  for(let layer=0;layer<MAX_LAYERS;layer++){
    for(const [i] of textCells(p).slice(layer*UI.cellsPerLayer,(layer+1)*UI.cellsPerLayer).entries()){
      const g=geos.get(`geometry.ns.text.${p.id}.${layer}.${i}`);
      assert.equal(g.bones.filter(b=>/^c\d+$/.test(b.name)).length,1);
      assert.equal(g.bones.flatMap(b=>b.cubes??[]).length,1);
    }
  }
  const c=controllers.get(`controller.render.ns.page_${pg}`);assert.equal(c.geometry,"Array.geo[v.pg]");assert.deepEqual(c.textures,["Array.tex[v.pg]"]);
}
for(const file of all.filter(f=>f.endsWith(".png"))){
  const bytes=await readFile(file);assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
  let offset=8;while(offset<bytes.length){const len=bytes.readUInt32BE(offset);assert.equal(crc32(bytes.subarray(offset+4,offset+8+len)),bytes.readUInt32BE(offset+8+len));offset+=12+len;}
}
const manifest=parsed.get(path.join(root,"behavior_pack/manifest.json"));assert.deepEqual(manifest.dependencies.filter(d=>d.module_name),[{module_name:"@minecraft/server",version:"2.0.0"}]);
const scripts=all.filter(f=>f.endsWith(".js"));for(const file of scripts)assert.doesNotMatch(await readFile(file,"utf8"),/server-ui|ActionFormData|ModalFormData|MessageFormData|sendMessage\(/);
const hud=parsed.get(path.join(root,"resource_pack/ui/hud_screen.json"));
assert.equal(hud.root_panel.modifications[0].value.hud_title_text_area.factory.control_ids.hud_title_text,"hud_title_text@hud.ns_title_router");
console.log(`Validated ${parsed.size} JSON files, ${geos.size} geometries, ${controllers.size} render controllers, all PNG CRCs and stable-only imports.`);
