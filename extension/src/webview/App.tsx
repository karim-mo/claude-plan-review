import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	wrapRange,
	unwrapRange,
	findSectionHeading,
	pulseHighlights,
} from './highlight';

interface VsCodeApi {
	postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

interface Comment {
	id: string;
	selectedText: string;
	sectionHeading: string | null;
	comment: string;
}

interface Selection {
	text: string;
	range: Range;
	rect: DOMRect;
	sectionHeading: string | null;
}

interface EditingState {
	id: string;
	selectedText: string;
	sectionHeading: string | null;
	comment: string;
	rect: DOMRect;
}

type SubmitAction = 'approve' | 'reject' | 'cancel';

export default function App() {
	const [planHtml, setPlanHtml] = useState('');
	const [comments, setComments] = useState<Comment[]>([]);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<EditingState | null>(null);
	const [approved, setApproved] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	const planRef = useRef<HTMLElement>(null);
	const listRef = useRef<HTMLElement>(null);
	// Highlight click handlers are registered at wrap time and outlive any
	// individual render, so they read comments through this always-current ref.
	const commentsRef = useRef<Comment[]>(comments);
	commentsRef.current = comments;

	// Receive content from host.
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const msg = event.data;
			if (msg && msg.type === 'updateContent') setPlanHtml(msg.html);
		};
		window.addEventListener('message', handler);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', handler);
	}, []);

	// Global: Escape clears pending selection / floating editor.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setEditorOpen(false);
				setSelection(null);
				setEditing(null);
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, []);

	// Selection detection on mouseup.
	useEffect(() => {
		const onMouseUp = (e: MouseEvent) => {
			// Clicks on our own floating UI must not re-evaluate selection,
			// otherwise the mouseup racing with React's onClick will clobber
			// whatever state the click just set (e.g. editorOpen).
			const tgt = e.target as HTMLElement | null;
			if (tgt?.closest?.('.floating')) return;

			setTimeout(() => {
				const plan = planRef.current;
				if (!plan) return;
				const sel = window.getSelection();
				if (!sel || sel.isCollapsed || !sel.rangeCount) {
					if (!editorOpen) setSelection(null);
					return;
				}
				const text = sel.toString().trim();
				if (!text) {
					if (!editorOpen) setSelection(null);
					return;
				}
				const range = sel.getRangeAt(0);
				// Gate on startContainer rather than commonAncestorContainer:
				// selections on the last element can end past the plan boundary,
				// which hoists commonAncestor up to <main> and would otherwise
				// suppress the button entirely.
				if (!plan.contains(range.startContainer)) return;
				const startEl =
					range.startContainer.nodeType === Node.TEXT_NODE
						? range.startContainer.parentElement
						: (range.startContainer as Element);
				if (startEl?.closest?.('.comment-highlight')) return;

				setSelection({
					text,
					range: range.cloneRange(),
					rect: range.getBoundingClientRect(),
					sectionHeading: findSectionHeading(range.startContainer, plan),
				});
				setEditorOpen(false);
				setEditing(null);
			}, 0);
		};
		document.addEventListener('mouseup', onMouseUp);
		return () => document.removeEventListener('mouseup', onMouseUp);
	}, [editorOpen]);

	const scrollToHighlight = useCallback((id: string) => {
		pulseHighlights(id);
	}, []);

	const scrollToList = useCallback(() => {
		listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}, []);

	const openEditFor = useCallback((id: string) => {
		const c = commentsRef.current.find((x) => x.id === id);
		if (!c) return;
		const span = document.querySelector<HTMLElement>(
			'.comment-highlight[data-comment-id="' + id + '"]',
		);
		if (!span) return;
		setSelection(null);
		setEditorOpen(false);
		setEditing({
			id,
			selectedText: c.selectedText,
			sectionHeading: c.sectionHeading,
			comment: c.comment,
			rect: span.getBoundingClientRect(),
		});
	}, []);

	const addComment = useCallback(
		(body: string) => {
			if (!selection) return;
			const id =
				(crypto.randomUUID && crypto.randomUUID()) ||
				'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
			const c: Comment = {
				id,
				selectedText: selection.text,
				sectionHeading: selection.sectionHeading,
				comment: body,
			};
			try {
				wrapRange(
					selection.range,
					id,
					() => openEditFor(id),
					planRef.current ?? undefined,
				);
			} catch (err) {
				console.error('wrapRange failed:', err);
			}
			setComments((prev) => [...prev, c]);
			vscode.postMessage({ type: 'addComment', ...c });
			setSelection(null);
			setEditorOpen(false);
			window.getSelection()?.removeAllRanges();
		},
		[selection, openEditFor],
	);

	const updateComment = useCallback((id: string, body: string) => {
		setComments((prev) =>
			prev.map((c) => (c.id === id ? { ...c, comment: body } : c)),
		);
		vscode.postMessage({ type: 'editComment', id, comment: body });
		setEditing(null);
	}, []);

	const removeComment = useCallback((id: string) => {
		unwrapRange(id, planRef.current);
		setComments((prev) => prev.filter((c) => c.id !== id));
		vscode.postMessage({ type: 'removeComment', id });
	}, []);

	const submit = useCallback(
		(action: SubmitAction) => {
			if (submitting) return;
			setSubmitting(true);
			if (action === 'approve') setApproved(true);
			vscode.postMessage({ type: 'submit', action });
		},
		[submitting],
	);

	const commentCount = comments.length;
	const hasComments = commentCount > 0;

	return (
		<>
			<header className="header">
				<div className="status">
					Ready for review. Select text in the plan to annotate.
				</div>
			</header>

			<main className="main">
				<article
					id="plan"
					ref={planRef}
					dangerouslySetInnerHTML={useMemo(() => ({ __html: planHtml }), [planHtml])}
				/>

				{hasComments && (
					<section className="comment-list" ref={listRef}>
						<h2>Comments</h2>
						{comments.map((c) => (
							<CommentItem
								key={c.id}
								c={c}
								onScrollTo={() => scrollToHighlight(c.id)}
								onRemove={() => removeComment(c.id)}
							/>
						))}
					</section>
				)}
			</main>

			<footer className="footer">
				<div
					className={'comment-count' + (hasComments ? ' clickable' : '')}
					onClick={hasComments ? scrollToList : undefined}
				>
					{commentCount} comment{commentCount === 1 ? '' : 's'}
				</div>
				<div className="actions">
					<button
						type="button"
						className={!hasComments ? 'primary' : ''}
						disabled={submitting || hasComments}
						onClick={() => submit('approve')}
					>
						Approve
					</button>
					<button
						type="button"
						className={hasComments ? 'primary' : ''}
						disabled={submitting || !hasComments}
						onClick={() => submit('reject')}
					>
						Request Changes
					</button>
					<button
						type="button"
						className="secondary"
						disabled={submitting}
						onClick={() => submit('cancel')}
					>
						Cancel
					</button>
				</div>
			</footer>

			{selection && !editorOpen && !editing && (
				<FloatingAddButton
					rect={selection.rect}
					onClick={() => setEditorOpen(true)}
				/>
			)}
			{selection && editorOpen && !editing && (
				<FloatingEditor
					rect={selection.rect}
					quote={selection.text}
					onSubmit={addComment}
					onCancel={() => {
						setEditorOpen(false);
						setSelection(null);
					}}
				/>
			)}
			{editing && (
				<FloatingEditor
					key={editing.id}
					rect={editing.rect}
					quote={editing.selectedText}
					initialText={editing.comment}
					submitLabel="Save"
					onSubmit={(body) => updateComment(editing.id, body)}
					onCancel={() => setEditing(null)}
				/>
			)}

			{approved && (
				<div className="approved-hint">
					Approved. Switch to your terminal and pick a run mode.
				</div>
			)}
		</>
	);
}

