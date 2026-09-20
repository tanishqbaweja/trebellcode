export async function api(path, options={}) {
  const init={...options,headers:{...(options.headers||{})}};
  if(init.body && typeof init.body!=="string" && !(init.body instanceof FormData)){
    init.headers["content-type"]="application/json";
    init.body=JSON.stringify(init.body);
  }
  const response=await fetch(path,init);
  const text=await response.text();
  let data=null;
  try{data=text?JSON.parse(text):{};}catch{data={raw:text};}
  if(!response.ok) throw new Error(data?.error || data?.message || `HTTP ${response.status}`);
  return data;
}
export function wsUrl(path){
  const base=location.origin.replace(/^http/,"ws");
  return base+path;
}
