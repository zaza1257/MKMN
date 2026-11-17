import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  resolve: { alias: [{ find: /^vm$/, replacement: path.resolve(__dirname, "src/renderer/vm-shim.ts") }] },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    // The chunks are read from the installed app's own folder, never downloaded: the 500 kB web default does not
    // apply. The entry (the app itself, about 1.4 MB) and Mermaid's lazily loaded diagram kinds stay under this.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Split the heavy vendors out of the entry chunk so the browser caches
        // them across app updates and the startup download stays parallel.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/[\\/]node_modules[\\/]@measured[\\/]/.test(id)) return "puck";
          if (/[\\/]node_modules[\\/]pdfjs-dist[\\/]/.test(id)) return "pdfjs";
          if (/[\\/]node_modules[\\/]katex[\\/]/.test(id)) return "katex";
          return undefined;
        }
      }
    }
  }
});
