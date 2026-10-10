import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./styles.css";
import "./t3-workspace.css";
import "./guardian-review.css";
// The design system loads after the legacy sheets so its tokens and area styles win the cascade.
import "./theme.css";
import "./styles/shell.css";
import "./styles/settings.css";
import "./styles/pages.css";
import "./styles/inspector.css";
import "./styles/overlays.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
