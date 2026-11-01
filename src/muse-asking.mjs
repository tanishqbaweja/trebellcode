// What Muse Code asks the person, in Trebell's words and back in Muse's: the choices of an approval as Trebell's approval decisions
// and the card's buttons, and Muse's questions as the question dialog asks them, with the answer Muse takes.

const asText=value=>typeof value==="string"?value:value==null?"":String(value);
const hasId=entry=>Boolean(entry)&&typeof entry.id==="string"&&entry.id!=="";

// Approvals. Every approval choice Muse offers names a decision word and a scope, and its id is the server's to mint and
// Trebell's only to send back (MSP's ApprovalChoice in @muse-code/sdk's msp.d.ts). Trebell answers in its own terms instead: a
// verdict and how long it lasts.

// How long an answer lasts, shortest first: the request it answers, the rest of the session, or saved beyond the session.
const FOR_REQUEST=0,FOR_SESSION=1,SAVED=2;
// Trebell's answers, by verdict, at each of those lengths. A stop only ever answers the request it stops.
const TREBELL_ANSWERS={
  allow:["accept","acceptForSession","acceptAlways"],
  refuse:["decline","declineForSession","declineAlways"],
  stop:["cancel"],
};
const ANY_ANSWER=new Set(Object.values(TREBELL_ANSWERS).flat());

// Muse's decision words as Muse Code 1.4.13 describes them in its protocol schema (ApprovalDecision): the verdict, and what the
// word itself leaves behind, from least to most: nothing (approved "may run this once; nothing is remembered", denied "no rule is
// saved", abort "the decision behind the reject choice"), a grant for the session (approvedForSession), or a policy rule, which
// lasts as the choice's scope says (the two ...PolicyAmendment words). timedOut ("no decision arrived in time") is an outcome
// nobody picks, so it has no row, and nor does a word Muse adds later: Trebell cannot say what choosing it would do.
const LEAVES_NOTHING=0,LEAVES_SESSION_GRANT=1,LEAVES_RULE=2;
const MUSE_WORDS=new Map([
  ["approved",{verdict:"allow",leaves:LEAVES_NOTHING}],
  ["approvedForSession",{verdict:"allow",leaves:LEAVES_SESSION_GRANT}],
  ["approvedPolicyAmendment",{verdict:"allow",leaves:LEAVES_RULE}],
  ["denied",{verdict:"refuse",leaves:LEAVES_NOTHING}],
  ["deniedPolicyAmendment",{verdict:"refuse",leaves:LEAVES_RULE}],
  ["abort",{verdict:"stop",leaves:LEAVES_NOTHING}],
]);
// How long each scope says a choice lasts (ApprovalChoiceScope): "this request only", "the rest of the session", or a rule "saved
// in the local policy store, which lasts beyond this session". A scope Muse adds later has no length Trebell can name.
const SCOPE_LENGTH=new Map([["once",FOR_REQUEST],["session",FOR_SESSION],["localPersistent",SAVED]]);

// One of Muse's choices read as Trebell's answer, with what its word leaves behind, or null when Trebell cannot say what picking it
// would do. A choice lasts as long as the longer of its word and its scope say, so Trebell's own answers for a single request (its
// policy's accept or decline, a stop) never pick one that may outlast that request. A rule lasts as its scope says, and a rule for
// this request alone is no rule at all, so it is not read.
function readMuseChoice(choice){
  const word=MUSE_WORDS.get(asText(choice?.decision)),scoped=SCOPE_LENGTH.get(asText(choice?.scope));
  if(!word||scoped===undefined)return null;
  if(word.leaves===LEAVES_RULE&&scoped===FOR_REQUEST)return null;
  const length=Math.max(scoped,word.leaves===LEAVES_SESSION_GRANT?FOR_SESSION:FOR_REQUEST);
  const answer=TREBELL_ANSWERS[word.verdict][length];
  if(answer===undefined)return null;
  return {answer,leaves:word.leaves};
}
export function museChoiceDecision(choice){
  const read=readMuseChoice(choice);
  return read?read.answer:null;
}

// Muse's choice for each answer Trebell can give, listed in the order the answers first come among Muse's choices. Of several
// choices for one answer the one that leaves least behind is kept (a session grant covers only requests that match this one, a
// rule a whole command prefix), the first of equals. When nothing refuses this request alone, Muse's stop is also the Reject,
// listed last, as the SDK's own reject is the denied choice or else the abort one; a choice that keeps a rule never is.
export function museDecisionChoices(choices=[]){
  const offered=new Map(),leaves=new Map();
  for(const choice of Array.isArray(choices)?choices:[]){
    if(typeof choice?.choiceId!=="string"||choice.choiceId==="")continue;
    const read=readMuseChoice(choice);
    if(!read||(offered.has(read.answer)&&leaves.get(read.answer)<=read.leaves))continue;
    // A narrower choice takes the place of a wider one for the same answer, and the answer keeps its place in the list.
    offered.set(read.answer,choice);
    leaves.set(read.answer,read.leaves);
  }
  if(offered.has("cancel")&&!offered.has("decline"))offered.set("decline",offered.get("cancel"));
  return offered;
}

