import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import fs from 'fs';
import path from 'path';
import os from 'os';

function getHttpsConfig() {
	try {
		const pwaCertPath = path.join(os.homedir(), '.local/share/mkcert/pwa');
		const keyPath = path.join(pwaCertPath, 'key.pem');
		const certPath = path.join(pwaCertPath, 'cert.pem');

		if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
			return {
				key: fs.readFileSync(keyPath),
				cert: fs.readFileSync(certPath),
			};
		}
	} catch (_ignore) {}
	return undefined;
}

export default defineConfig({
	plugins: [sveltekit()],
	clearScreen: false,
	server: {
		host: '0.0.0.0',
		port: 32211,
		https: getHttpsConfig(),
		proxy: {
			'/api': {
				target: 'https://localhost:11556',
				secure: false,
				changeOrigin: true,
			},
			'/media': {
				target: 'https://localhost:11556',
				secure: false,
				changeOrigin: true,
			},
			'/search': {
				target: 'https://localhost:11557',
				secure: false,
				changeOrigin: true,
			},
			'/gallery': {
				target: 'https://localhost:11557',
				secure: false,
				changeOrigin: true,
			},
			'/galleries': {
				target: 'https://localhost:11557',
				secure: false,
				changeOrigin: true,
			},
			'/refresh': {
				target: 'https://localhost:11557',
				secure: false,
				changeOrigin: true,
			},
			'/immediate': {
				target: 'https://localhost:11558',
				secure: false,
				changeOrigin: true,
			},
			'/artists': {
				target: 'https://localhost:11558',
				secure: false,
				changeOrigin: true,
			},
			'/remove': {
				target: 'https://localhost:11558',
				secure: false,
				changeOrigin: true,
			},
		},
	},
});
