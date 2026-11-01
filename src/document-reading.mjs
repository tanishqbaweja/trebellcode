// What the attached-document reader shares between its modules and with document-text.mjs: the kinds of file it reads, the bounds
// it keeps to, and the two ways a reading ends early. The document comes from anyone, so every bound holds whatever the file says.
const MiB=1024*1024;

export const BOUNDS=Object.freeze({
  // The composer takes attachments other than images of up to 50 MB (gui-server.mjs). A package's media are never unpacked, so a
  // package or an RTF file is opened up to that size: the reader takes any document the composer takes.
  documentFile:50*MiB,
  // A notebook is parsed whole inside the reader's 192 MB heap, where its objects take several times its size on disk.
  notebookFile:20*MiB,
  // One package part is decoded to a single string, up to twice its bytes as UTF-16: under a quarter of the heap.
  partBytes:24*MiB,
  // All the parts a package's reading unpacks. The XML reader goes through about 75 MB a second, so this is about a second of the
  // reader's 15 s, with room for a machine several times slower.
  packageBytes:64*MiB,
  // An e-book with an image on every page has a few thousand entries; the directory keeps one small record for each.
  archiveEntries:20_000,
  // Deeper than real documents nest elements or RTF groups (tables in tables run a few dozen deep), and small enough to keep the
  // open-element and group stacks small.
  nesting:256,
  // About a 1,000-page book at 2,000 characters a page. As UTF-8 that is at most 8 MB on the reader's pipe to the server.
  textCharacters:2_000_000,
});

// Each kind of document by its extension: the reading that turns it into text and the largest file of it that is opened.
const KINDS=new Map([
  [".docx",{reading:"word",largestFile:BOUNDS.documentFile}],
  [".odt",{reading:"odf-text",largestFile:BOUNDS.documentFile}],
  [".rtf",{reading:"rtf",largestFile:BOUNDS.documentFile}],
  [".epub",{reading:"epub",largestFile:BOUNDS.documentFile}],
  [".xlsx",{reading:"excel",largestFile:BOUNDS.documentFile}],
  [".ods",{reading:"odf-sheets",largestFile:BOUNDS.documentFile}],
  [".pptx",{reading:"powerpoint",largestFile:BOUNDS.documentFile}],
  [".odp",{reading:"odf-slides",largestFile:BOUNDS.documentFile}],
  [".ipynb",{reading:"notebook",largestFile:BOUNDS.notebookFile}],
]);

// The kind of document a file extension (".docx", any case) names, or null for a file Trebell does not read into text.
export function documentKind(extension){
  return KINDS.get(String(extension??"").toLowerCase())??null;
}

// The document is not what its name says, is damaged or locked, or holds no text: the reader refuses it and it is not tried again.
export class DocumentRefused extends Error{}
// A bound was reached: the text read so far is kept and a note says the document goes on.
export class TextLimitReached extends Error{}
export function refuseDocument(reason){throw new DocumentRefused(reason)}
export function reachLimit(){throw new TextLimitReached("The document is past the reader's bounds")}
