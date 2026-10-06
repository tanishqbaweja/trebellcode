function decodeXmlText(value){
  return String(value||"")
    .replace(/_x([0-9A-Fa-f]{4})_/g,(_match,hex)=>String.fromCharCode(Number.parseInt(hex,16)))
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&quot;/g,'"')
    .replace(/&apos;/g,"'")
    .replace(/&amp;/g,"&");
}

export function decodePowerShellStderr(value){
  const text=String(value||"").trim();
  if(!text.startsWith("#< CLIXML"))return text;
  const errors=[...text.matchAll(/<S\s+S="Error">([\s\S]*?)<\/S>/g)]
    .map(match=>decodeXmlText(match[1]).trim())
    .filter(Boolean);
  return errors.length?errors.join("\n"):text;
}

export function decodePowerShellJsonBase64(value){
  const lines=String(value||"")
    .split(/\r?\n/)
    .map(line=>line.trim())
    .filter(Boolean);
  const encoded=[...lines].reverse().find(line=>/^[A-Za-z0-9+/]+={0,2}$/.test(line));
  if(!encoded)throw new Error("PowerShell JSON payload was not returned.");
  const json=Buffer.from(encoded,"base64").toString("utf8");
  return JSON.parse(json);
}
