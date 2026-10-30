import { SessionRefusalError } from "./session-refusal.mjs";

// The files a message carries, as the relay hands them to a harness's session (agent-relay acpPrompt).

// An image part keeps the file it was saved to and an audio file's path line the file it names, both out of what harnesses are sent:
// OpenCode 2 reads an attached image from its file, and Antigravity's session sends audio as content when Antigravity takes it.
export const PROMPT_IMAGE_PATH=Symbol.for("trebell.prompt.image-path");
export const PROMPT_AUDIO_PATH=Symbol.for("trebell.prompt.audio-path");
// A document's link keeps the file its text was extracted to (document-text.mjs), which each harness's prompt names after the
// document's path: "(text extracted to: <file>)".
export const PROMPT_TEXT_PATH=Symbol.for("trebell.prompt.text-path");
function withPath(part,key,path){
  if(part&&typeof part==="object"&&path)Object.defineProperty(part,key,{value:String(path),enumerable:false,configurable:true});
  return part;
}
export const withPromptImagePath=(part,path)=>withPath(part,PROMPT_IMAGE_PATH,path);
export const withPromptAudioPath=(part,path)=>withPath(part,PROMPT_AUDIO_PATH,path);
export const withPromptTextPath=(part,path)=>withPath(part,PROMPT_TEXT_PATH,path);
export const textExtractedTo=part=>part?.[PROMPT_TEXT_PATH]?` (text extracted to: ${part[PROMPT_TEXT_PATH]})`:"";

// The name a person attached a file under: Trebell saves uploads and pastes as <time>-<id>-<name> (gui-server), and the composer
// shows them without that prefix (App.jsx attachmentDisplayName).
export function attachmentName(path){
  const name=String(path||"").split(/[\\/]/).pop()||"attachment";
  return name.replace(/^\d{10,}-[0-9a-f]{8}-(?=.)/i,"");
}

// An attached file Trebell cannot read, said by its name with what to do instead of Node's bare error. The harness has
// nothing yet, so the relay ends the turn with it and asks the
// harness nothing.
export function unreadableAttachment(kind,path,error){
  const code=typeof error?.code==="string"&&error.code?` (${error.code})`:"";
  return new SessionRefusalError(`The attached ${kind} "${attachmentName(path)}" could not be read${code}. Attach it again.`);
}
// An image of a thread in a remote environment: the composer keeps the copy it made on the remote host, which this machine cannot read
// to send as an image. The file is not gone, so attaching it again would not help.
export function remoteEnvironmentImage(path){
  return new SessionRefusalError(`The attached image "${attachmentName(path)}" is in this thread's remote environment, and Trebell Code sends images to the agent only from this machine. Remove the image to send the message.`);
}
