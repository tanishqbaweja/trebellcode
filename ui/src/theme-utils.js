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
export function contrastRatio(a,b){const first=luminance(a)+.05,second=luminance(b)+.05;return first>second?first/second:second/first}
// The text color for a fill a person picked (a project tile's): white, or black where white reads under 4.5:1 on it. null when the
// fill is not a hex color.
export function inkOn(fill){return expandHex(fill)?contrastRatio("#ffffff",fill)>=4.5?"#ffffff":"#000000":null}

// The smallest mix of a color toward a target that passes the check (the target itself must pass), so a theme's own color
// is kept wherever it already works and is only moved as far as it has to be.
function nearestMix(color,toward,passes){
  if(passes(color))return color;
  let low=0,high=1;
  for(let step=0;step<16;step++){const mid=(low+high)/2;if(passes(mixHex(color,toward,mid)))high=mid;else low=mid}
  return mixHex(color,toward,high);
}
function readableOn(color,surfaces,minimum,toward){return nearestMix(color,toward,value=>surfaces.every(surface=>contrastRatio(value,surface)>=minimum))}

// Minimum contrast of each text color on the canvas and panel fills (--bg, --panel, --panel2) that most text sits on. The
// secondary and tertiary tiers (11-12px labels, previews, timestamps) keep the 4.5:1 and 3.8:1 the built-in dark palette
// gives them. The accent is also the fill behind white button text, so it is held to the 3:1 that UI parts need instead of
// being pushed light enough to wash that text out.
const TEXT_CONTRAST={foreground:7,muted:4.5,muted2:3.8,accent:3,status:4.5};

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
  // Dark mode needs a dark canvas. A light theme gets one as dark as a dark editor theme's (#272727 from white); a dark theme
  // keeps its own unless it is lighter than #383838, past which its text tiers can no longer all stay readable on it.
  if(!light){const maxLuminance=normalized.appearance==="light"?.02:.04;canvas=nearestMix(canvas,"#000000",value=>luminance(value)<=maxLuminance)}
  const bg=light?mixHex(canvas,"#000000",.035):mixHex(canvas,"#000000",.18);
  const panel=light?mixHex(canvas,"#ffffff",.68):mixHex(canvas,"#ffffff",.055);
  const panel2=light?mixHex(canvas,"#000000",.025):mixHex(canvas,"#ffffff",.09);
  // A theme made for the other mode brings text colors meant for the other kind of canvas (a dark theme's light foreground
  // on the light canvas made from it). Each text color moves toward black in light mode, or white in dark mode, only as far
  // as it takes to read on every fill.
  const toward=light?"#000000":"#ffffff";
  const readable=(color,tier)=>readableOn(color,[bg,panel,panel2],TEXT_CONTRAST[tier],toward);
  const foreground=readable(normalized.colors.foreground||(light?"#202631":"#f4f1f8"),"foreground");
  const accent=readable(normalized.accent,"accent");
  return {
    "--theme-canvas":canvas,
    "--theme-foreground":foreground,
    "--bg":bg,
    "--panel":panel,
    "--panel2":panel2,
    "--line":light?mixHex(canvas,"#000000",.14):mixHex(canvas,"#ffffff",.13),
    "--muted":readable(light?mixHex(foreground,canvas,.52):mixHex(foreground,canvas,.48),"muted"),
    "--muted2":readable(light?mixHex(foreground,canvas,.65):mixHex(foreground,canvas,.64),"muted2"),
    "--purple":accent,
    // The other end of the accent gradients behind white button text: darker than the accent in both modes, like --ac2.
    "--purple2":mixHex(accent,"#000000",.18),
    "--green":readable(normalized.colors.success||"#46dc85","status"),
    "--theme-error":readable(normalized.colors.error||(light?"#b42336":"#ef7d8e"),"status"),
    "--theme-warning":readable(normalized.colors.warning||(light?"#946200":"#e4b85b"),"status"),
    "--theme-terminal-selection":normalized.colors.terminalSelection||mixHex(accent,canvas,.65),
  };
}
