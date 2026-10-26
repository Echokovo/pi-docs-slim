import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
// npm --prefix ... test exports that local prefix; do not mistake it for the global installation.
const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_(?:prefix|global_prefix|local_prefix)$/i.test(key)));
const root = process.env.PI_CODING_AGENT_DIR || join(execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'],
  { encoding: 'utf8', shell: process.platform === 'win32', env: npmEnv },
).trim(), '@earendil-works/pi-coding-agent');
const req = createRequire(join(root, 'package.json'));
const [major, minor] = req('./package.json').version.split('.').map(Number);
assert.ok(major > 0 || minor >= 87, 'This integration suite needs Pi 0.87.1 or newer');
const { createJiti } = req('jiti');
// Pi's own packages sit under pi-coding-agent/node_modules (npm -g) or beside it (hoisted installs such as Pi's releases).
const dep = (name) => [join(root, 'node_modules', name), join(root, '../..', name)].find((dir) => existsSync(join(dir, 'package.json')));
const piAi = join(dep('@earendil-works/pi-ai'), 'dist/index.js');
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
  '@earendil-works/pi-tui': join(dep('@earendil-works/pi-tui'), 'dist/index.js'),
  '@earendil-works/pi-agent-core': join(dep('@earendil-works/pi-agent-core'), 'dist/index.js'),
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-ai': piAi,
} });
const core = await import(pathToFileURL(join(root, 'dist/index.js')));
const ai = await import(pathToFileURL(piAi));
const slim = await jiti.import(process.env.PI_SLIM_ENTRY || resolve(here, '../extensions/remove-pi-docs.ts'), { default: true });
const viewDir = process.env.PI_CONTEXT_VIEW_DIR || join(homedir(), '.pi/agent/npm/node_modules/pi-context-view');
const viewVersion = createRequire(join(viewDir, 'package.json'))('./package.json').version;
assert.ok(['0.6.0', '0.8.0'].includes(viewVersion), `This suite targets pi-context-view 0.6.0 or 0.8.0, found ${viewVersion}`);
const view = viewVersion === '0.6.0' ? await contextView06() : await contextView08();
const { replaySystemMessages, systemMessageText } = view;

// 0.6.0: the suite replays the extension's own capture: an Initial snapshot taken at `context`, and Usage rebuilt from the transcript.
async function contextView06() {
  const { InitialCaptureState, buildUsageSnapshot } = await jiti.import(join(viewDir, 'src/capture.ts'));
  const transcript = await jiti.import(join(viewDir, 'src/transcript.ts'));
  return { ...transcript, attach(dir) {
    const capture = new InitialCaptureState();
    let api;
    return {
      observer(pi) {
        api = pi;
        pi.on('before_agent_start', (e) => capture.prepare(e.systemPromptOptions, e.systemPrompt));
        pi.on('context', (e, ctx) => {
          capture.finalize(() => ({ systemPrompt: ctx.getSystemPrompt(), messages: e.messages,
            baselineMessages: core.buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
            allTools: pi.getAllTools(), activeToolNames: pi.getActiveTools(), origin: 'real-turn' }));
        });
      },
      captured: () => capture.snapshot,
      usage: (session) => buildUsageSnapshot({ messages: session.sessionManager.buildSessionContext().messages, initial: capture.snapshot,
        systemPrompt: session.systemPrompt, options: { cwd: dir }, allTools: api.getAllTools(), activeToolNames: api.getActiveTools() }),
      forcedLabel: () => undefined,
    };
  } };
}

