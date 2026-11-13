import { defineConfig } from 'vite';
import { copyFileSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
    cssMinify: true,
    sourcemap: true,
    modulePreload: {
      polyfill: false
    },
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        entryFileNames: 'js/[name]-[hash].js',
        chunkFileNames: 'js/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name.split('.');
          const ext = info[info.length - 1];
          if (/\.(png|jpe?g|gif|svg|webp|ico)$/.test(assetInfo.name)) {
            return `images/[name]-[hash].${ext}`;
          }
          if (/\.css$/.test(assetInfo.name)) {
            return `css/[name]-[hash].${ext}`;
          }
          return `assets/[name]-[hash].${ext}`;
        },
        manualChunks: {
          'ai-chat': ['./js/ai-chat.js', './js/ai-settings.js', './js/ai-privacy.js'],
          'editor': ['./js/editor.js', './js/markdown.js', './js/memo-renderer.js'],
          'keep-import': ['./js/keep-import.js', './js/md-import.js'],
          'vendor': ['./js/api.js', './js/i18n.js', './js/state.js', './js/utils.js']
        }
      }
    }
  },
  server: {
    port: 8080,
    host: true
  },
  css: {
    devSourcemap: true
  },
  plugins: [
    {
      name: 'html-rewrite',
      enforce: 'pre',
      transformIndexHtml(html) {
        // Replace versioned asset paths with direct paths
        return html
          .replace(/assets\/v[^/]+\/css\//g, 'css/')
          .replace(/assets\/v[^/]+\/js\//g, 'js/');
      }
    },
    {
      name: 'copy-pwa-assets',
      closeBundle() {
        const distDir = resolve(__dirname, 'dist');
        for (const file of ['sw.js', 'manifest.json']) {
          const src = resolve(__dirname, file);
          if (existsSync(src)) copyFileSync(src, resolve(distDir, file));
        }
        const iconsSrc = resolve(__dirname, 'icons');
        if (existsSync(iconsSrc)) {
          cpSync(iconsSrc, resolve(distDir, 'icons'), { recursive: true });
        }
      }
    }
  ]
});