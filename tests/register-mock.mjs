import { registerHooks } from "node:module";
registerHooks({resolve(specifier,context,next){
  if(specifier==="@minecraft/server")return {url:new URL("./server-mock.mjs",import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