// 0.8.0: the real extension publishes request snapshots to an injected SnapshotStore; /context derives its views from them.
async function contextView08() {
  const install = await jiti.import(join(viewDir, 'src/index.ts'), { default: true });
  const { SnapshotStore } = await jiti.import(join(viewDir, 'src/snapshot.ts'));
  const { ConfigStore } = await jiti.import(join(viewDir, 'src/config.ts'));
  const { applyRequestSnapshot } = await jiti.import(join(viewDir, 'src/projection.ts'));
  const { buildUsageSnapshot } = await jiti.import(join(viewDir, 'src/replay.ts'));
  const { buildInjectionsSnapshot } = await jiti.import(join(viewDir, 'src/injections.ts'));
  return { replaySystemMessages: (messages) => ai.getCurrentSystemMessage(messages) ?? { content: '' }, systemMessageText: ai.getSystemMessageText,
    attach(dir) {
      const snapshots = new SnapshotStore();
      let api;
      const latest = () => { const snapshot = snapshots.latest(); assert.ok(snapshot, 'context-view captured no request'); return snapshot; };
      // Same inputs as context-view's openUsage/openInjections; no probe ran, so the message filter is the identity.
      const live = (session) => ({ systemPrompt: session.systemPrompt, options: { cwd: dir }, allTools: api.getAllTools(), activeToolNames: api.getActiveTools() });
      const projected = (session) => applyRequestSnapshot({ snapshot: latest(), entries: session.sessionManager.getEntries(), leafId: session.sessionManager.getLeafId(), filterMessages: (m) => m });
      return {
        observer(pi) { api = pi; install(pi, snapshots, new ConfigStore(join(dir, 'context-view.json'))); },
        captured: (session) => buildInjectionsSnapshot({ ...live(session), snapshot: latest(), entries: session.sessionManager.getEntries(), filterMessages: (m) => m }),
        usage(session) { const { messages, systemChanges, forcedPrompt } = projected(session); return buildUsageSnapshot({ ...live(session), messages, systemChanges, forcedPrompt }); },
        forcedLabel: (session) => projected(session).forcedPrompt,
      };
    } };
}
const { buildSystemPromptSections } = await import(pathToFileURL(join(root, 'dist/core/system-prompt.js')));
const nativeDocs = buildSystemPromptSections({ cwd: here }).docs;
const DOCS_HEADER = 'Pi documentation (read only';
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost };

async function fixture({ before = [], after = [], systemPrompt, replies, captureFirst = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-slim-test-'));
  const settingsManager = core.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: 'off' } });
  const viewer = view.attach(dir);
  const observer = viewer.observer;
  const requests = [];
  const errors = [];
  const runtime = await core.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider('pi-slim-test', {
    api: 'pi-slim-test-api', apiKey: 'offline-test-only', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'offline', name: 'offline', reasoning: false, input: ['text'], cost, contextWindow: 100000, maxTokens: 1024 }],
    streamSimple(model, context) {
      requests.push(structuredClone(context.messages));
      const stream = new ai.AssistantMessageEventStream();
      const spec = replies?.(requests.length) ?? {};
      const message = { role: 'assistant', content: [{ type: 'text', text: 'OK' }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'stop', timestamp: Date.now(), ...spec };
      queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); });
      return stream;
    },
  });
  const loader = new core.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt, appendSystemPrompt: ['KEEP_ADDENDUM'],
    extensionFactories: [...before, ...(captureFirst ? [observer, slim] : [slim, observer]), ...after],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await core.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
    model: runtime.getModel('pi-slim-test', 'offline'), thinkingLevel: 'off', settingsManager,
    sessionManager: core.SessionManager.inMemory(dir), resourceLoader: loader, tools: ['read', 'bash', 'switch_tools'],
  });
  await session.bindExtensions({ mode: 'print', onError: (e) => errors.push(e) });
  const command = async (text, expectRun = true) => {
    let stop = () => {};
    let timer;
    const settled = expectRun ? new Promise((resolve, reject) => {
      stop = session.subscribe(e => { if (e.type === 'agent_settled') resolve(); });
      timer = setTimeout(() => reject(new Error('offline session did not settle')), 5000);
    }) : undefined;
    try {
      await session.prompt(text);
      if (settled) await settled;
      // context-view 0.8.0 publishes each request snapshot from setImmediate.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(session.isIdle, true);
    } finally { clearTimeout(timer); stop(); }
  };
  const messages = () => session.sessionManager.buildSessionContext().messages;
  // context-view reads the transcript, which keeps the omission marker. When it captures before slim
  // cleans the request (0.8.0 loaded first), or replays the transcript (0.6.0), it may show the marker;
  // it must never show Pi's docs or label the prompt as forced.
  const exactView = viewVersion === '0.8.0' && !captureFirst;
  // 0.6.0's Initial view is a one-time snapshot of the first request; after a first /pi run it shows docs by design.
  const viewClean = ({ forced = false, firstRunWasPi = false } = {}) => {
    if (viewVersion === '0.8.0') noCountedDocs(viewer.captured(session), { marker: !exactView });
    else if (!firstRunWasPi) noDocsGuidance(viewer.captured(session));
    (exactView ? noDocs : noDocsGuidance)(viewer.usage(session));
    if (!forced) assert.equal(viewer.forcedLabel(session), undefined, 'context-view labeled the prompt as forced');
  };
  return { session, requests, errors, command, messages, viewClean, usageSnapshot: () => viewer.usage(session),
    close() { session.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
function noDocs(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(DOCS_HEADER), 'built-in documentation survived');
  assert.ok(!text.includes('pi-slim:omit'), 'internal omission marker survived');
}
// Saved transcripts keep the omission marker so Pi's section diff converges; the guidance must still be gone.
function noDocsGuidance(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(DOCS_HEADER), 'built-in documentation survived');
}
// 0.8.0 Injections lists what a request removed from the session's prompt: docs may appear there,
// but only as a deleted, zero-token row. Anything counted toward the request must be clean.
function noCountedDocs(snapshot, { marker = false } = {}) {
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string' && (node.text.includes(DOCS_HEADER) || (!marker && node.text.includes('pi-slim:omit')))) {
      assert.ok(node.change === 'deleted' || node.diffOnly === true, `docs shown as request content in Injections: ${node.label}`);
      assert.equal(node.tokens, 0, `docs counted in Injections: ${node.label}`);
    }
    Object.values(node).forEach(visit);
  };
  visit(snapshot);
}
function savedDocs(messages) {
  return messages.filter((message) => message.role === 'system').map((message) => message.sections?.docs).at(-1);
}
function currentText(messages) { return systemMessageText(replaySystemMessages(messages)); }
async function using(options, fn) {
  const f = await fixture(options);
  try { await fn(f); assert.deepEqual(f.errors, []); }
  finally { f.close(); }
}

