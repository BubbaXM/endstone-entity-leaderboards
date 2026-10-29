import { readFile, writeFile, mkdir, cp, access, readdir, rename, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const bridgeOnly=process.argv.includes("--bridge-only");
const server=path.resolve(process.argv.slice(2).find(a=>a!=="--bridge-only")??path.join(root,"../bedrock_server"));
const properties=await readFile(path.join(server,"server.properties"),"utf8");
const levelName=properties.match(/^level-name=(.+)$/m)?.[1].trim();
if(!levelName)throw Error("Cannot find level-name in server.properties");
const world=path.resolve(server,"worlds",levelName);
function within(parent,target){const rel=path.relative(parent,target);return rel!==""&&!rel.startsWith("..")&&!path.isAbsolute(rel);}
assert.ok(within(path.join(server,"worlds"),world),"World path escapes server/worlds");
await access(path.join(world,"level.dat"));
// No deletion, no pip, no wheel, no server restart. Update our packs and /lb bridge.
const plan=[];
if(!bridgeOnly)for(const [sourceName,folder,packName,worldFile] of [
  ["behavior_pack","behavior_packs","ns_entity_ui_demo_bp","world_behavior_packs.json"],
  ["resource_pack","resource_packs","ns_entity_ui_demo_rp","world_resource_packs.json"]]) {
  const source=path.join(root,sourceName),destination=path.resolve(server,folder,packName);
  assert.ok(within(path.join(server,folder),destination),"Unsafe pack destination");
  const manifest=JSON.parse(await readFile(path.join(source,"manifest.json"),"utf8"));
  try {
    const existing=JSON.parse(await readFile(path.join(destination,"manifest.json"),"utf8"));
    assert.equal(existing.header.uuid,manifest.header.uuid,`Refusing to overwrite an unrelated pack at ${destination}`);
  } catch(error) {if(error.code!=="ENOENT")throw error;}
  const target=path.join(world,worldFile);let original="[]\n";
  try{original=await readFile(target,"utf8");}catch(error){if(error.code!=="ENOENT")throw error;}
  const entries=JSON.parse(original);assert.ok(Array.isArray(entries));
  const item={pack_id:manifest.header.uuid,version:manifest.header.version};
  const index=entries.findIndex(e=>e.pack_id===item.pack_id);
  if(index<0)entries.push(item);else entries[index]=item;
  plan.push({source,destination,target,original,entries});
}
const stamp=new Date().toISOString().replace(/[:.]/g,"-");
// Endstone adds plugins/.local itself to sys.path on Windows. Put the direct
// package + entry-point metadata there, NOT Lib/site-packages, which its loader
// prunes at startup. This avoids a wheel and any global Python installation.
const bridgeTarget=path.resolve(server,"plugins/.local");
assert.ok(within(path.join(server,"plugins"),bridgeTarget),"Unsafe command bridge destination");
const bridgeSource=path.join(root,"server_bridge");
const metadataName="endstone_leaderboard_bridge-1.2.1.dist-info";
const priorMetadata=(await readdir(bridgeTarget).catch(error=>{if(error.code==="ENOENT")return [];throw error;}))
  .filter(name=>/^endstone_leaderboard_bridge-[0-9.]+\.dist-info$/.test(name));
let ownsBridge=false;
for(const name of priorMetadata){
  const directory=path.resolve(bridgeTarget,name);
  assert.ok(within(bridgeTarget,directory),"Unsafe prior metadata path");
  assert.ok(!(await lstat(directory)).isSymbolicLink(),"Refusing symlinked plugin metadata");
  assert.match(await readFile(path.join(directory,"METADATA"),"utf8"),/^Name: endstone-leaderboard-bridge$/m);
  ownsBridge=true;
}
try{
  await access(path.join(bridgeTarget,"ns_lb_bridge"));
  assert.ok(ownsBridge,"Refusing to overwrite an unrelated ns_lb_bridge package");
}catch(error){if(error.code!=="ENOENT")throw error;}
for(const file of ["ns_lb_bridge/__init__.py","ns_lb_bridge/plugin.py","ns_lb_bridge/backend.py","ns_lb_bridge/packets.py","ns_lb_bridge/model.py","ns_lb_bridge/layout.json","ns_lb_bridge/resource_pack.py","ns_lb_bridge/assets/entity_ui_demo.mcpack","ns_lb_bridge/assets/resource_pack.json",`${metadataName}/METADATA`,`${metadataName}/entry_points.txt`])
  await access(path.join(bridgeSource,file));
// Archive only our superseded entry-point metadata, outside Python's search
// path, so the loader never discovers two copies. Keep it recoverable.
for(const name of priorMetadata.filter(n=>n!==metadataName)){
  const source=path.resolve(bridgeTarget,name);
  const backup=path.resolve(server,"plugins/leaderboard_bridge/install-backups",`${name}-${stamp}`);
  assert.ok(within(bridgeTarget,source)&&within(path.join(server,"plugins/leaderboard_bridge"),backup));
  await mkdir(path.dirname(backup),{recursive:true});await rename(source,backup);
}
for(const name of ["ns_lb_bridge",metadataName]){
  const destination=path.join(bridgeTarget,name);
  await mkdir(bridgeTarget,{recursive:true});await cp(path.join(bridgeSource,name),destination,{recursive:true});
}
console.log(`Installed direct /lb packet backend: ${bridgeTarget}`);
for(const p of plan){
  await mkdir(p.destination,{recursive:true});await cp(p.source,p.destination,{recursive:true});
  const next=JSON.stringify(p.entries,null,2)+"\n";
  if(next!==p.original){await writeFile(`${p.target}.entity-ui-backup-${stamp}`,p.original,{flag:"wx"});await writeFile(p.target,next);}
  console.log(`Installed: ${p.destination}`);
}
console.log(bridgeOnly?"Bridge updated; bundled RP auto-installs on the next server start. No world pack lists changed.":`Enabled both packs in world: ${levelName}. Restart the server and accept its resource pack.`);
