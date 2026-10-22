import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { prefs } from "./lib/prefs";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/** The theme in the color mode chosen in settings. */
function App() {
  const mode = useSelector(prefs, (p) => p.appearance.mode);
  return (
    <Theme theme={neutralTheme} mode={mode}>
      <RouterProvider router={router} />
    </Theme>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
