import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextWithSystemEvent["messages"][number];
type SystemMessage = Extract<Message, { role: "system" }>;

// A truthy override is necessary: Pi 0.87.1 regenerates docs for ""/undefined.
// The saved sections keep this marker: Pi diffs them against the next request's
// desired sections, so a cleared docs section would re-add a patch every request.
// It is removed from every request before the provider sees it.
export const OMIT_DOCS = "<!-- pi-slim:omit -->";
const HEADER = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";

/** Recognize Pi's complete guidance, not arbitrary project-owned <docs> blocks. */
export function isBuiltinDocs(body: string): boolean {
	const lines = body.trim().split(/\r?\n/);
	return lines.length === 8 && lines[0] === HEADER
		&& lines[1].startsWith("- Main documentation: ")
		&& lines[2].startsWith("- Additional docs: ")
		&& lines[3].startsWith("- Examples: ") && lines[3].endsWith(" (extensions, custom tools, SDK)")
		&& lines[4] === "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory"
		&& lines[5].startsWith("- When asked about: extensions (docs/extensions.md, examples/extensions/), ")
		// Pi 1.0 appended MCP/codemode topics; tolerate future additions to this list.
		&& lines[5].includes("environment variables (docs/environment-variables.md)")
		&& lines[6] === "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing"
		&& lines[7] === "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
}

/** Only visit top-level blocks. Nested instructions and fenced examples are user content. */
export function stripPiDocs(text: string): string {
	const pattern = /^<([a-z][a-z0-9_-]*)(?:[ \t]+[^>\r\n]*)?>\r?\n|^ {0,3}(`{3,}|~{3,})([^\r\n]*)|^Pi documentation \(read only[^\r\n]*/gm;
	let fence: string | undefined;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const marker = match[2];
		if (marker !== undefined) {
			if (fence === undefined) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length && match[3].trim() === "") fence = undefined;
			continue;
		}
		if (fence !== undefined) continue;
		let end: number;
		if (match[1]) {
			const closing = new RegExp(`\\r?\\n</${match[1]}>(?=\\r?\\n|$)`, "g");
			closing.lastIndex = pattern.lastIndex;
			const close = closing.exec(text);
			if (!close) continue;
			end = closing.lastIndex;
			const body = text.slice(pattern.lastIndex, close.index);
			pattern.lastIndex = end;
			if (!/^<docs>\r?\n$/.test(match[0]) || (body.trim() !== OMIT_DOCS && !isBuiltinDocs(body))) continue;
		} else {
			// Legacy/extension-produced unwrapped guidance: require all eight native lines.
			const block = text.slice(match.index).match(/^(?:[^\r\n]*\r?\n){7}[^\r\n]*/)?.[0];
			if (!block || !isBuiltinDocs(block)) continue;
			end = match.index + block.length;
			pattern.lastIndex = end;
		}
		const before = text.slice(0, match.index).replace(/(?:\r?\n){2}$/, "");
		const after = text.slice(end);
		text = before + (before ? after : after.replace(/^(?:\r?\n){1,2}/, ""));
		pattern.lastIndex = before.length;
	}
	return text;
}

/** The omission marker, bare or wrapped exactly as Pi renders a custom docs section. */
export function isOmitMarkerSection(value: string): boolean {
	const text = value.trim();
	if (text === OMIT_DOCS) return true;
	const match = /^<docs>\r?\n([\s\S]*?)\r?\n<\/docs>$/.exec(text);
	return match?.[1].trim() === OMIT_DOCS;
}

/** Return an owned copy; null sections remove docs left by an earlier /pi run. */
export function cleanSystemMessage(message: SystemMessage): SystemMessage {
	const content = typeof message.content === "string" ? stripPiDocs(message.content) : message.content.map(block => {
		const text = stripPiDocs(block.text);
		if (text === block.text) return block;
		const { textSignature: _signature, ...rest } = block;
		return { ...rest, text };
	});
	const sections = message.sections && Object.fromEntries(Object.entries(message.sections).map(([name, value]) => {
		if (value === null) return [name, value];
		// Keep the marker as built: clearing it here makes Pi's section diff patch the
		// prompt again on every request, which litters the transcript with empty system messages.
		if (name === "docs" && isOmitMarkerSection(value)) return [name, value];
		const clean = name === "docs" && isBuiltinDocs(value) ? "" : stripPiDocs(value);
		return [name, clean === value ? value : clean || null];
	}));
	return { ...message, content, ...(sections && { sections }) };
}

/** Clean old history too, retaining custom docs, tool declarations and system-message ordering. */
export function cleanRequestMessages(messages: Message[]): Message[] {
	let customDocsPresent = false;
	return messages.flatMap<Message>((message, index) => {
		if (message.role !== "system") return [message];
		const clean = cleanSystemMessage(message);
		if (clean.sections?.docs !== undefined) {
			const docs = clean.sections.docs;
			// The marker means "no docs": a removal only when custom docs are in effect, otherwise nothing.
			const omitted = typeof docs === "string" && isOmitMarkerSection(docs);
			if (omitted) clean.sections.docs = null;
			if (clean.sections.docs === null && !customDocsPresent) delete clean.sections.docs;
			customDocsPresent = !omitted && docs !== null;
		}
		// Do not send redundant empty system updates or "remove docs" instructions.
		return index > 0 && isEmptySystem(clean) ? [] : [clean];
	});
}

/** A /pi run keeps Pi's docs, but the saved omission marker still must not reach the provider. */
export function dropOmitMarkers(messages: Message[]): Message[] {
	return messages.flatMap<Message>((message, index) => {
		const docs = message.role === "system" ? message.sections?.docs : undefined;
		if (message.role !== "system" || typeof docs !== "string" || !isOmitMarkerSection(docs)) return [message];
		const { docs: _marker, ...sections } = message.sections!;
		const clean = { ...message, sections };
		return index > 0 && isEmptySystem(clean) ? [] : [clean];
	});
}

function isEmptySystem(message: SystemMessage): boolean {
	const emptyContent = typeof message.content === "string" ? message.content.length === 0 : message.content.every(block => block.text.length === 0);
	return emptyContent && !Object.keys(message.sections ?? {}).length && !message.toolsAdded?.length && !message.toolsRemoved?.length;
}
