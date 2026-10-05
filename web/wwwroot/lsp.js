// A small LSP client for the analyse service.
//
// Deliberately not `monaco-languageclient`: Monaco's own provider APIs take
// plain callbacks, so speaking LSP directly is a few hundred lines and avoids
// that library's `@codingame/monaco-vscode-*` dependency chain entirely.
//
// The analyser is expected to go away and be replaced by a fresh one with no
// prior state. Every reconnect therefore re-initializes and re-opens the
// document from scratch, which is cheap because there is only ever one file.

import { AnalyserOutcomes } from './analyser-outcomes.js';
import { hasReader, whenReader } from './engagement.js';

// The bridge maps this onto the session's real workspace, so the browser never
// learns or addresses a server path.
const ROOT_URI = 'file:///playground';
const DOCUMENT_URI = `${ROOT_URI}/src/main.ghul`;

// LSP DiagnosticSeverity -> monaco.MarkerSeverity
const SEVERITY = { 1: 8, 2: 4, 3: 2, 4: 1 };

// The same four, spelled the way the compile service spells them.
const LSP_SEVERITY = { 1: 'error', 2: 'warn', 3: 'info', 4: 'hint' };

// LSP CompletionItemKind -> the name of the monaco.languages.CompletionItemKind
// member for it. The two enumerations number their members differently, and
// Monaco's numbering moves between releases, so the value is looked up by name
// in the Monaco that is loaded.
const COMPLETION_KIND = {
    1: 'Text', 2: 'Method', 3: 'Function', 4: 'Constructor', 5: 'Field',
    6: 'Variable', 7: 'Class', 8: 'Interface', 9: 'Module', 10: 'Property',
    11: 'Unit', 12: 'Value', 13: 'Enum', 14: 'Keyword', 15: 'Snippet',
    16: 'Color', 17: 'File', 18: 'Reference', 19: 'Folder', 20: 'EnumMember',
    21: 'Constant', 22: 'Struct', 23: 'Event', 24: 'Operator', 25: 'TypeParameter'
};

// The token travels as a subprotocol, because a browser cannot set headers on
// a WebSocket and a query parameter would end up in access logs.
const TOKEN_SUBPROTOCOL_PREFIX = 'ghul-playground-token.';

// How long a page can be out of sight before its session is given back. Long
// enough that glancing at another tab does not cost a reconnect, short enough
// that a forgotten tab does not hold a session for the service's whole idle
// timeout.
const HIDDEN_RELEASE_MS = 30000;

export class GhulLanguageClient {
    // `documentText` and `lineOffset` are for an editor showing only the tail
    // of what is analysed, as the REPL input is the last part of its cell: the
    // text to analyse, and how many lines of it come before the editor's first.
    // Diagnostics above the editor are dropped, and positions are moved by the
    // offset each way. `onReady` runs whenever a fresh analyser is ready, which
    // is after every reconnect. `onOutcome` is told what happened to the
    // session, once per episode, for a page that counts it.
    constructor(url, { onStatus, onDiagnostics, getToken, documentText, lineOffset, onReady, onOutcome } = {}) {
        this.url = url;
        this.onStatus = onStatus ?? (() => { });
        this.onDiagnostics = onDiagnostics ?? (() => { });
        this.getToken = getToken ?? (() => null);
        this.documentText = documentText ?? (() => this.model?.getValue() ?? '');
        this.lineOffset = lineOffset ?? (() => 0);
        this.onReady = onReady ?? (() => { });

        this.outcomes = new AnalyserOutcomes(onOutcome ?? (() => { }));

        this.socket = null;
        this.connected = false;
        this.initialized = false;

        this.nextId = 0;
        this.pending = new Map();
        this.version = 0;

        // The server's semantic-token legend, learned from the initialize
        // result. Monaco needs it to interpret the token stream.
        this.semanticTokensLegend = null;

        this.model = null;
        this.reconnectDelay = 1000;
        this.disposed = false;

        // Set when the service closed the session for idleness. Reconnecting
        // straight away would defeat the reaping entirely: the slot would be
        // handed back to the same idle editor, and a couple of forgotten tabs
        // would hold every session there is. The next thing the reader does
        // wakes it.
        this.dormant = false;

        // Set while this client is closing its own socket to give the
        // session back, so the close is read as going dormant rather than
        // as a fault to retry.
        this.releasing = false;

        // Set while a type probe has swapped the document out, so what the
        // analyser reports about the probe is not shown on the input.
        this.probing = false;

        // Set when the last attempt was turned away because this address
        // already holds as many sessions as it may. Retried on the timer,
        // and also on the reader's next move, which is usually just after
        // they have closed another editor.
        this.refused = false;

        this.retryTimer = null;
        this.hiddenTimer = null;

        // Set while a connect is waiting for the page to have a reader.
        this.waitingForReader = false;

        this.onVisibility = () => {
            clearTimeout(this.hiddenTimer);

            if (document.hidden) {
                this.hiddenTimer = setTimeout(() => this.release(), HIDDEN_RELEASE_MS);
            } else {
                this.wake();
            }
        };

        document.addEventListener('visibilitychange', this.onVisibility);
    }

