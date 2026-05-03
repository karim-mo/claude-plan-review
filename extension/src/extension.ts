// Claude Plan Review: extension entry point.
//
// Activates on startup in every VS Code window, listens on a per-window
// Unix socket, injects CLAUDE_PLAN_REVIEW_SOCKET into integrated-terminal
// env via EnvironmentVariableCollection. Per-connection handling lives in
// review-panel.ts.

import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';

import { handleConnection } from './review-panel';

const LOG_PREFIX = '[claude-plan-review]';
const ENV_VAR = 'CLAUDE_PLAN_REVIEW_SOCKET';

function computeSocketPath(): string {
	const key = crypto
		.createHash('sha1')
		.update(vscode.env.sessionId)
		.digest('hex')
		.slice(0, 12);
	return `/tmp/claude-plan-review-${key}.sock`;
}

export function activate(context: vscode.ExtensionContext): void {
	const sockPath = computeSocketPath();
	console.log(`${LOG_PREFIX} activating (pid=${process.pid}, socket=${sockPath})`);

	try {
		fs.unlinkSync(sockPath);
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== 'ENOENT') {
			console.error(`${LOG_PREFIX} failed to unlink stale socket:`, e);
		}
	}

	const server = net.createServer((socket) => {
		handleConnection(socket, context);
	});

	server.on('error', (err) => {
		console.error(`${LOG_PREFIX} server error:`, err);
	});

	server.listen(sockPath, () => {
		console.log(`${LOG_PREFIX} listening on ${sockPath}`);

		context.environmentVariableCollection.persistent = false;
		context.environmentVariableCollection.replace(ENV_VAR, sockPath);
		console.log(`${LOG_PREFIX} injected ${ENV_VAR} into terminal env`);
	});

	context.subscriptions.push({
		dispose: () => {
			console.log(`${LOG_PREFIX} deactivating`);
			try {
				context.environmentVariableCollection.clear();
			} catch (err) {
				console.error(`${LOG_PREFIX} env collection clear failed:`, err);
			}
			server.close();
			try {
				fs.unlinkSync(sockPath);
			} catch {
				// best-effort
			}
		},
	});
}

export function deactivate(): void {
	// context.subscriptions handle cleanup
}
