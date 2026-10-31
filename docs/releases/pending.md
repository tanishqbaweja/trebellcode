# Notes for the next release

These lines go into the next release's notes file in this folder when it is cut, and this file is then emptied.

## Trebell Native

- **Turns on the Meta Model API no longer fail when Native needs one particular tool called.** At some steps Native asks the
  model to call a given tool, for example when you name a tool to call. Meta's API takes only automatic tool choice and refused
  those requests, which ended the turn with an error. Native now offers Meta just that tool with automatic choice, and the turn
  goes on.

## Interface

- **The Diagnostics runtime log reads as plain text.** The colour and cursor codes the Codex app-server writes for a terminal no
  longer show up in Settings, Diagnostics as stray characters around words such as ERROR, including codes that a WSL or SSH
  environment's connection delivers in two pieces.
- The Projects page's hint for saved actions and the composer's message when no models are available read as plain sentences.

## Install and update

- **Windows names Trebell as the company.** The app's file details named the company behind the framework the app is built on,
  and the installer's named none. Both now name Trebell, and so do the copyright line in those details and the publisher that
  Windows lists for Trebell Code under installed apps.
