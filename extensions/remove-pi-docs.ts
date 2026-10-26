import { AsyncLocalStorage } from "node:async_hooks";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanRequestMessages, dropOmitMarkers, isBuiltinDocs, OMIT_DOCS, stripPiDocs } from "./docs.ts";

export default function piSlim(pi: ExtensionAPI) {
	// Correlate the actual async submission, not whichever input happens to run next.
	const requests = new AsyncLocalStorage<{ consumed: boolean }>();
	let preserveDocs = false;
	let options: BeforeAgentStartEvent["systemPromptOptions"] | undefined;

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
		preserveDocs = token !== undefined && !token.consumed;
		if (token) token.consumed = true;
		options = event.systemPromptOptions;
		if (preserveDocs) return;

		const docs = options.sections.docs;
		if (!docs || isBuiltinDocs(docs)) options.sections.docs = OMIT_DOCS;
		// Never return a full systemPrompt or fold tools/rules into customPrompt.
		// Pi still owns their generation, including refreshes between tool calls.
	});

	// A forced prompt (another extension returned `systemPrompt`) is final once every
	// before_agent_start handler has run. Clean it before any request is built, so views
	// that read ctx.getSystemPrompt() see the same text the provider gets.
	pi.on("agent_start", () => {
		if (!preserveDocs && options?.forceSystemPrompt !== undefined) options.forceSystemPrompt = stripPiDocs(options.forceSystemPrompt);
	});

	// The transcript keeps exactly what Pi computed (its next section diff must converge);
	// docs and the omission marker are removed only from what this request sends.
	pi.on("context_with_system", event => {
		return { messages: preserveDocs ? dropOmitMarkers(event.messages) : cleanRequestMessages(event.messages) };
	});

	pi.on("agent_settled", () => { options = undefined; preserveDocs = false; });
}
