import { tmpdir } from "node:os";
import { join } from "node:path";

export function e2eHome(){
  const explicit=String(process.env.TREBELL_E2E_HOME||"").trim();
  if(explicit)return explicit;
  const port=Math.max(1024,Math.min(65535,Number(process.env.TREBELL_E2E_PORT)||3210));
  return join(tmpdir(),"trebell-code-e2e-home-"+port);
}

// Every spec file of a run shares one mock server and its home. A page talking to a fake harness keeps what Trebell notes of the
// threads that harness lists (their thread meta) in the page with this, instead of leaving it on that server, where every later spec
// would list those threads. It answers as the server would: a write merges into the thread's meta, a read returns it.
export async function keepThreadMeta(page){
  const meta={},answer=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>{
    if(route.request().method()!=="POST")return answer(route,meta[new URL(route.request().url()).searchParams.get("threadId")]||{});
    const body=route.request().postDataJSON()||{},id=String(body.threadId||"");meta[id]={...(meta[id]||{}),...(body.patch||{})};return answer(route,meta[id]);
  });
}
