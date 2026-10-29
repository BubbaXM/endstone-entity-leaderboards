import { deflateSync } from "node:zlib";
import { THEME } from "../behavior_pack/scripts/ui/layouts.js";

// Original 5x7 bitmap alphabet. No fonts, image libraries, or native dependencies.
const patterns = {
  A:"01110/10001/10001/11111/10001/10001/10001", B:"11110/10001/10001/11110/10001/10001/11110",
  C:"01111/10000/10000/10000/10000/10000/01111", D:"11110/10001/10001/10001/10001/10001/11110",
  E:"11111/10000/10000/11110/10000/10000/11111", F:"11111/10000/10000/11110/10000/10000/10000",
  G:"01111/10000/10000/10111/10001/10001/01111", H:"10001/10001/10001/11111/10001/10001/10001",
  I:"11111/00100/00100/00100/00100/00100/11111", J:"00111/00010/00010/00010/10010/10010/01100",
  K:"10001/10010/10100/11000/10100/10010/10001", L:"10000/10000/10000/10000/10000/10000/11111",
  M:"10001/11011/10101/10101/10001/10001/10001", N:"10001/11001/10101/10011/10001/10001/10001",
  O:"01110/10001/10001/10001/10001/10001/01110", P:"11110/10001/10001/11110/10000/10000/10000",
  Q:"01110/10001/10001/10001/10101/10010/01101", R:"11110/10001/10001/11110/10100/10010/10001",
  S:"01111/10000/10000/01110/00001/00001/11110", T:"11111/00100/00100/00100/00100/00100/00100",
  U:"10001/10001/10001/10001/10001/10001/01110", V:"10001/10001/10001/10001/10001/01010/00100",
  W:"10001/10001/10001/10101/10101/10101/01010", X:"10001/10001/01010/00100/01010/10001/10001",
  Y:"10001/10001/01010/00100/00100/00100/00100", Z:"11111/00001/00010/00100/01000/10000/11111",
  0:"01110/10001/10011/10101/11001/10001/01110", 1:"00100/01100/00100/00100/00100/00100/01110",
  2:"01110/10001/00001/00010/00100/01000/11111", 3:"11110/00001/00001/01110/00001/00001/11110",
  4:"00010/00110/01010/10010/11111/00010/00010", 5:"11111/10000/10000/11110/00001/00001/11110",
  6:"01110/10000/10000/11110/10001/10001/01110", 7:"11111/00001/00010/00100/01000/01000/01000",
  8:"01110/10001/10001/01110/10001/10001/01110", 9:"01110/10001/10001/01111/00001/00001/01110",
  ".":"00000/00000/00000/00000/00000/00110/00110", ",":"00000/00000/00000/00000/00110/00110/00100",
  ":":"00000/00110/00110/00000/00110/00110/00000", ";":"00000/00110/00110/00000/00110/00110/00100",
  "!":"00100/00100/00100/00100/00100/00000/00100", "?":"01110/10001/00001/00010/00100/00000/00100",
  "+":"00000/00100/00100/11111/00100/00100/00000", "-":"00000/00000/00000/11111/00000/00000/00000",
  "*":"00000/10101/01110/11111/01110/10101/00000", "/":"00001/00010/00010/00100/01000/01000/10000",
  "=":"00000/00000/11111/00000/11111/00000/00000", "(":"00010/00100/01000/01000/01000/00100/00010",
  ")":"01000/00100/00010/00010/00010/00100/01000", "[":"01110/01000/01000/01000/01000/01000/01110",
  "]":"01110/00010/00010/00010/00010/00010/01110", "<":"00001/00010/00100/01000/00100/00010/00001",
  ">":"10000/01000/00100/00010/00100/01000/10000", "_":"00000/00000/00000/00000/00000/00000/11111",
  "%":"11001/11010/00100/01000/10110/00110/00000", "#":"01010/01010/11111/01010/11111/01010/01010",
  "@":"01110/10001/10111/10101/10111/10000/01110", "&":"01100/10010/10100/01000/10101/10010/01101",
  "'":"00100/00100/00000/00000/00000/00000/00000", '"':"01010/01010/00000/00000/00000/00000/00000",
  "\\":"10000/01000/01000/00100/00010/00010/00001", "|":"00100/00100/00100/00100/00100/00100/00100",
  "~":"00000/00000/01001/10110/00000/00000/00000", " ":"00000/00000/00000/00000/00000/00000/00000"
};
export const FONT = Object.fromEntries(Object.entries(patterns).map(([c, p]) => [c, p.split("/")]));
export function rgba(hex) {
  if (Array.isArray(hex)) return hex;
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16), 255];
}
export class Raster {
  constructor(width, height) { this.width = width; this.height = height; this.data = Buffer.alloc(width * height * 4); }
  pixel(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data.set(rgba(color), (Math.floor(y) * this.width + Math.floor(x)) * 4);
  }
  rect(x,y,w,h,color) { const c = rgba(color); for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)this.pixel(i,j,c); }
  border(x,y,w,h,c,t=1) { this.rect(x,y,w,t,c); this.rect(x,y+h-t,w,t,c); this.rect(x,y,t,h,c); this.rect(x+w-t,y,t,h,c); }
  text(text,x,y,color=THEME.text,scale=1) {
    for (const char of String(text).toUpperCase()) {
      (FONT[char] ?? FONT["?"]).forEach((row,dy) => [...row].forEach((bit,dx) => {
        if(bit === "1")this.rect(x+dx*scale,y+dy*scale,scale,scale,color);
      })); x += 6*scale;
    }
  }
  blit(other,x,y,scale=1) {
    for(let j=0;j<other.height;j++)for(let i=0;i<other.width;i++) {
      const c=[...other.data.subarray((j*other.width+i)*4,(j*other.width+i)*4+4)];
      if(c[3])this.rect(x+i*scale,y+j*scale,scale,scale,c);
    }
  }
}
const crcTable = Array.from({length:256},(_,n)=>{
  for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1; return n>>>0;
});
export function crc32(bytes) { let c=0xffffffff; for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8); return (c^0xffffffff)>>>0; }
function chunk(type,data) {
  const name=Buffer.from(type), head=Buffer.alloc(4), tail=Buffer.alloc(4);
  head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([head,name,data,tail]);
}
// PNG signature, IHDR, filter-0 RGBA scanlines, deflated IDAT, IEND.
export function png(image) {
  const header=Buffer.alloc(13); header.writeUInt32BE(image.width,0); header.writeUInt32BE(image.height,4);
  header[8]=8; header[9]=6;
  const rows=Buffer.alloc((image.width*4+1)*image.height);
  for(let y=0;y<image.height;y++)image.data.copy(rows,y*(image.width*4+1)+1,y*image.width*4,(y+1)*image.width*4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(rows)),chunk("IEND",Buffer.alloc(0))]);
}
export function icon(name) {
  const r=new Raster(16,16);
  const line=(x0,y0,x1,y1,c)=>{ const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0)); for(let i=0;i<=n;i++)r.pixel(Math.round(x0+(x1-x0)*i/(n||1)),Math.round(y0+(y1-y0)*i/(n||1)),c); };
  switch(name) {
    case "none": break;
    case "oak_log": r.rect(3,2,10,12,"#74492b"); r.border(3,2,10,12,"#38291e"); r.rect(4,3,8,3,"#c89d61"); r.border(6,4,4,2,"#966f44"); for(let x=5;x<12;x+=3)r.rect(x,7,1,6,"#a77d47"); break;
    case "sapling": r.rect(7,6,2,9,"#876544"); r.rect(2,2,11,5,"#3d9d54"); r.rect(4,0,7,10,"#409458"); r.rect(4,3,3,3,"#73c575"); break;
    case "apple": r.rect(7,1,2,3,"#746039"); r.rect(9,2,3,2,"#549750"); r.rect(3,5,10,7,"#db414d"); r.rect(5,4,6,10,"#c63042"); r.rect(4,6,2,3,"#ff8390"); break;
    case "diamond": for(let y=2;y<14;y++){const w=y<8?y-1:14-y;r.rect(8-w,y,w*2,1,"#61ddec");}line(5,5,8,2,"#d8ffff");line(4,8,8,13,"#238fa6"); break;
    case "wheat": r.rect(7,3,2,12,"#d4a34e"); for(let y=2;y<11;y+=3){r.rect(3,y,4,2,"#e4c46a");r.rect(9,y+1,4,2,"#c7a54c");}break;
    case "stick": line(4,13,12,3,"#593722");line(5,13,13,3,"#b08855");break;
    case "stone": r.rect(2,3,12,10,"#747f8b");r.border(2,3,12,10,"#4d5466");r.rect(4,4,5,2,"#a6adb7");r.rect(9,9,3,3,"#586272");break;
    case "chest": r.rect(2,4,12,10,"#aa7b3e");r.border(2,4,12,10,"#4a3623");r.rect(2,8,12,2,"#4a3623");r.rect(7,7,2,4,"#ebcf7c");break;
    case "gear": r.rect(4,4,8,8,"#929bb2");r.rect(6,1,4,14,"#929bb2");r.rect(1,6,14,4,"#929bb2");r.rect(6,6,4,4,"#252c40");break;
    case "heart": r.rect(2,3,5,5,"#f16c83");r.rect(9,3,5,5,"#f16c83");r.rect(4,6,8,5,"#e4516d");r.rect(6,11,4,2,"#e4516d");break;
    case "clock": r.rect(3,2,10,12,"#f3c969");r.rect(2,4,12,8,"#f3c969");r.rect(4,4,8,8,"#e9ecfa");r.rect(7,5,1,4,"#30384b");r.rect(7,8,4,1,"#30384b");break;
    case "check": line(2,8,6,12,"#77e5a5");line(6,12,14,3,"#77e5a5");line(2,7,6,11,"#77e5a5");line(6,11,14,2,"#77e5a5");break;
    case "arrow": line(2,8,13,8,THEME.accent);line(9,4,13,8,THEME.accent);line(9,12,13,8,THEME.accent);break;
    case "warning": for(let y=2;y<14;y++){const w=Math.floor((y-1)/2);r.rect(8-w,y,w*2+1,1,"#f3c969");}r.rect(8,6,1,4,"#252c40");r.pixel(8,12,"#252c40");break;
    case "transparent_remote": r.border(3,1,10,14,THEME.remoteFrame);r.border(5,3,6,4,THEME.remoteKeyAlt);r.rect(5,9,2,2,THEME.remoteKey);r.rect(9,9,2,2,THEME.remoteKeyAlt);r.rect(7,12,2,1,THEME.muted);break;
    default: r.rect(3,1,10,14,THEME.remoteBody);r.border(3,1,10,14,THEME.remoteFrame);r.rect(5,3,6,4,THEME.remoteScreen);r.rect(5,9,2,2,THEME.remoteKey);r.rect(9,9,2,2,THEME.remoteKeyAlt);r.rect(7,12,2,1,THEME.muted);
  }
  return r;
}
// Hollow circular reticle with a dark outline; leaves the exact gaze point clear.
export function circleCursor() {
  const r=new Raster(9,9);
  for(let y=0;y<9;y++)for(let x=0;x<9;x++) {
    const radius=Math.hypot(x-4,y-4);
    if(radius>=1.8 && radius<=4.2)r.pixel(x,y,THEME.cursorDark);
    if(radius>=2.8 && radius<=3.8)r.pixel(x,y,"#ffffff");
  }
  return r;
}
