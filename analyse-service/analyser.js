// One ghūl language server process, and the work of getting it warm.
//
// Pre-spawning the process alone buys very little. The language server does
// almost nothing until it is initialized: the compiler is not started, the
// reference assemblies are not reflected, and no analysis pass has run. All of
// that lands on whoever sends the first edit, which is what made the first
// diagnostic in a fresh session cost seconds rather than milliseconds.
//
// So warming means driving the whole opening exchange here - initialize,
// initialized, didOpen - and waiting for the first diagnostics, which is the
// signal that a full pass has completed. By the time a client is given one of
// these, the expensive work is behind it.
//
// The consequence is that the client's own `initialize` cannot be forwarded,
// because the server has already had one. The session answers it from the
// capabilities captured here instead.

const { spawn } = require('child_process');
const { mkdtemp, mkdir, rm, copyFile } = require('fs/promises');
const { tmpdir } = require('os');
const path = require('path');

// The capabilities the front end asks for. Declared once, because the pool
// initializes on the client's behalf: if the client asked for something
// different, it would be negotiating with a server that had already answered
// somebody else's question.
const CLIENT_CAPABILITIES = {
    textDocument: {
        publishDiagnostics: {},
        hover: { contentFormat: ['markdown', 'plaintext'] },
        completion: { completionItem: { snippetSupport: false } }
    }
};

// Warming needs a document that actually exercises the compiler. An empty file
// parses trivially and would leave most of the work for the first real edit.
const WARM_UP_SOURCE = `use IO.Std.write_line;
use Ghul.Pipes;

entry() is
    let warm = [1, 2, 3] |> map(n => n * n) |> Collections.LIST();

    write_line("{warm.count}");
si
`;

let nextId = 1;

class Analyser {
    constructor({ command, compiler, references, log, otherFlags = [] }) {
        this.id = nextId++;
        this.command = command;
        this.compiler = compiler;
        this.references = references;
        this.otherFlags = otherFlags;
        this.log = message => log(`[analyser ${this.id}] ${message}`);

        this.workspace = null;
        this.realRoot = null;
        this.process = null;
        this.buffer = Buffer.alloc(0);

        this.capabilities = null;
        this.warm = false;
        this.dead = false;

        // Set once a client owns this analyser; until then messages from the
        // server are the warm-up exchange and are consumed here.
        this.onMessage = null;

        this.pendingWarmUp = new Map();
        this.warmUpId = 0;
        this.documentVersion = 1;
    }

    // The workspace holds no source and no configuration: the document's text
    // arrives over the protocol, and the compiler, its flags and the
    // restricted reference set go in the initialize request's
    // initializationOptions (see warmUp). The compiler is named rather than
    // left for the server to find, which keeps the analyser on exactly the
    // compiler the compile service uses.
    //
    // The src folder the document's path names is created, empty, because the
    // compiler the playground pins fails to name the namespace of a source
    // whose folder is not on disk. Cells copied in for a session live here too.
    async createWorkspace() {
        this.workspace = await mkdtemp(path.join(tmpdir(), 'ghul-analyse-'));
        this.realRoot = 'file://' + this.workspace;

        await mkdir(path.join(this.workspace, 'src'));
    }

    // Copies a compiled cell into this analyser's own workspace and answers
    // where it now is. A copy rather than the original, because the compile
    // service evicts its cache on its own schedule and the analyser can read a
    // reference again at any rebuild.
    async takeCell(source, name) {
        const destination = path.join(this.workspace, 'cells', name);

        await mkdir(path.dirname(destination), { recursive: true });

        await copyFile(source, destination);

        return destination;
    }

    // Sends a request of the host's own and answers the reply. Only used once a
    // client owns the analyser, so the reply arrives through `onMessage`, which
    // the session routes here by id.
    request(method, params) {
        const id = `host-${++this.warmUpId}`;

        this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

        return id;
    }

    get documentUri() {
        return `${this.realRoot}/src/main.ghul`;
    }

