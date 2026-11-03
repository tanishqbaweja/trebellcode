// The composer's dictation: what a press of the mic does with the browser's speech recognition. App's composer loads it with
// idle-parts.js after the first paint (B11), as nothing on the first screen needs it.
import { sentenceText } from "./composer-state.js";

// Why dictation stopped, by the browser's speech recognition error; any other error gets the last line. The mic shows on from the
// press. A recognition the browser has not started listening for within DICTATION_WAIT_MS is let go, and one that ends without
// starting, with DICTATION_SILENT: where the browser could not listen (headless Chromium has no speech service, so its recognition
// never starts, errs or ends), two presses changed nothing, with no word (tour L10-22).
const DICTATION_ERRORS={
  "not-allowed":"The microphone is blocked. Allow microphone access for Trebell Code to dictate.",
  "service-not-allowed":"The microphone is blocked. Allow microphone access for Trebell Code to dictate.",
  "audio-capture":"No microphone was found to dictate with.",
  "network":"Dictation could not reach the browser's speech service.",
  "no-speech":"No speech was heard. Press the mic and speak.",
  "":"Dictation stopped: the browser could not listen.",
};
const DICTATION_SILENT="Dictation did not start: the browser is not listening. Allow the microphone if asked, then try again.",DICTATION_WAIT_MS=8000;

// A press: deps are the composer's recognition (recognitionRef), its note (setDictationAlert), the mic's state (setListening) and its
// draft (setPrompt).
export function dictate({recognitionRef,setDictationAlert,setListening,setPrompt}){
  // A press stops the recognition on its way, also one the browser has not started listening for yet: its own end lets the mic go.
  const current=recognitionRef.current;
  if(current){current.end();current.stop();return}
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  const recognition=new Recognition(),say=text=>setDictationAlert({kind:"dictation",text});recognitionRef.current=recognition;setDictationAlert(null);setListening(true);let started=false;
  // This recognition lets the mic go, unless a press or a newer one has it: false then.
  const end=recognition.end=()=>{clearTimeout(recognition.wait);if(recognitionRef.current!==recognition)return false;recognitionRef.current=null;setListening(false);return true};
  recognition.wait=setTimeout(()=>{if(end()){try{recognition.abort()}catch{}say(DICTATION_SILENT)}},DICTATION_WAIT_MS);
  // One phrase, final results only: continuous and interimResults are off by the Web Speech API's own defaults.
  recognition.lang=navigator.language||"en-US";
  recognition.onstart=()=>{started=true;clearTimeout(recognition.wait)};
  recognition.onend=()=>{if(end()&&!started)say(DICTATION_SILENT)};
  recognition.onerror=event=>{const code=event?.error;if(end()&&code!=="aborted")say(DICTATION_ERRORS[code]||DICTATION_ERRORS[""])};
  recognition.onresult=(event)=>{
    const text=[...event.results].map(result=>result[0]?.transcript||"").join(" ").trim();
    if(text)setPrompt(prev=>(prev&& !/\s$/.test(prev)?prev+" ":"")+text);
  };
  try{recognition.start()}catch(error){end();say("Dictation could not start: "+sentenceText(error?.message||String(error)))}
}
