import { SessionRefusalError } from "./session-refusal.mjs";

// The files a message carries, as the relay hands them to a harness's session (agent-relay acpPrompt).

// An image part keeps the file it was saved to, out of what harnesses are sent: OpenCode 2 reads an attached image from its file.
export const PROMPT_IMAGE_PATH=Symbol.for("trebell.prompt.image-path");
function withPath(part,key,path){
  if(part&&typeof part==="object"&&path)Object.defineProperty(part,key,{value:String(path),enumerable:false,configurable:true});
  return part;
}
export const withPromptImagePath=(part,path)=>withPath(part,PROMPT_IMAGE_PATH,path);

// The name a person attached a file under: Trebell saves uploads and pastes as <time>-<id>-<name> (gui-server), and the composer
// shows them without that prefix (App.jsx attachmentDisplayName).
export function attachmentName(path){
  const name=String(path||"").split(/[\\/]/).pop()||"attachment";
  return name.replace(/^\d{10,}-[0-9a-f]{8}-(?=.)/i,"");
}

// An attached file Trebell cannot read, said by its name with what to do instead of Node's bare error (T3 names "an attachment could
// not be read" as the reason a turn could not start). The harness has nothing yet, so the relay ends the turn with it and asks the
// harness nothing.
export function unreadableAttachment(kind,path,error){
  const code=typeof error?.code==="string"&&error.code?` (${error.code})`:"";
  return new SessionRefusalError(`The attached ${kind} "${attachmentName(path)}" could not be read${code}. Attach it again.`);
}
