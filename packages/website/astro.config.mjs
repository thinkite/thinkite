// @ts-check

import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://thinkite.dev",
  integrations: [
    sitemap({
      // /pair/ is a deep-link landing fallback — keep it out of the sitemap
      filter: (page) => !page.endsWith("/pair/"),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