test('ordinary request: provider, persisted sections, and both context-view snapshots contain no docs', () => using({}, async f => {
  await f.command('ordinary');
  assert.equal(f.requests.length, 1);
  noDocs(f.requests); noDocsGuidance(f.messages()); f.viewClean();
  assert.equal(savedDocs(f.messages()), `<docs>\n${OMIT_DOCS}\n</docs>`);
  assert.ok(currentText(f.requests[0]).includes('KEEP_ADDENDUM'));
  assert.equal(replaySystemMessages(f.requests[0]).sections.docs, undefined);
}));

test('later structured rules and selected tools reach both the provider and transcript', () => using({ after: [pi => {
  pi.on('before_agent_start', e => { e.systemPromptOptions.sections.later = 'LATE_SECTION'; e.systemPromptOptions.promptGuidelines.push('LATE_RULE'); e.systemPromptOptions.selectedTools = ['read']; });
}] }, async f => {
  await f.command('ordinary');
  noDocs(f.requests[0]);
  for (const msgs of [f.requests[0], f.messages()]) {
    const text = currentText(msgs); noDocsGuidance(text); assert.match(text, /LATE_SECTION/); assert.match(text, /LATE_RULE/); assert.doesNotMatch(text, /- bash:/);
  }
}));

test('native next-turn refresh stays dynamic across multiple tool calls', () => using({ after: [pi => {
  pi.registerTool({ name: 'switch_tools', label: 'Switch', description: 'Switch test tools', parameters: { type: 'object', properties: {} },
    async execute() { const active = pi.getActiveTools(); pi.setActiveTools(active.includes('bash') ? ['read', 'switch_tools'] : ['read', 'bash', 'switch_tools']); return { content: [{ type: 'text', text: 'switched' }], details: {} }; } });
  pi.on('before_agent_start', e => { e.systemPromptOptions.selectedTools = ['read', 'bash', 'switch_tools']; });
}], replies: n => n <= 2 ? { content: [{ type: 'toolCall', id: `switch-${n}`, name: 'switch_tools', arguments: {} }], stopReason: 'toolUse' } : undefined }, async f => {
  await f.command('switch twice');
  assert.equal(f.requests.length, 3);
  assert.match(currentText(f.requests[0]), /- bash:/);
  assert.doesNotMatch(currentText(f.requests[1]), /- bash:/);
  assert.match(currentText(f.requests[2]), /- bash:/);
  noDocs(f.requests); f.viewClean();
}));