    // Whether queries are worth making. Callers use this to decide between
    // asking the analyser and doing without.
    get ready() {
        return this.connected && this.initialized;
    }

    attach(model) {
        this.model = model;
        this.connect();
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.retryTimer);
        clearTimeout(this.hiddenTimer);
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.socket?.close();
    }

    // Gives the session back while the page is out of sight, going dormant
    // exactly as an idle close from the service does. Coming back into view
    // or the next thing the reader does reconnects.
    release() {
        if (this.disposed || !this.socket || this.socket.readyState === WebSocket.CLOSED) return;

        this.releasing = true;
        clearTimeout(this.retryTimer);
        this.socket.close();
    }

    // Drop the current connection and try again now. Used after a token is
    // entered: the previous attempt was refused at the handshake, and the
    // backoff would otherwise leave the editor waiting for up to a minute.
    reconnect() {
        this.reconnectDelay = 1000;

        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
            // The close handler schedules the retry.
            this.socket.close();
            return;
        }

        this.connect();
    }

    // Moves the session to another address - the same service asked for an
    // analyser of another target - dropping the current one, whose answers
    // describe what the program means on the target it was opened for.
    setUrl(url) {
        if (url === this.url) return;

        this.url = url;
        this.reconnect();
    }

    connect() {
        if (this.disposed) return;

        // A page nobody is reading waits too. A session is the expensive
        // thing a visitor costs, and a renderer that never interacts would
        // hold one for as long as it stayed on the page.
        if (!hasReader()) {
            // Once, however many times a retry or a token entry asks: each
            // wait would otherwise become its own connect when the reader
            // arrives.
            if (!this.waitingForReader) {
                this.waitingForReader = true;

                whenReader().then(() => {
                    this.waitingForReader = false;
                    this.connect();
                });
            }

            return;
        }

        // A page out of sight waits to be looked at rather than taking a
        // session: a retry timer or a background tab would otherwise hand
        // one to an editor nobody is using.
        if (document.hidden) {
            this.dormant = true;
            this.refused = false;
            this.onStatus('dormant');
            return;
        }

        clearTimeout(this.retryTimer);
        this.onStatus('connecting');

        const token = this.getToken();

        let socket;
        try {
            socket = new WebSocket(this.url, token
                ? ['ghul-playground', TOKEN_SUBPROTOCOL_PREFIX + token]
                : ['ghul-playground']);
        } catch {
            this.scheduleReconnect();
            return;
        }

        this.socket = socket;

        let opened = false;

        socket.addEventListener('open', () => {
            opened = true;
            this.refused = false;
            this.connected = true;
            this.reconnectDelay = 1000;
            this.initialize();
        });

        socket.addEventListener('message', event => this.receive(JSON.parse(event.data)));

        socket.addEventListener('close', async event => {
            const wasReady = this.initialized;

            this.connected = false;
            this.initialized = false;

            // The service says why - idle, or given to another editor from
            // the same address - or this client gave the session back itself.
            // Anything else is a fault and is retried.
            this.dormant = this.releasing || event.reason === 'idle' || event.reason === 'evicted';
            this.releasing = false;

            // Any in-flight request will never be answered now.
            for (const resolve of this.pending.values()) resolve(null);
            this.pending.clear();

            // Report every failure, including one that never got as far as
            // being ready. Reporting only the ready-then-lost case leaves a
            // service that was never reachable showing "connecting" for ever,
            // which reads as a hung client rather than an absent server.
            if (this.dormant) {
                this.onStatus('dormant');
                return;
            }

            // A handshake that failed says nothing about why. Being over the
            // per-address limit is worth telling apart from the service being
            // down, because the reader can do something about it.
            this.refused = event.reason === 'address limit' || (!opened && await this.overLimit());

            if (this.disposed || this.socket !== socket) return;

            this.outcomes.failed(this.refused ? 'refused' : wasReady ? 'dropped' : 'unavailable');

            this.onStatus(this.refused ? 'refused' : 'disconnected');
            this.scheduleReconnect();
        });

        socket.addEventListener('error', () => { /* close follows */ });
    }

    // The proxy answers an ordinary request to the same path with 429 when
    // this address already holds all the connections it may, which a
    // WebSocket handshake has no way to report.
    async overLimit() {
        try {
            const response = await fetch(this.url.replace(/^ws/, 'http'), { cache: 'no-store' });
            return response.status === 429;
        } catch {
            return false;
        }
    }

    scheduleReconnect() {
        if (this.disposed) return;

        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), this.reconnectDelay);
        // Back off to a minute: a service that is down stays down for a while,
        // and a tab left open should not hammer it.
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
    }

    send(method, params, isNotification) {
        if (!this.connected) return null;

        const message = { jsonrpc: '2.0', method, params };
        if (!isNotification) message.id = ++this.nextId;

        this.socket.send(JSON.stringify(message));

        return message.id ?? null;
    }

    request(method, params) {
        const id = this.send(method, params);
        if (id === null) return Promise.resolve(null);

        return new Promise(resolve => {
            this.pending.set(id, resolve);

            // A query that never comes back must not leave the editor waiting.
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    resolve(null);
                }
            }, 10000);
        });
    }

    async initialize() {
        const initialized = await this.request('initialize', {
            processId: null,
            rootUri: ROOT_URI,
            workspaceFolders: [{ uri: ROOT_URI, name: 'playground' }],
            capabilities: {
                textDocument: {
                    publishDiagnostics: {},
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    completion: { completionItem: { snippetSupport: false } }
                }
            }
        });

        if (!this.connected) return;

        const provider = initialized?.result?.capabilities?.semanticTokensProvider;
        if (provider?.legend) this.semanticTokensLegend = provider.legend;

        this.send('initialized', {}, true);

        this.version = 1;
        this.send('textDocument/didOpen', {
            textDocument: {
                uri: DOCUMENT_URI,
                languageId: 'ghul',
                version: this.version,
                text: this.documentText()
            }
        }, true);

        this.initialized = true;
        this.outcomes.ready();
        this.onStatus('ready');
        this.onReady();
    }

    // Whole-document sync. The bridge mirrors it to disk for the analyser, and
    // one file is small enough that computing deltas would buy nothing.
    changed(text) {
        if (this.wake()) return;
        if (!this.ready) return;

        // A probe puts the input's latest text back when it finishes.
        if (this.probing) return;

        this.send('textDocument/didChange', {
            textDocument: { uri: DOCUMENT_URI, version: ++this.version },
            contentChanges: [{ text }]
        }, true);
    }

    receive(message) {
        if (message.id !== undefined && this.pending.has(message.id)) {
            this.pending.get(message.id)(message);
            this.pending.delete(message.id);
            return;
        }

        if (message.method === 'textDocument/publishDiagnostics') {
            // What a type probe reports is about the probe, not the input;
            // that it arrived says the probe has been analysed.
            if (this.probing) {
                this.probeAnalysed?.();
                return;
            }

            this.publishDiagnostics(message.params?.diagnostics ?? []);
        }
    }

    publishDiagnostics(all) {
        if (!this.model) return;

        const offset = this.lineOffset();

        const diagnostics = all
            .filter(d => d.range.start.line >= offset)
            .map(d => ({
                ...d,
                range: {
                    start: { line: d.range.start.line - offset, character: d.range.start.character },
                    end: { line: d.range.end.line - offset, character: d.range.end.character }
                }
            }));

        // Reported in the same shape the compile service produces, so a
        // consumer can show either without knowing which it has.
        this.onDiagnostics(diagnostics.map(d => ({
            startLine: d.range.start.line + 1,
            startColumn: d.range.start.character + 1,
            endLine: d.range.end.line + 1,
            endColumn: d.range.end.character + 1,
            severity: LSP_SEVERITY[d.severity] ?? 'error',
            message: d.message
        })));

        monaco.editor.setModelMarkers(this.model, 'ghul-analyse', diagnostics.map(d => ({
            // LSP counts lines and characters from zero; Monaco counts from one.
            startLineNumber: d.range.start.line + 1,
            startColumn: d.range.start.character + 1,
            endLineNumber: d.range.end.line + 1,
            endColumn: d.range.end.character + 1,
            message: d.message,
            severity: SEVERITY[d.severity] ?? 8
        })));
    }

    // Reconnect on the reader's next move, and report that this attempt found
    // nothing rather than waiting for the socket.
    wake() {
        if (!this.dormant && !this.refused) return false;

        this.dormant = false;
        this.refused = false;
        this.reconnectDelay = 1000;
        this.connect();

        return true;
    }

    async hover(position) {
        if (this.wake()) return null;
        if (this.probing) return null;
        const result = await this.request('textDocument/hover', {
            textDocument: { uri: DOCUMENT_URI },
            position: { line: position.lineNumber - 1 + this.lineOffset(), character: position.column - 1 }
        });

        const contents = result?.result?.contents;
        if (!contents) return null;

        const value = typeof contents === 'string'
            ? contents
            : Array.isArray(contents)
                ? contents.map(c => (typeof c === 'string' ? c : c.value)).join('\n\n')
                : contents.value;

        return value ? { contents: [{ value }] } : null;
    }

    // What hover says about the name at a zero-based line and character of
    // `source`, a document other than the input's: the document is swapped
    // for `source` for the one request, and the input's put back after it.
    async hoverIn(source, line, character) {
        if (!this.ready || this.probing) return null;

        this.probing = true;

        try {
            // The server analyses an edit after answering what came before
            // it, so the hover waits for the probe's diagnostics, which say
            // the probe has been analysed.
            const analysed = new Promise(resolve => {
                this.probeAnalysed = resolve;
                setTimeout(resolve, 10000);
            });

            this.send('textDocument/didChange', {
                textDocument: { uri: DOCUMENT_URI, version: ++this.version },
                contentChanges: [{ text: source }]
            }, true);

            await analysed;

            // The diagnostics waited for can be the input's, published just
            // before the swap, and the service renumbers versions, so there
            // is nothing to tell them apart by: a hover that comes back
            // empty is asked again for a little while.
            let contents = null;

            for (let attempt = 0; attempt < 12 && !contents; attempt++) {
                if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 250));

                const result = await this.request('textDocument/hover', {
                    textDocument: { uri: DOCUMENT_URI },
                    position: { line, character }
                });

                contents = result?.result?.contents;
            }

            if (!contents) return null;

            return typeof contents === 'string'
                ? contents
                : Array.isArray(contents)
                    ? contents.map(c => (typeof c === 'string' ? c : c.value)).join('\n\n')
                    : contents.value ?? null;
        } finally {
            this.send('textDocument/didChange', {
                textDocument: { uri: DOCUMENT_URI, version: ++this.version },
                contentChanges: [{ text: this.documentText() }]
            }, true);

            this.probing = false;
            this.probeAnalysed = null;
        }
    }

    // Whole-document semantic tokens. LSP and Monaco use the same relative
    // five-integer encoding, so the data passes through untouched; only the
    // container type differs.
    async semanticTokens() {
        if (this.wake()) return null;
        if (!this.ready || !this.semanticTokensLegend) return null;

        const result = await this.request('textDocument/semanticTokens/full', {
            textDocument: { uri: DOCUMENT_URI }
        });

        const data = result?.result?.data;
        if (!Array.isArray(data)) return null;

        return { data: new Uint32Array(data) };
    }

    // Narrowing hints: the ghost text the editor shows where a value is
    // narrowed or a narrowing is dropped. The site already renders these on a
    // static example, so an editor without them looks less informative than
    // the thing it replaced.
    async inlayHints(range) {
        if (this.wake()) return [];
        if (!this.ready) return [];

        const result = await this.request('textDocument/inlayHint', {
            textDocument: { uri: DOCUMENT_URI },
            range: {
                start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
            }
        });

        const hints = result?.result;

        return Array.isArray(hints) ? hints : [];
    }

    // `context` is Monaco's completion context. The server needs to know when
    // a `.` asked for completion: that is what makes the request a member
    // completion, and what makes it wait for the analyser to have seen the dot.
    async completion(position, context) {
        if (this.wake()) return [];

        const triggerCharacter = context?.triggerCharacter;

        const result = await this.request('textDocument/completion', {
            textDocument: { uri: DOCUMENT_URI },
            position: { line: position.lineNumber - 1 + this.lineOffset(), character: position.column - 1 },
            context: triggerCharacter ? { triggerKind: 2, triggerCharacter } : { triggerKind: 1 }
        });

        const raw = result?.result;
        const items = Array.isArray(raw) ? raw : raw?.items ?? [];

        return items.map(item => ({
            label: item.label,
            kind: monaco.languages.CompletionItemKind[COMPLETION_KIND[item.kind]] ?? monaco.languages.CompletionItemKind.Text,
            insertText: item.insertText ?? item.label,
            detail: item.detail,
            documentation: typeof item.documentation === 'object'
                ? item.documentation.value
                : item.documentation,
            sortText: item.sortText
        }));
    }
}

export { DOCUMENT_URI };
