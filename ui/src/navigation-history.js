// The pages the app has shown, for Navigate back/forward (Ctrl+[ / Ctrl+]) and, in a browser tab, for the browser's own Back and
// Forward: there every entry here is also an entry in the tab's history (same URL, this entry's id in its state), so both move
// through one history. A location is the page (section), the thread open in it and the right panel's tab while that panel is open.

export const NAVIGATION_HISTORY_LIMIT=80;
export const NAVIGATION_STORE_KEY="trebell-navigation-v1";

export function navigationKey(location){
  return [location?.section,location?.threadId||"",location?.rightPanelOpen?location.rightPanelTab||"files":""].join("|");
}

function entryOf(location,id){
  return {id:String(id),section:String(location?.section||"chat"),threadId:location?.threadId?String(location.threadId):null,rightPanelOpen:Boolean(location?.rightPanelOpen),rightPanelTab:String(location?.rightPanelTab||"files")};
}
function validEntry(value){return Boolean(value&&typeof value==="object"&&typeof value.id==="string"&&value.id&&typeof value.section==="string"&&value.section)}

// documentId keeps the ids of this page load apart from those of an earlier load of the same tab (kept across a reload).
export function createNavigationHistory(documentId=Math.random().toString(36).slice(2,10)){
  return {entries:[],index:-1,documentId:String(documentId),seq:0,applying:null,landed:false,pending:null};
}
function nextId(nav){nav.seq+=1;return nav.documentId+"-"+nav.seq}

// The first location this page load shows. After a reload the tab's history entry is one the stored history knows: that entry now
// shows this location and the entries around it stay, so Back and Forward still reach the pages before and after it. Anywhere else
// (a first open, a history kept nowhere) the history starts here.
export function startNavigationHistory(nav,location,{browserEntryId=null,stored=null}={}){
  const entries=(Array.isArray(stored?.entries)?stored.entries.filter(validEntry).map(entry=>entryOf(entry,entry.id)):[]).slice(-NAVIGATION_HISTORY_LIMIT);
  const at=browserEntryId?entries.findIndex(entry=>entry.id===String(browserEntryId)):-1;
  if(at>=0){nav.entries=entries;nav.index=at;nav.entries[at]=entryOf(location,browserEntryId)}
  else{nav.entries=[entryOf(location,nextId(nav))];nav.index=0}
  nav.pending=null;
  return nav.entries[nav.index];
}

// A location the person has moved to. "push" when it is a new entry (the entries ahead of the current one are dropped, as a browser
// drops them), "none" when the current entry already shows it.
export function recordLocation(nav,location){
  const current=nav.entries[nav.index];
  if(current&&navigationKey(current)===navigationKey(location))return {action:"none",entry:current};
  const entry=entryOf(location,nextId(nav));
  nav.entries=nav.entries.slice(0,nav.index+1);
  nav.entries.push(entry);
  if(nav.entries.length>NAVIGATION_HISTORY_LIMIT)nav.entries.shift();
  nav.index=nav.entries.length-1;nav.pending=null;
  return {action:"push",entry};
}

// After a Back or Forward has been shown: its entry now names what could be shown (a thread gone since shows the chat without it),
// so the next Back or Forward does not try for it again. "replace" when it changed.
export function settleLocation(nav,location){
  const current=nav.entries[nav.index];
  if(!current||navigationKey(current)===navigationKey(location))return {action:"none",entry:current||null};
  nav.entries[nav.index]=entryOf(location,current.id);
  return {action:"replace",entry:nav.entries[nav.index]};
}

// Where the app's own Back (-1) or Forward (+1) goes: an index in this history, or -1 at its ends, so the shortcut never leaves the
// app the way the browser's Back does from the first page. A step on its way (the browser has not shown it yet) counts.
export function stepTarget(nav,delta){
  const from=nav.pending??nav.index,next=from+delta;
  return next>=0&&next<nav.entries.length?next:-1;
}

// The browser moved to the entry with this state (its Back or Forward, or the app's history.go): its index here, or -1 when the
// state is not the app's. An entry of the app's this history does not hold (the tab's storage was unavailable across a reload)
// becomes this history, so it can still be shown.
export function browserEntryIndex(nav,state){
  const browserEntry=state?.trebellNav;
  if(!validEntry(browserEntry))return -1;
  const index=nav.entries.findIndex(entry=>entry.id===browserEntry.id);
  if(index>=0)return index;
  nav.entries=[entryOf(browserEntry,browserEntry.id)];nav.index=0;nav.pending=null;
  return 0;
}

// The tab history state for an entry, keeping anything else a state already holds.
export function browserState(entry,previous){
  const base=previous&&typeof previous==="object"&&!Array.isArray(previous)?previous:{};
  return {...base,trebellNav:{...entry}};
}
export function storedNavigation(nav){return {entries:nav.entries,index:nav.index}}
