// A byte count in the unit that keeps it readable: 512 B, 12.4 KB, 3.1 MB, 240 GB.
export function formatBytes(value){
  const bytes=Number(value);if(!Number.isFinite(bytes)||bytes<0)return "Unavailable";
  if(bytes<1024)return bytes+" B";
  const units=["KB","MB","GB","TB"];let scaled=bytes,index=-1;
  do{scaled/=1024;index++}while(scaled>=1024&&index<units.length-1);
  return (scaled>=100?Math.round(scaled):scaled.toFixed(1))+" "+units[index];
}
