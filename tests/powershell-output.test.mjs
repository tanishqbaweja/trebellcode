import test from "node:test";
import assert from "node:assert/strict";
import { decodePowerShellStderr } from "../desktop/powershell-output.mjs";

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