    async start() {
        await this.createWorkspace();

        this.process = spawn(this.command, ['--stdio'], {
            cwd: this.workspace,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.process.on('error', e => {
            this.log(`failed to start: ${e.message}`);
            this.kill();
        });

        this.process.on('exit', code => {
            if (!this.dead) {
                this.log(`exited unexpectedly (${code})`);
                this.dead = true;
                this.onMessage?.(null);
            }
        });

        this.process.stdout.on('data', chunk => this.read(chunk));

        this.process.stderr.on('data', chunk => {
            if (process.env.LOG_SERVER_STDERR) {
                process.stderr.write(`[analyser ${this.id}] ${chunk}`);
            }
        });
    }

    // stdio framing: Content-Length header, blank line, exactly that many bytes
    // of JSON. A chunk can hold part of a message or several.
    read(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        for (;;) {
            const split = this.buffer.indexOf('\r\n\r\n');
            if (split < 0) return;

            const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, split).toString());
            if (!match) {
                this.log('malformed header, dropping buffer');
                this.buffer = Buffer.alloc(0);
                return;
            }

            const length = Number(match[1]);
            const start = split + 4;
            if (this.buffer.length < start + length) return;

            const body = this.buffer.subarray(start, start + length).toString();
            this.buffer = this.buffer.subarray(start + length);

            this.dispatch(body);
        }
    }

    dispatch(body) {
        if (this.onMessage) {
            this.onMessage(body);
            return;
        }

        // Still warming: consume the exchange ourselves.
        let message;
        try {
            message = JSON.parse(body);
        } catch {
            return;
        }

        if (message.id !== undefined && this.pendingWarmUp.has(message.id)) {
            this.pendingWarmUp.get(message.id)(message);
            this.pendingWarmUp.delete(message.id);
        }

        if (message.method === 'textDocument/publishDiagnostics' && this.resolveWarm) {
            this.resolveWarm();
            this.resolveWarm = null;
        }
    }

    write(text) {
        if (this.dead || !this.process?.stdin.writable) return;

        this.process.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    }

    send(method, params, isNotification) {
        const message = { jsonrpc: '2.0', method, params };
        if (!isNotification) message.id = ++this.warmUpId;

        this.write(JSON.stringify(message));

        return message.id;
    }

    requestDuringWarmUp(method, params) {
        return new Promise(resolve => this.pendingWarmUp.set(this.send(method, params), resolve));
    }

    // Drive the opening exchange and wait for the first analysis pass. Resolves
    // false if the analyser died or took too long, in which case the pool
    // discards it rather than handing out something half-started.
    async warmUp(timeoutMs) {
        const firstDiagnostics = new Promise(resolve => { this.resolveWarm = resolve; });

        const initialize = await Promise.race([
            this.requestDuringWarmUp('initialize', {
                processId: null,
                rootUri: this.realRoot,
                workspaceFolders: [{ uri: this.realRoot, name: 'playground' }],
                capabilities: CLIENT_CAPABILITIES,
                initializationOptions: {
                    compiler: this.compiler,
                    compilerFlags: this.otherFlags,
                    references: this.references
                }
            }),
            new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
        ]);

        if (!initialize?.result || this.dead) return false;

        this.capabilities = initialize.result;

        this.send('initialized', {}, true);
        this.send('textDocument/didOpen', {
            textDocument: {
                uri: this.documentUri,
                languageId: 'ghul',
                version: this.documentVersion,
                text: WARM_UP_SOURCE
            }
        }, true);

        const warmed = await Promise.race([
            firstDiagnostics.then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
        ]);

        if (!warmed || this.dead) return false;

        this.warm = true;

        return true;
    }

    // Replace the whole document. Used to hand a warm analyser the client's
    // source: it already has one open, so this is a change rather than an open.
    replaceDocument(text) {
        this.send('textDocument/didChange', {
            textDocument: { uri: this.documentUri, version: ++this.documentVersion },
            contentChanges: [{ text }]
        }, true);
    }

    kill() {
        if (this.dead) return;
        this.dead = true;

        // SIGKILL rather than a polite shutdown: the process is being discarded
        // and a hung analyser must not keep its slot.
        this.process?.kill('SIGKILL');

        if (this.workspace) {
            rm(this.workspace, { recursive: true, force: true })
                .catch(e => this.log(`could not remove workspace: ${e.message}`));
        }
    }
}

module.exports = { Analyser, CLIENT_CAPABILITIES, WARM_UP_SOURCE };
