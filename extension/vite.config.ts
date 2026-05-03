import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
	plugins: [react()],
	root: path.resolve(__dirname, 'src/webview'),
	base: './',
	build: {
		outDir: path.resolve(__dirname, 'out/webview'),
		emptyOutDir: true,
		assetsDir: '.',
		rollupOptions: {
			output: {
				entryFileNames: 'main.js',
				chunkFileNames: 'chunks/[name]-[hash].js',
				assetFileNames: (info) => {
					if (info.name && info.name.endsWith('.css')) return 'main.css';
					return 'assets/[name]-[hash][extname]';
				},
			},
		},
	},
});
