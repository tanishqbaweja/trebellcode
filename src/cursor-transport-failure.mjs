// Port of T3's CursorTransportFailure. When Cursor loses its connection to its backend it
// streams the diagnostic ("Error: ConnectError: [unavailable] ...") as the assistant reply and
// ends the turn normally. A reply made only of such a diagnostic (plus its stack lines) is a
// failed turn, not an answer; a reply that merely quotes one is left alone.

const MAX_LINE_LENGTH=4096;
// Cursor also uses RetriableError for agent-loop failures; preserve those diagnostics.
const TRANSPORT_ERROR=/^Error: (?:RetriableError: (?!\[internal\]).+|ConnectError: \[(?:unavailable|aborted|deadline_exceeded)\].*)$/;
const SERVER_ERROR="Something went wrong communicating with the server. Please try again.";

function consumeLine(state,line){
  if(state.disqualified)return;
  const text=line.trimEnd();
  if(TRANSPORT_ERROR.test(text)||text===SERVER_ERROR)state.failure=text;
  else if(text.trim()!==""&&!(state.failure&&/^\s+at\s/.test(text))){
    // An explanation or code sample can quote the same diagnostic. Only classify an
    // assistant reply consisting entirely of a transport dump.
    state.disqualified=true;state.failure=undefined;
  }
}

export class CursorTransportFailure{
  #state={disqualified:false,failure:undefined};
  #line="";
  push(text){
    for(const [index,part] of String(text??"").split("\n").entries()){
      if(this.#state.disqualified)return;
      if(index>0){consumeLine(this.#state,this.#line);this.#line=""}
      if(this.#line.length+part.length>MAX_LINE_LENGTH){this.#state.disqualified=true;this.#state.failure=undefined;this.#line="";return}
      this.#line+=part;
    }
  }
  get failure(){
    const state={...this.#state};consumeLine(state,this.#line);
    return state.failure;
  }
}
