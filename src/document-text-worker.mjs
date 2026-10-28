import { extractDocumentText } from "./document-text-extract.mjs";

// The process document-text.mjs starts to extract one attached document's text: its path and extension in, its text out. A failure
// of the system's (a file gone, a read refused) exits 1 and may be tried again; one of the document's own (corrupt, encrypted, not
// what its name says, no text in it) exits 2, and the file is not tried again.
try{process.stdout.write(await extractDocumentText(process.argv[2],process.argv[3]))}
catch(error){
  if(/^E[A-Z0-9]+$/.test(String(error?.code||"")))throw error;
  process.exitCode=2;
}