test('/pi preserves docs for its run without freezing later rules, next ordinary request clears them', () => using({ after: [pi => {
  pi.on('before_agent_start', e => { e.systemPromptOptions.sections.later = 'PI_LATE_RULE'; });
}] }, async f => {
  await f.command('/pi explain extensions');
  assert.equal(f.requests.length, 1);
  assert.match(currentText(f.requests[0]), /Pi documentation/);
  assert.match(currentText(f.requests[0]), /PI_LATE_RULE/);
  await f.command('ordinary');
  noDocs(f.requests[1]); noDocsGuidance(currentText(f.messages())); f.viewClean({ firstRunWasPi: true });
}));

test('input interception of /pi cannot leak permission to the next request', () => using({ before: [pi => {
  pi.on('input', e => e.text === 'intercept' ? { action: 'handled' } : undefined);
}] }, async f => {
  await f.command('/pi intercept', false);
  assert.equal(f.requests.length, 0);
  await f.command('ordinary'); noDocs(f.requests); f.viewClean();
}));

test('custom docs, fenced examples, and project instructions are preserved', () => using({ systemPrompt: 'CUSTOM\n<docs>\nPROJECT_API\n</docs>\n\n```xml\n' + nativeDocs + '\n```' }, async f => {
  await f.command('ordinary');
  const text = currentText(f.requests[0]);
  assert.match(text, /PROJECT_API/); assert.ok(text.includes('```xml\n' + nativeDocs + '\n```'));
}));

const noopTool = pi => pi.registerTool({ name: 'switch_tools', label: 'Noop', description: 'No-op', parameters: { type: 'object', properties: {} },
  async execute() { return { content: [{ type: 'text', text: 'done' }], details: {} }; } });
const toolOnFirst = n => n === 1 ? { content: [{ type: 'toolCall', id: `noop-${n}`, name: 'switch_tools', arguments: {} }], stopReason: 'toolUse' } : undefined;

for (const captureFirst of [false, true]) {
  test(`context-view loaded ${captureFirst ? 'before' : 'after'} slim: clean requests, one saved system message, no forced label`, () => using({ captureFirst, after: [noopTool], replies: toolOnFirst }, async f => {
    await f.command('one');
    await f.command('two');
    assert.equal(f.requests.length, 3);
    noDocs(f.requests);
    assert.equal(f.messages().filter((message) => message.role === 'system').length, 1, 'one saved system message, no per-request patches');
    f.viewClean();
  }));
  for (const position of ['before', 'after']) {
    test(`${position} forced prompt remains authoritative but clean across tool turns (context-view ${captureFirst ? 'first' : 'last'})`, () => using({ captureFirst, [position]: [noopTool, pi => {
      pi.on('before_agent_start', () => ({ systemPrompt: 'FORCED_KEEP\n\n' + nativeDocs }));
    }], replies: toolOnFirst }, async f => {
      await f.command('ordinary');
      assert.equal(f.requests.length, 2);
      for (const msgs of f.requests) assert.equal(currentText(msgs), 'FORCED_KEEP');
      noDocs(f.requests); f.viewClean({ forced: true });
    }));
  }
}

test('ordinary → /pi → ordinary restores docs for exactly one run', () => using({}, async f => {
  await f.command('first');
  await f.command('/pi explain themes');
  await f.command('last');
  assert.equal(f.requests.length, 3);
  noDocs(f.requests[0]); assert.match(currentText(f.requests[1]), /Pi documentation/); noDocs(f.requests[2]);
  f.viewClean();
}));

test('/pi permission survives an asynchronous input transform, but not the next submission', () => using({ before: [pi => {
  pi.on('input', async e => { await Promise.resolve(); return { action: 'transform', text: `TRANSFORMED ${e.text}` }; });
}] }, async f => {
  await f.command('/pi explain themes');
  assert.match(currentText(f.requests[0]), /Pi documentation/);
  assert.ok(JSON.stringify(f.requests[0]).includes('TRANSFORMED explain themes'));
  await f.command('ordinary'); noDocs(f.requests[1]);
}));

test('project-owned structured docs survive ordinary requests', () => using({ before: [pi => {
  pi.on('before_agent_start', e => { e.systemPromptOptions.sections.docs = 'PROJECT_DOCS_SECTION'; });
}] }, async f => {
  await f.command('ordinary');
  noDocs(f.requests); assert.match(currentText(f.requests[0]), /PROJECT_DOCS_SECTION/);
  assert.ok(JSON.stringify(f.usageSnapshot()).includes('PROJECT_DOCS_SECTION'));
}));

