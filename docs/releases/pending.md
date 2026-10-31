# Notes for the next release

These lines go into the next release's notes file in this folder when it is cut, and this file is then emptied.

## Trebell Native

- **Turns on the Meta Model API no longer fail when Native steers a tool call.** Native sometimes asks the model to call a tool, or
  to answer without one, for example to check an edit it just made. Meta's API takes only automatic tool choice and refused those
  requests, which ended the turn with an error. Native now asks Meta for automatic choice, or sends the request without its tools,
  and the turn goes on.

## Interface

- **The Diagnostics runtime log reads as plain text.** The colour and cursor codes the Codex app-server writes for a terminal no
  longer show up in Settings, Diagnostics as stray characters around words such as ERROR.
- The Projects page's hint for saved actions and the composer's message when no models are available read as plain sentences.

## Install and update

- **Windows names Trebell as the company.** The installer's and the app's file details now say Trebell instead of the default
  company name of the framework the app is built on.
