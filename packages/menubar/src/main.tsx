import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Follow the macOS appearance. Tailwind's dark variant is class-based
// (@custom-variant dark → a `.dark` ancestor), so mirror the OS
// prefers-color-scheme onto <html>. Electron's nativeTheme defaults to
// "system", so this query tracks the OS and its `change` fires on switch.
// The Pair window is shown only after ready-to-show (electron/main), by
// which point this module has run — no light/dark flash.
const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
  document.documentElement.classList.toggle("dark", themeQuery.matches);
applyTheme();
themeQuery.addEventListener("change", applyTheme);

const queryClient = new QueryClient();

const root = document.getElementById("root");
if (!root) throw new Error("no #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
