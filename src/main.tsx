import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <App />,
);
