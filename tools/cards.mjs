import { Raster } from "./raster.mjs";
const suits=[
  ["00100","01110","00100","11011","11111","11011","00100","01110"],
  ["00000","11011","11111","11111","01110","00100","00000"],
  ["00100","01110","11111","11111","01110","00100","00000"],
  ["00100","01110","11111","11111","11011","00100","01110"]
];
export const CARD={width:48,height:68,columns:9,rows:6,count:54};
export function playingCard(id){
  const image=new Raster(CARD.width,CARD.height);
  if(!id)return image;
  image.rect(0,0,48,68,"#f5eefa");image.border(0,0,48,68,"#aa83dc",2);
  if(id===53){
    image.rect(3,3,42,62,"#26123e");image.border(5,5,38,58,"#cba2ee",1);
    for(let y=9;y<60;y+=6)for(let x=9;x<40;x+=6)image.rect(x,y,2,2,"#72528f");
    image.text("BJ",12,26,"#ead4ff",2);return image;
  }
  const rank=(id-1)%13+1,suit=Math.floor((id-1)/13),red=suit===1||suit===2;
  const color=red?"#be345e":"#241532",label=rank===1?"A":rank===11?"J":rank===12?"Q":rank===13?"K":String(rank);
  image.text(label,4,4,color,2);image.text(label,48-4-label.length*12,50,color,2);
  suits[suit].forEach((row,y)=>[...row].forEach((v,x)=>{if(v==="1")image.rect(16+x*3,23+y*3,3,3,color);}));
  return image;
}
