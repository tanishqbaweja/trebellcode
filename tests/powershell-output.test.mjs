import test from "node:test";
import assert from "node:assert/strict";
import { decodePowerShellJsonBase64, decodePowerShellStderr } from "../desktop/powershell-output.mjs";

test("PowerShell stderr decoder preserves ordinary text",()=>{
  assert.equal(decodePowerShellStderr("plain failure\r\n"),"plain failure");
});

test("PowerShell stderr decoder extracts readable errors from CLIXML",()=>{
  const cliXml=`#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj><S S="Error">Write-Error &apos;hello&apos; : hello_x000D__x000A_</S><S S="Error">    + CategoryInfo : NotSpecified_x000D__x000A_</S></Objs>`;
  assert.equal(decodePowerShellStderr(cliXml),"Write-Error 'hello' : hello\n+ CategoryInfo : NotSpecified");
});

test("PowerShell stderr decoder keeps unknown CLIXML instead of inventing an error",()=>{
  const cliXml="#< CLIXML\r\n<Objs><S S=\"Warning\">heads up</S></Objs>";
  assert.equal(decodePowerShellStderr(cliXml),cliXml.trim());
});

test("PowerShell Base64 JSON decoder preserves embedded control characters",()=>{
  const payload={title:"line\nbreak\u0000value",process:"Trebell Code",bounds:{x:1,y:2,width:3,height:4}};
  const encoded=Buffer.from(JSON.stringify(payload),"utf8").toString("base64");
  assert.deepEqual(decodePowerShellJsonBase64(encoded),payload);
});

test("PowerShell Base64 JSON decoder uses the payload line after shell noise",()=>{
  const payload={ok:true,title:"Workspace"};
  const encoded=Buffer.from(JSON.stringify(payload),"utf8").toString("base64");
  assert.deepEqual(decodePowerShellJsonBase64("diagnostic line\r\n"+encoded+"\r\n"),payload);
});
