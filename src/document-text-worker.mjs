import { readDocumentText } from "./document-text-extract.mjs";

// The process document-text.mjs starts to read one attached document into text: its path and extension in, its text out. A failure
// of the system's (a file gone, a read refused, each with a Node error code) exits 1 and may be tried again; one of the document's own
// (not what its name says, damaged, locked, no text in it) exits 2, and the file is not tried again.
try{process.stdout.write(await readDocumentText(process.argv[2],process.argv[3]))}
catch(error){
  const code=String(error?.code??"");
  if(code.length>1&&code.startsWith("E")&&!code.includes("_")&&code===code.toUpperCase())throw error;
  process.exitCode=2;
}
