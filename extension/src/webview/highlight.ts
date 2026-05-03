// Imperative DOM helpers for wrapping selection ranges in
// `<span class="comment-highlight" data-comment-id="...">` and unwrapping.
// React owns the footer/list/floating UI; the plan body stays under our
// imperative control so we can apply highlights across arbitrary range
// boundaries without fighting the virtual DOM.

export function wrapRange(
	range: Range,
	id: string,
	onClick: () => void,
	walkRoot?: Node,
): void {
	const ancestor = range.commonAncestorContainer;

	if (ancestor.nodeType === Node.TEXT_NODE) {
		wrapPortion(ancestor as Text, range.startOffset, range.endOffset, id, onClick);
		return;
	}

	// Walk from the caller-supplied root (typically the plan article) when given.
	// This keeps us from wandering into the comment list / footer when the range
	// bleeds past the plan's last element.
	const root = walkRoot ?? ancestor;

	const textNodes: Text[] = [];
	const walker = document.createTreeWalker(
		root,
		NodeFilter.SHOW_TEXT,
		{
			acceptNode(n) {
				return range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
			},
		},
	);
	let cur: Node | null;
	while ((cur = walker.nextNode())) textNodes.push(cur as Text);

	textNodes.forEach((tn) => {
		const start = tn === range.startContainer ? range.startOffset : 0;
		const end = tn === range.endContainer ? range.endOffset : tn.textContent!.length;
		if (start < end) wrapPortion(tn, start, end, id, onClick);
	});
}

function wrapPortion(
	textNode: Text,
	start: number,
	end: number,
	id: string,
	onClick: () => void,
): void {
	const fullText = textNode.textContent ?? '';
	const rawMid = fullText.slice(start, end);
	// Trim leading/trailing whitespace. A trailing newline/space
	// (grabbed by triple-click or full-line selections) would otherwise
	// render as a stray dot between block elements.
	const leftTrim = rawMid.length - rawMid.replace(/^\s+/, '').length;
	const rightTrim = rawMid.length - rawMid.replace(/\s+$/, '').length;
	const effStart = start + leftTrim;
	const effEnd = end - rightTrim;
	if (effStart >= effEnd) return; // whitespace-only portion, skip

	const before = fullText.slice(0, effStart);
	const mid = fullText.slice(effStart, effEnd);
	const after = fullText.slice(effEnd);

	const span = document.createElement('span');
	span.className = 'comment-highlight';
	span.dataset.commentId = id;
	span.textContent = mid;
	span.addEventListener('click', (e) => {
		e.stopPropagation();
		onClick();
	});

	const parent = textNode.parentNode!;
	const frag = document.createDocumentFragment();
	if (before) frag.appendChild(document.createTextNode(before));
	frag.appendChild(span);
	if (after) frag.appendChild(document.createTextNode(after));
	parent.replaceChild(frag, textNode);
}

export function unwrapRange(id: string, root: HTMLElement | null): void {
	const spans = document.querySelectorAll<HTMLElement>(
		'.comment-highlight[data-comment-id="' + id + '"]',
	);
	spans.forEach((span) => {
		const parent = span.parentNode;
		if (!parent) return;
		while (span.firstChild) parent.insertBefore(span.firstChild, span);
		parent.removeChild(span);
	});
	root?.normalize();
}

export function findSectionHeading(node: Node, planRoot: HTMLElement): string | null {
	let n: Element | null =
		node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
	while (n && n !== planRoot && n !== document.body) {
		let prev = n.previousElementSibling;
		while (prev) {
			if (prev.matches?.('h1, h2, h3, h4, h5, h6')) {
				return prev.textContent?.trim() || null;
			}
			const inner = prev.querySelectorAll?.('h1, h2, h3, h4, h5, h6');
			if (inner && inner.length > 0) {
				return inner[inner.length - 1].textContent?.trim() || null;
			}
			prev = prev.previousElementSibling;
		}
		n = n.parentElement;
	}
	return null;
}

export function pulseHighlights(id: string): void {
	const spans = document.querySelectorAll<HTMLElement>(
		'.comment-highlight[data-comment-id="' + id + '"]',
	);
	if (spans.length === 0) return;
	spans[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
	spans.forEach((s) => s.classList.add('pulse'));
	setTimeout(() => spans.forEach((s) => s.classList.remove('pulse')), 1100);
}
