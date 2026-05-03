// Claude Plan Review: per-connection review panel lifecycle.
//
// A socket connection delivers a single {planPath, sessionId} request.
// We open a webview panel, render the plan as markdown, and wire up the
// annotation UX. On submit (approve/reject/cancel) or panel dispose, we
// write a response over the socket plus a debug sidecar at
// /tmp/plan-review-{sessionId}.json.

import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { marked } from 'marked';

const LOG_PREFIX = '[claude-plan-review panel]';

interface RequestMessage {
	planPath?: string;
	sessionId?: string;
}

interface ReviewComment {
	id: string;
	selectedText: string;
	sectionHeading: string | null;
	comment: string;
}

interface ResponsePayload {
	status: 'approved' | 'rejected' | 'cancelled';
	comments: ReviewComment[];
	timestamp: string;
}

interface PlanReviewSession {
	sessionId: string;
	planPath: string;
	socket: net.Socket;
	sidecarPath: string;
	panel: vscode.WebviewPanel;
	comments: ReviewComment[];
	responseWritten: boolean;
}

const sessions = new Map<string, PlanReviewSession>();

function sidecarPath(sessionId: string): string {
	return `/tmp/plan-review-${sessionId}.json`;
}

function writeResponse(session: PlanReviewSession, payload: ResponsePayload): void {
	if (session.responseWritten) {
		return;
	}
	const serialized = JSON.stringify(payload);

	// Debug sidecar first (lossless record even if socket write fails)
	try {
		fs.writeFileSync(session.sidecarPath, JSON.stringify(payload, null, 2));
	} catch (err) {
		console.error(`${LOG_PREFIX} sidecar write failed:`, err);
	}

	// Then socket
	try {
		session.socket.write(serialized + '\n');
	} catch (err) {
		console.error(`${LOG_PREFIX} socket write failed:`, err);
	}

	session.responseWritten = true;
}

function sendCancelled(socket: net.Socket): void {
	const payload: ResponsePayload = {
		status: 'cancelled',
		comments: [],
		timestamp: new Date().toISOString(),
	};
	try {
		socket.write(JSON.stringify(payload) + '\n');
	} catch {
		// connection already dead
	}
}

export function handleConnection(socket: net.Socket, context: vscode.ExtensionContext): void {
	let buffer = '';
	let processed = false;

	socket.setEncoding('utf8');

	socket.on('data', (chunk: string) => {
		if (processed) return;
		buffer += chunk;
		const nlIdx = buffer.indexOf('\n');
		if (nlIdx < 0) return;

		processed = true;
		const line = buffer.slice(0, nlIdx);

		let request: RequestMessage;
		try {
			request = JSON.parse(line);
		} catch (err) {
			console.error(`${LOG_PREFIX} malformed request JSON:`, line);
			sendCancelled(socket);
			socket.end();
			return;
		}

		try {
			openReviewPanel(request, socket, context);
		} catch (err) {
			console.error(`${LOG_PREFIX} openReviewPanel failed:`, err);
			sendCancelled(socket);
			socket.end();
		}
	});

	socket.on('error', (err) => {
		console.error(`${LOG_PREFIX} socket error:`, err);
	});
}

function openReviewPanel(
	request: RequestMessage,
	socket: net.Socket,
	context: vscode.ExtensionContext,
): void {
	if (!request.planPath || !request.sessionId) {
		throw new Error('request missing planPath or sessionId');
	}

	let planContent: string;
	try {
		planContent = fs.readFileSync(request.planPath, 'utf8');
	} catch (err) {
		console.error(`${LOG_PREFIX} could not read plan file ${request.planPath}:`, err);
		throw err;
	}

	const planHtml = marked.parse(planContent, { async: false }) as string;

	const panel = vscode.window.createWebviewPanel(
		'claudePlanReview',
		`Plan Review: ${path.basename(request.planPath, '.md')}`,
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
		},
	);

	const session: PlanReviewSession = {
		sessionId: request.sessionId,
		planPath: request.planPath,
		socket,
		sidecarPath: sidecarPath(request.sessionId),
		panel,
		comments: [],
		responseWritten: false,
	};
	sessions.set(request.sessionId, session);
	console.log(`${LOG_PREFIX} opened review panel for session ${session.sessionId}`);

	// Register message handler BEFORE setting html, so we don't miss the
	// webview's 'ready' message in the race between script load and listener
	// registration.
	panel.webview.onDidReceiveMessage((msg: any) => {
		switch (msg?.type) {
			case 'ready':
				panel.webview.postMessage({ type: 'updateContent', html: planHtml });
				break;
			case 'addComment':
				handleAddComment(session, msg);
				break;
			case 'editComment':
				handleEditComment(session, msg);
				break;
			case 'removeComment':
				handleRemoveComment(session, msg.id);
				break;
			case 'submit':
				handleSubmit(session, msg.action);
				break;
		}
	});

	panel.webview.html = buildHtml(panel.webview, context.extensionUri);

	panel.onDidDispose(() => {
		if (!session.responseWritten) {
			writeResponse(session, {
				status: 'cancelled',
				comments: [],
				timestamp: new Date().toISOString(),
			});
			try {
				session.socket.end();
			} catch {
				// already closed
			}
		}
		sessions.delete(session.sessionId);
		console.log(`${LOG_PREFIX} disposed session ${session.sessionId}`);
	});

	// If the hook dies before the user submits, tear down the panel.
	socket.on('close', () => {
		const live = sessions.get(session.sessionId);
		if (live && !live.responseWritten) {
			console.log(`${LOG_PREFIX} hook disconnected mid-review, disposing panel`);
			live.panel.dispose();
		}
	});
}

function handleAddComment(
	session: PlanReviewSession,
	msg: { id?: string; selectedText?: string; sectionHeading?: string | null; comment?: string },
): void {
	if (!msg.selectedText || !msg.comment) return;
	// Webview is authoritative for UI; it generates the id so it can
	// apply the highlight synchronously. Host just records.
	const c: ReviewComment = {
		id: msg.id || crypto.randomBytes(8).toString('hex'),
		selectedText: msg.selectedText,
		sectionHeading: msg.sectionHeading ?? null,
		comment: msg.comment,
	};
	session.comments.push(c);
}

function handleEditComment(
	session: PlanReviewSession,
	msg: { id?: string; comment?: string },
): void {
	if (!msg.id || msg.comment === undefined) return;
	const existing = session.comments.find((c) => c.id === msg.id);
	if (existing) existing.comment = msg.comment;
}

function handleRemoveComment(session: PlanReviewSession, id: string): void {
	session.comments = session.comments.filter((c) => c.id !== id);
}

function handleSubmit(session: PlanReviewSession, action: 'approve' | 'reject' | 'cancel'): void {
	const status: ResponsePayload['status'] =
		action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';

	writeResponse(session, {
		status,
		comments: status === 'rejected' ? session.comments : [],
		timestamp: new Date().toISOString(),
	});

	try {
		session.socket.end();
	} catch {
		// already closed
	}

	// Small delay before disposing so the "Approved" hint in the webview
	// has a chance to paint before the panel goes away.
	setTimeout(() => session.panel.dispose(), status === 'approved' ? 1200 : 0);
}

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = crypto.randomBytes(16).toString('hex');
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.js'),
	);
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.css'),
	);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: https:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Plan Review</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
