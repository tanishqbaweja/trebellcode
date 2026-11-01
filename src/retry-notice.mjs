// The retry row of a harness that sends a failed model request again by itself (Muse Code's turn/retryScheduled, OpenCode's
// session.status retry): what failed comes first, then who sends what again, in how many seconds, and which try that is. The
// conversation puts "Retrying: " before it while the turn waits.
//
//   429 Too Many Requests. Muse Code sends the request again in 2 s, as try 2 of 3.

// A reason as one line, without the full stops it ends with, blanks between them included (the sentence adds its own).
export function retryReason(text){
  const line=String(text??"").split(/\s+/).filter(Boolean).join(" ");
  let end=line.length;
  while(end>0&&". ".includes(line[end-1]))end--;
  return line.slice(0,end);
}

// reason: what failed; sender: who sends it again; what: the request it sends; seconds: the wait, a whole number of 1 at
// least; which: the try it will be, in words ("try 2 of 3", "retry 1").
export function retryNotice({reason,sender,what="the request",seconds,which}){
  return `${retryReason(reason)}. ${sender} sends ${what} again in ${Math.max(1,Math.round(Number(seconds)||0))} s, as ${which}.`;
}