function CommentItem({
	c,
	onScrollTo,
	onRemove,
}: {
	c: Comment;
	onScrollTo: () => void;
	onRemove: () => void;
}) {
	return (
		<div
			className="comment-item"
			data-id={c.id}
			onClick={(e) => {
				if ((e.target as HTMLElement).closest('.remove')) return;
				onScrollTo();
			}}
		>
			<div className="comment-anchor">
				"{truncate(c.selectedText, 160)}"
				{c.sectionHeading && (
					<span className="section"> in {c.sectionHeading}</span>
				)}
			</div>
			<div className="comment-body">{c.comment}</div>
			<button
				type="button"
				className="remove"
				onClick={(e) => {
					e.stopPropagation();
					onRemove();
				}}
			>
				Remove
			</button>
		</div>
	);
}

function FloatingAddButton({
	rect,
	onClick,
}: {
	rect: DOMRect;
	onClick: () => void;
}) {
	const pad = 8;
	const top = Math.max(pad, rect.top - 42);
	const left = Math.max(pad, Math.min(rect.left, window.innerWidth - 160));
	return (
		<div className="floating" style={{ top, left }}>
			<button type="button" onClick={onClick}>
				+ Add comment
			</button>
		</div>
	);
}

function FloatingEditor({
	rect,
	quote,
	initialText,
	submitLabel = 'Submit',
	onSubmit,
	onCancel,
}: {
	rect: DOMRect;
	quote: string;
	initialText?: string;
	submitLabel?: string;
	onSubmit: (body: string) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState(initialText ?? '');
	const taRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		taRef.current?.focus();
	}, []);

	const handleSubmit = () => {
		const t = text.trim();
		if (t) onSubmit(t);
	};

	const pad = 8;
	const top = Math.max(
		pad,
		Math.min(rect.bottom + 6, window.innerHeight - 200),
	);
	const left = Math.max(
		pad,
		Math.min(rect.left, window.innerWidth - 340),
	);

	return (
		<div className="floating" style={{ top, left }}>
			<div className="editor">
				<div className="editor-quote">{truncate(quote, 140)}</div>
				<textarea
					ref={taRef}
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder="Add your comment..."
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSubmit();
					}}
				/>
				<div className="editor-actions">
					<button
						type="button"
						className="primary"
						onClick={handleSubmit}
						disabled={!text.trim()}
					>
						{submitLabel}
					</button>
					<button type="button" className="secondary" onClick={onCancel}>
						Cancel
					</button>
				</div>
			</div>
		</div>
	);
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
