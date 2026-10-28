// What App draws or runs only once the person does something, or a harness asks, loaded in one chunk at idle after the first paint
// (B11): the Cite button of text selected in a reply, the find bar of Ctrl+F, what the sidebar's and the palette's searches find in
// threads, the card of an approval a harness asks for, the right panel's Runtime tab and History's list.
export { default as AssistantSelectionToolbar } from "./components/AssistantSelectionToolbar.jsx";
export { default as ThreadFindBar } from "./components/ThreadFindBar.jsx";
export { default as ApprovalCard } from "./components/ApprovalCard.jsx";
export { default as RuntimeSurface } from "./components/RuntimeSurface.jsx";
export { default as ThreadHistoryPage } from "./components/ThreadHistoryPage.jsx";
export { matchingMessageExcerpt, matchingPullRequestExcerpt, searchThreadMessages, sidebarSearchMatches } from "./thread-message-search.js";
