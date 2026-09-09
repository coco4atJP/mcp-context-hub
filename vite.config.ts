import { defineConfig } from 'vite';
export default defineConfig({ root: 'ui', build: { outDir: '../dist/gui', emptyOutDir: true, target: 'es2022' } });
