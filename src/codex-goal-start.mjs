// A Codex goal's first turn hands Codex the objective behind a short instruction to begin. Sent bare, an objective such as
// "Ship the release notes" reads like a remark, and the model answered by repeating it. The instruction is for Codex alone: the
// person's message, its checkpoint, the thread's title and the goal itself keep the objective as typed. Codex keeps what it was
// sent, so its own record of the message (a thread's history, and its preview, which is that first message) has the instruction
// in front, and codexMessageAsTyped takes it off again wherever Trebell shows that record.

// The instruction sent now.
export const CODEX_GOAL_LEAD_IN="Begin work on the goal: ";

// The text of a goal's first turn, as Codex gets it.
export function codexGoalFirstMessage(objective){
  return CODEX_GOAL_LEAD_IN+objective;
}

// Earlier releases put another instruction in front of the objective, and the threads they began still hold it. Trebell does not
// keep those words. It knows what the person typed (a turn's checkpoint label, a thread's goal), so it finds where that starts
// and takes off what Codex got before it, when that has an instruction's shape: the start of the first line, up to a colon and a
// space, at most INSTRUCTION_LIMIT characters. Both instructions Trebell has sent are short sentences under 40 characters; the
// limit leaves room for one and keeps a long line the person typed whole.
const INSTRUCTION_LIMIT=64;
const INSTRUCTION_END=": ";

// The places after which an instruction could end: each colon and space on the first line, within the limit. Only the message's
// first INSTRUCTION_LIMIT characters are looked at, however long it is.
function instructionEnds(message){
  const head=message.slice(0,INSTRUCTION_LIMIT),lineBreak=head.search(/[\r\n]/),reach=lineBreak<0?head.length:lineBreak,ends=[];
  for(let colon=head.indexOf(INSTRUCTION_END);colon>=0&&colon+INSTRUCTION_END.length<=reach;colon=head.indexOf(INSTRUCTION_END,colon+1))
    ends.push(colon+INSTRUCTION_END.length);
  return ends;
}

// typed: a text, a list of texts, or a function giving either; what is not a text, or is only white space, is passed over.
function typedTexts(typed){
  const given=[typeof typed==="function"?typed():typed].flat();
  return given.filter(words=>typeof words==="string"&&/\S/.test(words));
}

// A message from Codex's records, as the person typed it.
// - Trebell's present instruction at its very start comes off, once, when an objective follows it; the instruction alone, or
//   words that only look like it, are the person's own text and stay whole.
// - typed is what Trebell recorded the person typing for this message (see typedTexts). An earlier instruction comes off when
//   the message goes on with one of those texts right after it. typed is read only for a message that could hold one, so a
//   caller can pass a function that reads its records.
// - A message that starts with what the person typed is as they typed it, whatever follows.
export function codexMessageAsTyped(text,typed=null){
  const message=text==null?"":String(text);
  if(message.startsWith(CODEX_GOAL_LEAD_IN)){
    const objective=message.slice(CODEX_GOAL_LEAD_IN.length);
    return objective.trim()?objective:message;
  }
  const ends=instructionEnds(message);
  if(!ends.length)return message;
  const texts=typedTexts(typed);
  if(!texts.length||texts.some(words=>message.startsWith(words)))return message;
  const end=ends.find(at=>texts.some(words=>message.startsWith(words,at)));
  return end===undefined?message:message.slice(end);
}
