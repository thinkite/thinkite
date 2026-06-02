// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://sidecode.app",
  integrations: [
    mdx(),
    sitemap({
      // /pair/ is a deep-link landing fallback — keep it out of the sitemap
      filter: (page) => !page.endsWith("/pair/"),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
