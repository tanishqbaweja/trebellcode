// The controls Tab and Shift+Tab stop on, in the page's order (the app sets no tabindex above 0).
const CONTROLS="a[href],area[href],button,input,select,textarea,summary,iframe,[contenteditable],[tabindex]";

// Tab or Shift+Tab (back) pressed on a control that stands for the text selected in a reply (Cite, or the Reload of a Cite that
// could not load) goes on from that text, as if the control stood where it is: to the first control after the selection, or with
// Shift+Tab to the last one before it, passing by one inside the selection or around it, and one that cannot take the keyboard.
// The control's own place in the page is after the conversation's last message, and it is no stop in Tab's order (tabIndex -1):
// from an earlier reply Shift+Tab went down to the last message's Edit from here, the view jumping to the end and the control going
// with the scroll, and Tab went on below the conversation, past every message after the reply. True once the keyboard is on one.
export function focusBesideSelection(from,back=false){
  const selection=window.getSelection(),range=selection?.rangeCount?selection.getRangeAt(0):null;if(!range)return false;
  const controls=document.querySelectorAll(CONTROLS),place=document.createRange();
  for(let index=back?controls.length-1:0;index>=0&&index<controls.length;index+=back?-1:1){
    const node=controls[index];if(node===from)continue;
    place.selectNode(node);
    if(back?range.compareBoundaryPoints(Range.END_TO_START,place)<0:range.compareBoundaryPoints(Range.START_TO_END,place)>0)continue;
    if(node.tabIndex<0||!node.getClientRects().length)continue;
    node.focus();if(document.activeElement===node)return true;
  }
  return false;
}
