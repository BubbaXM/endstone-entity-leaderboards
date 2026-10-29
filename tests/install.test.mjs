import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
test("direct bridge update preserves world lists/data and archives only superseded owned metadata",async()=>{
  const server=await mkdtemp(path.join(root,"tests","install-test-"));
  assert.ok(server.startsWith(path.join(root,"tests","install-test-")));
  try{
    const world=path.join(server,"worlds","TestWorld"),local=path.join(server,"plugins/.local");
    await mkdir(world,{recursive:true});await mkdir(path.join(local,"ns_lb_bridge"),{recursive:true});
    await writeFile(path.join(server,"server.properties"),"level-name=TestWorld\n");
    await writeFile(path.join(world,"level.dat"),"test world");
    const lists={world_behavior_packs:[{pack_id:"unrelated-bp",version:[1,0,0]}],world_resource_packs:[{pack_id:"unrelated-rp",version:[1,0,0]}]};
    for(const [name,value]of Object.entries(lists))await writeFile(path.join(world,`${name}.json`),JSON.stringify(value));
    const old="endstone_leaderboard_bridge-1.0.0.dist-info";
    await mkdir(path.join(local,old));await writeFile(path.join(local,old,"METADATA"),"Name: endstone-leaderboard-bridge\nVersion: 1.0.0\n");
    await mkdir(path.join(local,"unrelated-1.0.0.dist-info"));await writeFile(path.join(local,"unrelated-1.0.0.dist-info","METADATA"),"leave me");
    const data=path.join(server,"plugins/leaderboard_bridge");await mkdir(data,{recursive:true});
    await writeFile(path.join(data,"leaderboards.json"),"saved boards and scores");
    await run(process.execPath,[path.join(root,"tools/install.mjs"),server,"--bridge-only"]);
    for(const [name,value]of Object.entries(lists))assert.equal(await readFile(path.join(world,`${name}.json`),"utf8"),JSON.stringify(value));
    assert.equal(await readFile(path.join(data,"leaderboards.json"),"utf8"),"saved boards and scores");
    assert.equal(await readFile(path.join(local,"unrelated-1.0.0.dist-info","METADATA"),"utf8"),"leave me");
    assert.deepEqual((await readdir(local)).filter(n=>n.startsWith("endstone_leaderboard_bridge-")),["endstone_leaderboard_bridge-1.2.1.dist-info"]);
    assert.ok((await readdir(path.join(data,"install-backups")))[0].startsWith(old));
    const installed=await readFile(path.join(local,"ns_lb_bridge/assets/entity_ui_demo.mcpack"));
    assert.deepEqual(installed,await readFile(path.join(root,"server_bridge/ns_lb_bridge/assets/entity_ui_demo.mcpack")));
    // A second source update must neither add a second entry point nor rotate metadata again.
    await run(process.execPath,[path.join(root,"tools/install.mjs"),server,"--bridge-only"]);
    assert.equal((await readdir(path.join(data,"install-backups"))).length,1);
  }finally{await rm(server,{recursive:true,force:true});}
});
