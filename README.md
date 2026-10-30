# @ssk_dev/pi-docs-slim

> [See my full setup for Pi](https://github.com/kunkun9527/my-lean-pi-setup)

[简体中文](README.zh-CN.md)

A [Pi](https://pi.dev) extension that keeps Pi's built-in documentation guidance out of the system prompt. When you actually have a question about Pi itself, ask it with `/pi` and the guidance comes back for that one run.

This is a fork of [robzolkos/pi-slim](https://github.com/robzolkos/pi-slim) by Rob Zolkos. The idea and the `/pi` command come from his extension. The fork exists mainly to make it work on newer Pi versions.

## Install

```bash
pi install npm:@ssk_dev/pi-docs-slim
```

If you have the original `pi-slim` installed, remove it first. Both register a `/pi` command.

Requires Pi 0.87.1 or newer (tested on 0.87.1, 1.0.0 and 1.4.0).

## Usage

- Normal requests: Pi's documentation guidance is removed from what the model sees.
- `/pi <question about Pi>`: this run reads the guidance at the head of its own message instead of in the system prompt, and keeps it for its tool-call turns. Once the guidance has gone into a request, the transcript shows a one-line `📖 pi-docs` marker between your message and the reply, so you can see which run carried it. The next normal request goes back to removing it.
- Your own `<docs>` blocks, project instructions, and code examples are left alone. Saved user messages, assistant replies, and tool output are never changed (`/pi` only adds the guidance to the request it sends).

After installing or updating, run `/reload`, send a normal message, and check `/context`.

## Why fork instead of the original

The original 0.2.1 removes the docs by replacing a string in the system prompt. Starting with Pi 0.87.1, the system prompt is built from structured sections and saved as system messages, so that replacement no longer takes effect: the docs still reach the model (see [pi-slim#3](https://github.com/robzolkos/pi-slim/issues/3)).

What this fork changes:

- **Removes the docs from the new structured prompt.** It blocks Pi from filling the docs section back in, and strips the docs from every request before the provider sees them. The saved system message keeps a short `<!-- pi-slim:omit -->` marker in that section: Pi derives each request's sections from the transcript, so a cleared section makes it append an empty system message to every request.
- **Cleans old history too.** Docs left over from an earlier `/pi` run are stripped from later normal requests.
- **Works with `/context` in any load order.** [pi-context-view](https://www.npmjs.com/package/pi-context-view) never shows Pi's docs and never mislabels the prompt as forced, whether it loads before or after this extension (see Limits for the marker).
- **Makes `/pi` reliable.** The "keep docs" permission is tied to the exact request `/pi` sends, so it can't leak into your next message if that request gets intercepted.
- **`/pi` no longer breaks the prompt cache.** Most providers get the system prompt at the very start of the request, so putting the guidance back into it made the provider re-read the whole session: one `/pi` run cost two full cache misses (the run itself, plus the normal request that switched the section back off). Now the system prompt is byte-identical for every request and the cached prefix before `/pi` is kept. Only the `/pi` run itself is new: about 500 tokens of guidance, plus re-reading that run once on the next normal request, which no longer carries the guidance.
- **Doesn't freeze the prompt.** Tools and rules added later by other extensions still show up.
- **Adds offline integration tests.** They run real Pi sessions with an offline model provider, so no model service is called.

No new runtime dependencies.

## Tests

```bash
npm test
```

The tests need Pi 0.87.1+ and pi-context-view 0.6.0 or 0.8.0 installed. They look for the global Pi and `~/.pi/agent/npm/node_modules/pi-context-view` by default. For other locations, point to the package roots:

```bash
PI_CODING_AGENT_DIR=/path/to/pi-coding-agent PI_CONTEXT_VIEW_DIR=/path/to/pi-context-view npm test
```

Set `PI_SLIM_ENTRY` to run the suite against another implementation.

## Limits

- Old session files aren't rewritten. `/context`'s Usage view is clean after the next normal request. The Initial view is a snapshot from the first request; reload to refresh it. If that first request was `/pi`, it will include the docs, which is expected.
- During a `/pi` run, `/context` shows the guidance as content of that message (about 500 tokens). It is added to the request only: the saved session keeps your question as you typed it, and later requests don't carry the guidance.
- The `📖 pi-docs` marker is a session `CustomEntry`: Pi keeps custom entries out of the model's context, so it adds no prompt tokens, `/context` does not count it, and it stays in the transcript across reloads. It is written after the run's message is saved, so forking or `/tree` from that message leaves it behind, and compaction picks the same cut as without it. Its token count is a rough estimate, and an extension that edits the request after this one can still change what is sent.
- Saved sessions keep the ~20-character omission marker in their `docs` section so Pi's per-request section diff converges. The marker is removed from every request and never reaches the model. `/context` may still count it (about 5 tokens): pi-context-view 0.6.0 reads the saved transcript, and 0.8.0 captures each request before this extension cleans it when it loads first. That is pi-context-view's documented behavior for handlers that run after it (see its [capture notes](https://github.com/dimk90/pi-context-view/blob/develop/doc/architecture/capture.md)); you don't need to change your load order.
- If the model reads Pi's docs with a tool, that output is kept.
- The cleanup relies on Pi 0.87.1's event order. Rerun the tests after upgrading Pi. If another extension re-injects the docs after the final context step, they won't be removed.

## License

MIT. Original work © pi-slim contributors (Rob Zolkos); see [LICENSE](LICENSE).
