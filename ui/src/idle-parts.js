// What App draws or runs only once the person does something, loaded in one chunk at idle after the first paint (B11): the Cite
// button of text selected in a reply, the find bar of Ctrl+F, and what the sidebar's and the palette's searches find in threads.
export { default as AssistantSelectionToolbar } from "./components/AssistantSelectionToolbar.jsx";
export { default as ThreadFindBar } from "./components/ThreadFindBar.jsx";
export { matchingMessageExcerpt, matchingPullRequestExcerpt, sidebarSearchMatches } from "./thread-message-search.js";
