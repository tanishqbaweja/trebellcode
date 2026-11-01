// The style note in a Git text prompt: what Trebell tells the writer (Trebell Native's provider or the active harness) about how a
// commit subject, or a pull request title and description, should read, from the project's Git text style in Settings.
//   repository    the repository's own habits, as the prompt shows them (its recent commit subjects and guidance files, which the
//                 caller sends for this style only, and its pull request template when one goes along);
//   conventional  commit subjects as Conventional Commits 1.0.0 headers (conventionalcommits.org); pull request titles stay free;
//   custom        the project's own instructions, passed on exactly as saved.
// The prompt puts the note right after its first line. A note for a commit never names pull requests: a pull request prompt is the
// one that does, and the tests' stand-in writers tell the two prompts apart by it.

const COMMIT_SUBJECT=Object.freeze({
  repository:"Follow the habits this repository's commit history and guidance files show in this message, such as form, letter case, tense, prefixes and length. If it shows none, write a short, plain subject saying what the change does.",
  conventional:"Write the subject as a Conventional Commits header: a type, a scope in parentheses if one applies, a colon and a space, then a short description. Use the most specific type that is true of the whole change (feat, fix, docs, refactor, perf, test, build, ci, style or chore) rather than a broader one, and leave the scope out unless the whole diff clearly belongs to one named part of the code.",
  target:"this commit subject",
});
const PULL_REQUEST_TEXT=Object.freeze({
  repository:"Follow the conventions this repository shows in this message (its recent commit subjects, guidance files and pull request template, when they are included), in the title as well as the body. If it shows none, give a short, plain title and a plain description of the change.",
  conventional:"Commits in this project follow Conventional Commits, but the pull request title does not have to: make it short, specific and in plain words, with a type prefix only where it reads naturally.",
  target:"this pull request title and description",
});
// The custom style: the project's instructions follow this lead on the next line, or, with nothing saved (the Settings box left
// empty), a plain request instead.
const OWN_RULES_LEAD="This project has its own instructions for Git text. Apply them, exactly as written below, to";
const NO_OWN_RULES="No custom instructions are saved for this project: describe what the change does in plain, specific words.";

// kind "review" is pull request text; anything else is a commit subject. A missing or unknown style reads as repository, as the
// settings store reads it.
export function gitTextStyleNote({style,kind,customInstructions}={}){
  const words=kind==="review"?PULL_REQUEST_TEXT:COMMIT_SUBJECT;
  if(style==="custom"){
    const saved=typeof customInstructions==="string"?customInstructions:"";
    return saved.trim()?`${OWN_RULES_LEAD} ${words.target}:\n${saved}`:NO_OWN_RULES;
  }
  return style==="conventional"?words.conventional:words.repository;
}
