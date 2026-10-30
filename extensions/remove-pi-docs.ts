import { AsyncLocalStorage } from "node:async_hooks";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { cleanRequestMessages, extractBuiltinDocs, isBuiltinDocs, OMIT_DOCS, prependDocsToRunPrompt, renderDocsBlock, type RunPrompt, stripPiDocs } from "./docs.ts";

/**
 * Transcript marker for a /pi run whose request carried the guidance. Custom entries are rendered
 * by this extension and never reach the model, so the marker adds nothing to the prompt.
 */
const RUN_MARKER = "pi-docs";

interface RunMarker {
	/** Approximate size of the guidance that request added. */
	tokens?: number;
}

/** Coarse estimate rounded to the nearest ten; Pi's guidance is about 500 tokens. */
function estimateTokens(text: string): number {
	return Math.round(text.length / 40) * 10;
}

export default function piSlim(pi: ExtensionAPI) {
	// Correlate the actual async submission, not whichever input happens to run next.
	const requests = new AsyncLocalStorage<{ consumed: boolean }>();
	let docsTail: { run: RunPrompt; block: string; marked?: boolean } | undefined;
	let options: BeforeAgentStartEvent["systemPromptOptions"] | undefined;

	// The guidance is added to the request only, so the transcript would otherwise show a plain
	// user message. This marker row says that a /pi run carried it. The wording names no direction:
	// compaction or injected messages can separate the marker from the message it belongs to.
	pi.registerEntryRenderer<RunMarker>(RUN_MARKER, (entry, _options, theme) => {
		const tokens = entry.data?.tokens;
		const detail = tokens ? ` (~${tokens} tokens)` : "";
		return new Text(`${theme.fg("accent", "📖 pi-docs")} ${theme.fg("muted", `this /pi run attached Pi's docs guidance to its request${detail}`)}`, 0, 0);
	});

	pi.registerCommand("pi", {
		description: "Run a request with Pi's built-in documentation guidance enabled",
		handler: async (args, ctx) => {
			const request = args.trim();
			if (!request) {
				ctx.ui.notify("Usage: /pi <request about Pi>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish before using /pi.", "warning");
				return;
			}
			requests.run({ consumed: false }, () => pi.sendUserMessage(request));
		},
	});

	pi.on("before_agent_start", event => {
		const token = requests.getStore();
		const preserveDocs = token !== undefined && !token.consumed;
		if (token) token.consumed = true;
		options = event.systemPromptOptions;
		docsTail = undefined;

		const docs = options.sections.docs;
		const native = !docs || isBuiltinDocs(docs);
		const prompt = event.messageType === "user" ? event.prompt : undefined;
		// Read the rendered prompt before the marker replaces the section: it is the only place
		// Pi spells the guidance out, so this extension never has to duplicate the text.
		const guidance = preserveDocs && native && prompt !== undefined ? extractBuiltinDocs(event.systemPrompt) : undefined;
		if (native) options.sections.docs = OMIT_DOCS;
		// Never return a full systemPrompt or fold tools/rules into customPrompt.
		// Pi still owns their generation, including refreshes between tool calls.
		// /pi receives the guidance at the head of its own message instead of in the prompt, so
		// the request keeps the prefix of earlier requests and the provider's prompt cache holds.
		if (guidance !== undefined && prompt !== undefined) docsTail = { run: { prompt }, block: renderDocsBlock(guidance) };
	});

	// A forced prompt (another extension returned `systemPrompt`) is final once every
	// before_agent_start handler has run. Clean it before any request is built, so views
	// that read ctx.getSystemPrompt() see the same text the provider gets.
	pi.on("agent_start", () => {
		if (options?.forceSystemPrompt !== undefined) options.forceSystemPrompt = stripPiDocs(options.forceSystemPrompt);
	});

	// The transcript keeps exactly what Pi computed (its next section diff must converge); docs
	// and the omission marker are removed only from what this request sends.
	pi.on("context_with_system", event => {
		const messages = cleanRequestMessages(event.messages);
		if (!docsTail) return { messages };
		const sent = prependDocsToRunPrompt(messages, docsTail.run, docsTail.block);
		// Mark the run once, and only after the guidance really went into a request. By now the run's
		// user message is saved, so the marker lands between it and the reply: forking or /tree from
		// that message leaves the marker behind, and compaction cuts the same way as without it.
		if (sent !== messages && !docsTail.marked) {
			docsTail.marked = true;
			pi.appendEntry(RUN_MARKER, { tokens: estimateTokens(docsTail.block) });
		}
		return { messages: sent };
	});

	pi.on("agent_settled", () => { options = undefined; docsTail = undefined; });
}
