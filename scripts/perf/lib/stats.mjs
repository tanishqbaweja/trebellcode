// Order statistics for repeated timing samples. Every summary keeps its raw samples so a reader can recompute it.
export function quantile(values,q){
  const sorted=values.filter(value=>Number.isFinite(value)).sort((a,b)=>a-b);if(!sorted.length)return null;
  const position=(sorted.length-1)*q,low=Math.floor(position),high=Math.ceil(position);
  return low===high?sorted[low]:sorted[low]+(sorted[high]-sorted[low])*(position-low);
}
export const median=values=>quantile(values,0.5);
export const p90=values=>quantile(values,0.9);
export function round(value,digits=1){return Number.isFinite(value)?Number(value.toFixed(digits)):null}
export function summarize(values,digits=1){
  const clean=values.filter(value=>Number.isFinite(value));
  if(!clean.length)return {n:0,median:null,p90:null,min:null,max:null,samples:[]};
  return {n:clean.length,median:round(median(clean),digits),p90:round(p90(clean),digits),min:round(Math.min(...clean),digits),max:round(Math.max(...clean),digits),samples:clean.map(value=>round(value,digits))};
}
// Summaries of each numeric key across a list of sample objects ({a:1,b:2}, {a:3,b:4} -> {a:{...},b:{...}}).
export function summarizeKeys(samples,digits=1){
  const keys=new Set();for(const sample of samples)for(const [key,value] of Object.entries(sample||{}))if(typeof value==="number")keys.add(key);
  return Object.fromEntries([...keys].map(key=>[key,summarize(samples.map(sample=>sample?.[key]),digits)]));
}