test('/pi includes docs across tool turns; ordinary requests do not accumulate empty docs updates', () => using({ after: [pi => {
  pi.registerTool({ name: 'switch_tools', label: 'Switch', description: 'No-op', parameters: { type: 'object', properties: {} },
    async execute() { return { content: [{ type: 'text', text: 'done' }], details: {} }; } });
}], replies: n => n === 1 || n === 3 ? { content: [{ type: 'toolCall', id: `noop-${n}`, name: 'switch_tools', arguments: {} }], stopReason: 'toolUse' } : undefined }, async f => {
  await f.command('/pi explain tools');
  assert.equal(f.requests.length, 2);
  for (const msgs of f.requests) assert.match(currentText(msgs), /Pi documentation/);
  await f.command('ordinary');
  assert.equal(f.requests.length, 4);
  for (const msgs of f.requests.slice(2)) {
    noDocs(msgs);
    for (const msg of msgs.filter(m => m.role === 'system')) assert.ok(!Object.hasOwn(msg.sections ?? {}, 'docs'));
  }
  f.viewClean({ firstRunWasPi: true });
}));

test('ordinary requests reuse one system message instead of appending a patch per request', () => using({}, async f => {
  for (const text of ['one', 'two', 'three']) await f.command(text);
  assert.equal(f.requests.length, 3);
  for (const msgs of f.requests) noDocs(msgs);
  const systems = f.messages().filter((message) => message.role === 'system');
  assert.equal(systems.length, 1, 'one saved system message, no per-request patches');
  // The saved prompt keeps the omission marker so Pi's structured section diff stays stable;
  // every request strips it again before the provider sees it.
  assert.equal(systems[0].sections.docs, `<docs>\n${OMIT_DOCS}\n</docs>`);
  assert.equal(savedDocs(f.messages()), `<docs>\n${OMIT_DOCS}\n</docs>`);
  f.viewClean();
}));

const { stripPiDocs, cleanSystemMessage, cleanRequestMessages, OMIT_DOCS } = await jiti.import(resolve(here, '../extensions/docs.ts'));
const nativeBody = nativeDocs.slice('<docs>\n'.length, -'\n</docs>'.length);

test('parser: complete native blocks, CRLF, repeated blocks, and omission markers', () => {
  for (const docs of [nativeDocs, nativeBody, nativeDocs.replaceAll('\n', '\r\n'), `<docs>\n${OMIT_DOCS}\n</docs>`]) {
    assert.equal(stripPiDocs(docs), '');
    assert.equal(stripPiDocs(`BEFORE\n\n${docs}\n\nAFTER`), 'BEFORE\n\nAFTER');
    assert.equal(stripPiDocs(`${docs}\n\n${docs}\n\nAFTER`), 'AFTER');
    assert.equal(stripPiDocs(`BEFORE\n\n${docs}\n\n${docs}\n\nAFTER`), 'BEFORE\n\nAFTER');
  }
});

test('parser: custom, nested, attributed, truncated, and fenced docs are not removed', () => {
  for (const text of [
    '<docs>PROJECT</docs>', '<docs>\nPROJECT\n</docs>',
    `<project_context>\n${nativeDocs}\n</project_context>`,
    `<docs source="project">\n${nativeBody}\n</docs>`,
    `<docs>\n${nativeBody}\nPROJECT_EXTRA\n</docs>`,
    'Pi documentation (read only):\nPROJECT',
    `\`\`\`xml\n${nativeDocs}\n\`\`\``, `~~~~\n${nativeDocs}\n~~~\n${nativeDocs}\n~~~~`,
  ]) assert.equal(stripPiDocs(text), text);
});

test('system cleanup is immutable, preserves tools/metadata, and invalidates only edited text signatures', () => {
  const tool = { name: 'read', description: 'read', parameters: { type: 'object' } };
  const msg = { role: 'system', content: [{ type: 'text', text: nativeDocs, textSignature: 'stale' }, { type: 'text', text: 'KEEP', textSignature: 'keep' }],
    sections: { docs: nativeDocs, project: 'PROJECT' }, toolsAdded: [tool], toolsRemoved: [{ name: 'old' }], timestamp: 123 };
  const before = structuredClone(msg);
  const clean = cleanSystemMessage(msg);
  assert.deepEqual(msg, before); assert.equal(clean.sections.docs, null);
  assert.equal(clean.content[0].textSignature, undefined); assert.equal(clean.content[1], msg.content[1]);
  assert.equal(clean.toolsAdded, msg.toolsAdded); assert.equal(clean.toolsRemoved, msg.toolsRemoved); assert.equal(clean.timestamp, 123);
  assert.deepEqual(cleanSystemMessage(clean), clean);
});

