import { tmpdir } from "node:os";
import { join } from "node:path";

export function e2eHome(){
  const explicit=String(process.env.TREBELL_E2E_HOME||"").trim();
  if(explicit)return explicit;
  const port=Math.max(1024,Math.min(65535,Number(process.env.TREBELL_E2E_PORT)||3210));
  return join(tmpdir(),"trebell-code-e2e-home-"+port);
}
