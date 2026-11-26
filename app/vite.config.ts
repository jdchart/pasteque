import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/* The site must also open from file:// (a USB stick, no server). Browsers refuse
   ES modules and `crossorigin` requests there, so the production build is one
   classic script (IIFE, lazy chunks inlined), loaded with `defer` at the end of <head>. */
function classicScript(): Plugin {
  return {
    name: 'classic-script',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module" crossorigin src=/g, '<script defer src=')
        .replace(/<script type="module" src=/g, '<script defer src=')
        .replace(/ crossorigin(?=[ >])/g, '')
        .replace(/<link rel="modulepreload"[^>]*>/g, '');
    },
  };
}

// base './' so the build works under https://jdchart.github.io/pasteque/ and from any folder.
export default defineConfig({
  base: './',
  plugins: [react(), classicScript()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
  },
});
