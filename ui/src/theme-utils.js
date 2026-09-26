function expandHex(value){
  const text=String(value||"").trim();
  if(/^#[0-9a-f]{3}$/i.test(text))return "#"+text.slice(1).split("").map(ch=>ch+ch).join("").toLowerCase();
  if(/^#[0-9a-f]{6}$/i.test(text))return text.toLowerCase();
  return null;
}

function rgb(hex){const value=expandHex(hex);if(!value)return null;return [1,3,5].map(index=>parseInt(value.slice(index,index+2),16))}
function hex([r,g,b]){return "#"+[r,g,b].map(value=>Math.max(0,Math.min(255,Math.round(value))).toString(16).padStart(2,"0")).join("")}
export function mixHex(a,b,weight=.5){const left=rgb(a),right=rgb(b);if(!left||!right)return expandHex(a)||expandHex(b)||"#000000";const t=Math.max(0,Math.min(1,Number(weight)||0));return hex(left.map((value,index)=>value*(1-t)+right[index]*t))}
export function luminance(value){const color=rgb(value);if(!color)return 0;const linear=color.map(channel=>{const c=channel/255;return c<=.03928?c/12.92:Math.pow((c+.055)/1.055,2.4)});return .2126*linear[0]+.7152*linear[1]+.0722*linear[2]}

function colorFrom(source,...keys){for(const key of keys){const value=expandHex(source?.[key]);if(value)return value}return null}

export function normalizeCustomTheme(input,{id=null}={}){
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Theme JSON must be an object");
  const colors=input.colors&&typeof input.colors==="object"&&!Array.isArray(input.colors)?input.colors:{};
  const canvas=expandHex(input.canvas)||colorFrom(colors,"editor.background","sideBar.background","window.activeBorder");
  if(!canvas)throw new Error("Theme must define canvas or colors.editor.background");
  const accent=expandHex(input.accent)||colorFrom(colors,"focusBorder","button.background","activityBarBadge.background","editorCursor.foreground")||"#9c6cff";
  const inferred=luminance(canvas)>.42?"light":"dark";
  const appearance=["light","dark"].includes(input.appearance)?input.appearance:(input.type==="light"||input.type==="hcLight"?"light":input.type==="dark"||input.type==="hcDark"?"dark":inferred);
  const name=String(input.name||input.label||"Imported theme").trim().slice(0,80)||"Imported theme";
  const safeColors={
    foreground:expandHex(input.colors?.foreground)||colorFrom(colors,"editor.foreground","foreground"),
    error:expandHex(input.colors?.error)||colorFrom(colors,"errorForeground","editorError.foreground"),
    warning:expandHex(input.colors?.warning)||colorFrom(colors,"editorWarning.foreground","notificationsWarningIcon.foreground"),
    success:expandHex(input.colors?.success)||colorFrom(colors,"testing.iconPassed","gitDecoration.addedResourceForeground"),
    terminalSelection:expandHex(input.colors?.terminalSelection)||colorFrom(colors,"terminal.selectionBackground"),
  };
  return {id:String(id||input.id||"custom-theme"),name,appearance,canvas,accent,colors:Object.fromEntries(Object.entries(safeColors).filter(([,value])=>Boolean(value)))};
}

export function themeCssVariables(theme,mode="dark"){
  const normalized=normalizeCustomTheme(theme,{id:theme?.id||"custom-theme"});
  const light=mode==="light";
  let canvas=normalized.canvas;
  if(light&&luminance(canvas)<.45)canvas=mixHex(canvas,"#ffffff",.9);
  if(!light&&luminance(canvas)>.35)canvas=mixHex(canvas,"#000000",.78);
  const foreground=normalized.colors.foreground||(light?"#202631":"#f4f1f8");
  return {
    "--theme-canvas":canvas,
    "--theme-foreground":foreground,
    "--bg":light?mixHex(canvas,"#000000",.035):mixHex(canvas,"#000000",.18),
    "--panel":light?mixHex(canvas,"#ffffff",.68):mixHex(canvas,"#ffffff",.055),
    "--panel2":light?mixHex(canvas,"#000000",.025):mixHex(canvas,"#ffffff",.09),
    "--line":light?mixHex(canvas,"#000000",.14):mixHex(canvas,"#ffffff",.13),
    "--muted":light?mixHex(foreground,canvas,.52):mixHex(foreground,canvas,.48),
    "--muted2":light?mixHex(foreground,canvas,.65):mixHex(foreground,canvas,.64),
    "--purple":normalized.accent,
    "--purple2":light?mixHex(normalized.accent,"#000000",.18):mixHex(normalized.accent,"#ffffff",.12),
    "--green":normalized.colors.success||"#46dc85",
    "--theme-error":normalized.colors.error||(light?"#b42336":"#ef7d8e"),
    "--theme-warning":normalized.colors.warning||(light?"#946200":"#e4b85b"),
    "--theme-terminal-selection":normalized.colors.terminalSelection||mixHex(normalized.accent,canvas,.65),
  };
}