test('saved sections keep the omission marker so the next section diff stays stable', () => {
  const section = `<docs>\n${OMIT_DOCS}\n</docs>`;
  const message = { role: 'system', content: '', sections: { docs: section, project: 'PROJECT' } };
  const clean = cleanSystemMessage(message);
  assert.equal(clean.sections.docs, section);
  assert.equal(clean.sections.project, 'PROJECT');
  assert.deepEqual(cleanSystemMessage(clean), clean);
  // An unwrapped marker is left alone too; Pi rewrites it to its rendered form on the next run.
  assert.equal(cleanSystemMessage({ role: 'system', content: '', sections: { docs: OMIT_DOCS } }).sections.docs, OMIT_DOCS);
});

test('request cleanup drops the saved marker without treating it as custom docs', () => {
  const section = `<docs>\n${OMIT_DOCS}\n</docs>`;
  const source = [{ role: 'system', content: '', sections: { preamble: 'BASE', docs: section } },
    { role: 'user', content: 'hi' },
    { role: 'system', content: '', sections: { docs: section } },
    { role: 'system', content: '', sections: { project: 'LATER' } }];
  const clean = cleanRequestMessages(source);
  assert.deepEqual(clean.map((message) => message.role), ['system', 'user', 'system']);
  assert.ok(!Object.hasOwn(clean[0].sections, 'docs'));
  assert.equal(clean[1].content, 'hi');
  assert.equal(clean[2].sections.project, 'LATER');
  const custom = [{ role: 'system', content: '', sections: { docs: section } },
    { role: 'system', content: '', sections: { docs: '<docs>PROJECT</docs>' } },
    { role: 'system', content: '', sections: { docs: null } }];
  assert.deepEqual(cleanRequestMessages(custom).slice(1), custom.slice(1));
});

test('request cleanup removes old docs and no-op tombstones without touching user/assistant/tool messages', () => {
  const other = ['user', 'assistant', 'toolResult'].map(role => ({ role, content: nativeDocs }));
  const source = [{ role: 'system', content: 'BASE', sections: { docs: nativeDocs } }, ...other,
    { role: 'system', content: '', sections: { docs: null } }];
  const before = structuredClone(source);
  const clean = cleanRequestMessages(source);
  assert.deepEqual(source, before); assert.equal(clean.length, 4);
  assert.deepEqual(clean[0], { role: 'system', content: 'BASE', sections: {} });
  other.forEach((msg, i) => assert.equal(clean[i + 1], msg));
  const custom = [{ role: 'system', content: 'BASE', sections: { docs: '<docs>PROJECT</docs>' } },
    { role: 'system', content: '', sections: { docs: null } }];
  assert.deepEqual(cleanRequestMessages(custom), custom);
});

test('/pi rejects empty and busy submissions without sending anything', async () => {
  let command; let submissions = 0; const notices = [];
  slim({ on: () => {}, registerCommand: (_name, spec) => { command = spec; }, sendUserMessage: () => { submissions++; } });
  const ctx = { ui: { notify: (...args) => notices.push(args) }, isIdle: () => true };
  await command.handler('   ', ctx);
  await command.handler('request', { ...ctx, isIdle: () => false });
  assert.equal(submissions, 0); assert.equal(notices.length, 2);
});

test('custom docs removed by a later run do not linger in the request', () => using({ after: [pi => {
  let n = 0;
  pi.on('before_agent_start', e => { if (n++ === 0) e.systemPromptOptions.sections.docs = 'PROJECT_DOCS_ONCE'; });
}] }, async f => {
  await f.command('first');
  await f.command('second');
  assert.match(currentText(f.requests[0]), /PROJECT_DOCS_ONCE/);
  assert.doesNotMatch(currentText(f.requests[1]), /PROJECT_DOCS_ONCE/, 'stale custom docs reached the provider');
  noDocs(f.requests);
}));

test('/pi after an ordinary request sends the docs but not the saved omission marker', () => using({}, async f => {
  await f.command('ordinary');
  await f.command('/pi explain extensions');
  assert.match(currentText(f.requests[1]), /Pi documentation/);
  assert.ok(!JSON.stringify(f.requests[1]).includes('pi-slim:omit'), 'marker sent to provider during /pi');
}));