// What Trebell sends for the answer it was given (offered: museDecisionChoices of the stage asked). A stop goes as Muse's abort
// when one is offered and as the Reject when none is; an answer outside Trebell's set goes as the Reject.
export function museDecisionToSend(decision,offered){
  if(!ANY_ANSWER.has(decision))return "decline";
  return decision==="cancel"&&!offered.has("cancel")?"decline":decision;
}

// The approval card's buttons: one per answer, in the order above, each in Muse's own words as given (Allow once, Always allow in
// this workspace: touch ..., Reject). The stop that also serves as the Reject shows once, as the Reject; a choice Muse sent with
// no words shows its answer's name.
export function museCardButtons(choices=[]){
  const offered=museDecisionChoices(choices),buttons=[];
  offered.forEach((choice,answer)=>{
    const alsoTheReject=answer==="cancel"&&offered.get("decline")?.choiceId===choice.choiceId;
    if(!alsoTheReject)buttons.push({decision:answer,label:asText(choice.label).trim()||answer});
  });
  return buttons;
}

// Muse's questions as the question dialog asks them: the header, the question and its options, several choices for a multiple
// selection, and the person's own words for every one, as Muse takes a free-text answer to any question. notes: what an answer to
// a question lacked, by question id, said beside it when Trebell asks again.
export function museDialogQuestions(questions=[],notes={}){
  const dialog=[];
  for(const question of Array.isArray(questions)?questions:[]){
    if(!hasId(question))continue;
    const header=asText(question.header).trim();
    const asked=asText(question.question).trim()||header||"Muse Code asks a question.";
    const note=asText(notes?.[question.id]).trim();
    const options=[];
    for(const option of Array.isArray(question.options)?question.options:[]){
      if(typeof option?.label==="string"&&option.label!=="")options.push({label:option.label,description:asText(option.description)});
    }
    dialog.push({id:question.id,header:header||"Question",question:note?`${asked} (${note})`:asked,multiSelect:question.selection?.mode==="multiple",allowCustomAnswer:true,options});
  }
  return dialog;
}

// Muse takes at most this many characters of the person's own words in an answer (userInput/answer's freeText and note).
export const MUSE_OWN_WORDS_LIMIT=500;

// What the person gave for one question: the options chosen, by their exact labels in the person's order, and their own words.
function readAnswer(question,given){
  const values=[];
  for(const value of given==null?[]:Array.isArray(given)?given:[given]){
    const word=asText(value).trim();
    if(word&&!values.includes(word))values.push(word);
  }
  const labels=new Set();
  for(const option of Array.isArray(question.options)?question.options:[])if(typeof option?.label==="string")labels.add(option.label);
  return {
    chosen:values.filter(value=>labels.has(value)),
    ownWords:values.filter(value=>!labels.has(value)).join("\n"),
    multiple:question.selection?.mode==="multiple",
  };
}
// Why Muse would refuse an answer, or "" when it would take it.
function refusal(question,{chosen,ownWords,multiple}){
  if(!chosen.length&&!ownWords)return "Answer this question to go on.";
  if(ownWords.length>MUSE_OWN_WORDS_LIMIT)return `Muse Code takes at most ${MUSE_OWN_WORDS_LIMIT} characters of your own words; the last answer had ${ownWords.length}.`;
  if(!multiple)return chosen.length>1?"Choose one option.":"";
  const {minSelections,maxSelections}=question.selection;
  const fewest=Number.isInteger(minSelections)?minSelections:1,most=Number.isInteger(maxSelections)?maxSelections:Infinity;
  if(chosen.length&&chosen.length<fewest)return `Choose at least ${fewest} options.`;
  if(chosen.length>most)return `Choose at most ${most} ${most===1?"option":"options"}.`;
  return "";
}
// The person's answers as userInput/answer takes them: the options chosen, one for a single-selection question and within its
// bounds for a multiple one, and their own words as the free-text answer, or as a note beside the choices. An answer Muse would
// refuse is not sent: the first refusal says why, by its question.
export function museAnswerPayload(questions=[],answers={}){
  const payload=[];
  for(const question of Array.isArray(questions)?questions:[]){
    if(!hasId(question))continue;
    const answer=readAnswer(question,answers?.[question.id]);
    const why=refusal(question,answer);
    if(why)return {error:{questionId:question.id,message:why}};
    const entry={questionId:question.id};
    if(answer.chosen.length){
      if(answer.multiple)entry.selectedLabels=answer.chosen;
      else entry.selectedLabel=answer.chosen[0];
    }
    if(answer.ownWords)entry[answer.chosen.length?"note":"freeText"]=answer.ownWords;
    payload.push(entry);
  }
  return {answers:payload};
}
