// Analyse service: a WebSocket in front of a small pool of warm ghūl language
// servers.
//
// The analyser is stateful and that is the point. Warm, it answers an edit in a
// millisecond or two; cold, the first edit pays process start, reflection and a
// full analysis pass. The pool keeps that cost off the user's path by paying it
// in advance.
//
// An analyser is handed to exactly one client and killed when that client goes
// away. The pool holds *fresh* processes, never recycled ones, so pooling does
// not weaken the isolation between sessions: a process a client has touched is
// destroyed, not returned.
//
// The wire protocol is LSP. Over a WebSocket messages are already framed, so
// the Content-Length headers stdio needs are added and stripped here and the
// browser deals in plain JSON-RPC objects.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const { resolveCompiler, resolveReferencePaths } = require('../shared/toolchain');
const { resolveWasmLibraries } = require('../shared/wasm-libraries');
const { Analyser } = require('./analyser');
const { MAX_SOURCE_BYTES } = require('../shared/limits');
const origins = require('../shared/origins');
const tokens = require('../shared/tokens');
const { recordOutcome } = require('../shared/outcomes');

// A session's own outcome line. `kind` says which editor it serves.
const outcome = (repl, fields) => recordOutcome({ service: 'analyse', kind: repl ? 'repl' : 'editor', ...fields });

// Why a session ended, as one of a few fixed words rather than the log line's
// prose.
const END_REASONS = {
    'idle': 'idle',
    'evicted': 'evicted',
    'session lifetime exceeded': 'lifetime',
    'analyser exited': 'analyser-exited',
    'client disconnected': 'client-disconnected',
    'socket error': 'socket-error'
};

const PORT = Number(process.env.PORT ?? 5091);
const HOST = process.env.HOST ?? '127.0.0.1';

// Sessions are the memory budget: a warm analyser holds a few hundred
// megabytes. The pool is kept the same size, so a connecting client normally
// finds one ready.
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 2);
const POOL_SIZE = Number(process.env.POOL_SIZE ?? MAX_SESSIONS);

const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS ?? 5 * 60 * 1000);
const MAX_SESSION_MS = Number(process.env.MAX_SESSION_MS ?? 60 * 60 * 1000);
const WARM_UP_TIMEOUT_MS = Number(process.env.WARM_UP_TIMEOUT_MS ?? 120 * 1000);

// How many sessions one client address may hold. An address at the limit that
// connects again takes the slot of its own least recently active session,
// provided that session has been quiet for EVICT_QUIET_MS: the editor a reader
// has just gone back to is the one they are using, and one they left is not.
// The quiet period stops two editors in use at once, or two people behind one
// address, taking a slot back and forth. When nothing at the address has been
// quiet that long, the new connection is refused instead.
const MAX_SESSIONS_PER_ADDRESS = Number(process.env.MAX_SESSIONS_PER_ADDRESS ?? 4);
const EVICT_QUIET_MS = Number(process.env.EVICT_QUIET_MS ?? 20 * 1000);

// How long a connecting client waits for the pool to produce a warm analyser
// before it gets a cold one instead. A cold analyser still works, it is just
// slow to first diagnostic.
const ACQUIRE_TIMEOUT_MS = Number(process.env.ACQUIRE_TIMEOUT_MS ?? 5000);

const SERVER_COMMAND = process.env.GHUL_LANGUAGE_SERVER ?? 'ghul-language-server';

// Interactive sessions. Off unless set, and off means a `?repl` connection is
// refused rather than served as an ordinary editor. The earlier cells a REPL
// session analyses against are read from the compile service's cache, which
// is mounted here read-only; a client names them by cache key and never
// supplies an assembly.
const REPL_ENABLED = process.env.REPL_ENABLED === '1';
const CELL_CACHE_DIR = process.env.CELL_CACHE_DIR ?? '/cells';
const MAX_CELLS = Number(process.env.MAX_CELLS ?? 50);

// The text being typed is analysed as the next step of the session, under a
// name no cell has.
const REPL_FLAGS = ['--submission', 'input'];

const CELL_KEY = /^[0-9a-f]{64}$/;
const CELL_NAME = /^cell[1-9][0-9]{0,3}$/;

// The client addresses one fixed path and never learns where its workspace
// actually is, so it cannot address anything outside its own session by naming
// a different URI.
const VIRTUAL_ROOT = 'file:///playground';

const log = message => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);

let references = null;
// The command the language server is told to run the compiler as. It is the
// pinned compiler resolved once, at startup, rather than something the server
// is left to hunt for - see createWorkspace.
let compiler = null;

// The library sources a wasm analyser reads in place of the reference
// assemblies, or null where the image has none and every session is .NET.
let wasm = null;

// --- the pool -------------------------------------------------------------

const idle = [];
const waiting = [];
let warming = 0;

function poolState() {
    return { idle: idle.length, warming };
}

function replenish() {
    while (idle.length + warming < POOL_SIZE) {
        warming++;

        const analyser = new Analyser({ command: SERVER_COMMAND, compiler, references, log });

        (async () => {
            try {
                await analyser.start();

                if (!await analyser.warmUp(WARM_UP_TIMEOUT_MS)) {
                    analyser.log('did not warm up, discarding');
                    analyser.kill();
                    return;
                }

                analyser.log('warm');

                // Somebody may already be waiting for one.
                const next = waiting.shift();
                if (next) {
                    next(analyser);
                } else {
                    idle.push(analyser);
                }
            } catch (e) {
                analyser.log(`warm-up failed: ${e.message}`);
                analyser.kill();
            } finally {
                warming--;

                // Only top back up once this attempt has finished, or a
                // failing analyser would spin.
                setTimeout(replenish, 250);
            }
        })();
    }
}

// An analyser started for one client, with nothing warmed in advance, or null
// if it would not start.
async function startCold(otherFlags = [], withReferences = references) {
    const analyser = new Analyser({
        command: SERVER_COMMAND, compiler, references: withReferences, log, otherFlags
    });

    try {
        await analyser.start();
        await analyser.warmUp(WARM_UP_TIMEOUT_MS);

        return analyser;
    } catch (e) {
        log(`cold start failed: ${e.message}`);
        analyser.kill();

        return null;
    }
}

// A warm one if there is one, otherwise wait briefly for the pool, otherwise
// start one cold rather than refusing the client.
function acquire() {
    const warm = idle.shift();

    if (warm) {
        replenish();
        return Promise.resolve(warm);
    }

    return new Promise(resolve => {
        let settled = false;

        const hand = analyser => {
            if (settled) return;
            settled = true;
            resolve(analyser);
        };

        waiting.push(hand);
        replenish();

        setTimeout(async () => {
            if (settled) return;

            const index = waiting.indexOf(hand);
            if (index >= 0) waiting.splice(index, 1);

            log('pool empty, starting a cold analyser');

            hand(await startCold());
        }, ACQUIRE_TIMEOUT_MS);
    });
}

// --- sessions -------------------------------------------------------------

const sessions = new Set();
let nextSessionId = 1;

// CPU seconds the given process has used, or null if it cannot be read - the
// process may have exited between the caller deciding to ask and asking. Fields
// 14 and 15 of /proc/<pid>/stat are user and system time in clock ticks; the
// command name in field 2 can itself contain spaces and brackets, so the split
// starts after the last ')' rather than at the first space.
function cpuSeconds(pid) {
    if (!pid) return null;

    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

        return (Number(fields[11]) + Number(fields[12])) / HERTZ;
    } catch {
        return null;
    }
}

// The kernel reports those times in clock ticks. It is 100 on every Linux this
// runs on, and there is no way to ask for it from node without spawning
// getconf, so it is named here rather than hidden as a bare 100 below.
const HERTZ = 100;

// The address a session is counted against, or null when there is none to
// count by. Behind nginx every connection comes from the proxy - through
// Docker, from the bridge's gateway - so the only usable address is the one
// nginx puts in X-Real-IP, which it sets rather than appends to and so cannot
// be supplied by the client. The port is published on loopback only, so
// nothing but nginx can reach the service to set it. Without the header every
// reader would share one address and one cap, so a connection without it is
// not capped per address at all.
function clientAddress(request) {
    return request.headers['x-real-ip'] || null;
}

// The address's own sessions, least recently active first.
function sessionsFrom(address) {
    return [...sessions]
        .filter(session => session.address === address)
        .sort((a, b) => a.lastActive - b.lastActive);
}

class Session {
    constructor(socket, analyser, address, repl = false) {
        this.id = nextSessionId++;
        this.socket = socket;
        this.analyser = analyser;
        this.address = address;
        this.repl = repl;
        this.closed = false;

        // Replies to the requests the service sends the analyser on the
        // client's behalf, by id. They are answered here, not forwarded.
        this.hostReplies = new Map();

        // What the analyser had already spent being warmed, so that the figure
        // logged on close is the work this client asked for and not the pool's.
        this.startedAt = Date.now();
        this.startCpu = cpuSeconds(analyser.process?.pid);

        this.idleTimer = null;
        this.lifetimeTimer = setTimeout(
            () => this.close('session lifetime exceeded'), MAX_SESSION_MS);

        analyser.onMessage = body => this.fromAnalyser(body);

        this.touch();
    }

    log(message) {
        console.log(`[session ${this.id}] ${message}`);
    }

    // What the session actually cost, for deciding whether MAX_SESSIONS is the
    // right number. Sessions are capped well below one per core on the premise
    // that an editor is idle between keystrokes; this is the measurement that
    // says whether that is true, and how far the cap could move. Read before
    // the analyser is killed, since it comes from that process.
    cost() {
        const endCpu = cpuSeconds(this.analyser.process?.pid);

        if (this.startCpu === null || endCpu === null) return '';

        const wall = (Date.now() - this.startedAt) / 1000;
        const cpu = endCpu - this.startCpu;
        const duty = wall > 0 ? (100 * cpu / wall).toFixed(1) : '0.0';

        return ` (${wall.toFixed(0)}s wall, ${cpu.toFixed(1)}s cpu, ${duty}% duty)`;
    }

    touch() {
        this.lastActive = Date.now();
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close('idle'), IDLE_TIMEOUT_MS);
    }

    fromAnalyser(body) {
        // null means the process died.
        if (body === null) {
            this.close('analyser exited');
            return;
        }

        if (this.hostReplies.size > 0 && body.includes('"host-')) {
            let message = null;

            try {
                message = JSON.parse(body);
            } catch { }

            const waiter = message ? this.hostReplies.get(message.id) : undefined;

            if (waiter) {
                this.hostReplies.delete(message.id);
                waiter(message);
                return;
            }
        }

        // A wasm analyser also reports on the library sources it was started
        // with, which live outside the session's workspace. The reader has no
        // document for them, and passing them on would hand the browser the
        // server's own paths.
        if (body.includes('"textDocument/publishDiagnostics"') && !body.includes(this.analyser.realRoot)) {
            return;
        }

        if (this.socket.readyState === this.socket.OPEN) {
            this.socket.send(body.split(this.analyser.realRoot).join(VIRTUAL_ROOT));
        }
    }

    // The analyser was initialized by the pool, so the opening exchange cannot
    // simply be forwarded: a second initialize is a protocol error, and the
    // document is already open. The first three messages of a session are
    // therefore answered or translated here.
    fromClient(text) {
        let message;

        try {
            message = JSON.parse(text);
        } catch {
            return;
        }

        if (message.method === 'initialize') {
            this.socket.send(JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: this.analyser.capabilities
            }));
            return;
        }

        if (message.method === 'playground/addCells') {
            if (this.repl) this.addCells(message);
            return;
        }

        // The pool has already sent this one.
        if (message.method === 'initialized') return;

        // The document is open with the warm-up source, so the client opening
        // "its" document is really a change to the one already there.
        if (message.method === 'textDocument/didOpen') {
            this.replaceDocument(message.params?.textDocument?.text ?? '');
            return;
        }

        if (message.method === 'textDocument/didChange') {
            const changes = message.params?.contentChanges ?? [];
            const whole = changes[changes.length - 1]?.text;

            if (typeof whole !== 'string') {
                this.log('incremental didChange is not supported; send whole-document changes');
                return;
            }

            // Versions are the analyser's to allocate: the client's numbering
            // starts from its own didOpen and would go backwards against a
            // document the pool already opened.
            this.replaceDocument(whole);
            return;
        }

        this.analyser.write(text.split(VIRTUAL_ROOT).join(this.analyser.realRoot));
    }

    // The earlier cells of an interactive session, named by the cache keys the
    // compile service answered with and the cell names they were compiled
    // under, added to what the text being typed is analysed against. Each is
    // copied from the cache into the analyser's own workspace under its cell's
    // name, which is how a later cell's reference to it is resolved. A key the
    // cache does not hold is refused: this never accepts an assembly from the
    // client.
    async addCells(message) {
        const reply = result => {
            if (message.id !== undefined && this.socket.readyState === this.socket.OPEN) {
                this.socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
            }
        };

        const cells = message.params?.cells;

        if (!Array.isArray(cells) || cells.length === 0 || cells.length > MAX_CELLS ||
            !cells.every(cell => CELL_KEY.test(cell?.key ?? '') && CELL_NAME.test(cell?.name ?? ''))) {
            reply({ message: 'cells must name their cache keys and cell names' });
            return;
        }

        const paths = [];

        for (const { key, name } of cells) {
            try {
                paths.push(await this.analyser.takeCell(
                    path.join(CELL_CACHE_DIR, `${key}.dll`), path.join(key, `${name}.dll`)));
            } catch {
                reply({ message: `${name} is not in the cache` });
                return;
            }
        }

        if (this.closed) return;

        const answer = await new Promise(resolve => this.hostReplies.set(
            this.analyser.request('ghul/addReferences', { uri: this.analyser.documentUri, paths }), resolve));

        reply({ message: answer.error?.message ?? answer.result?.message ?? null });
    }

    // Analysing a document costs a full pass, so an oversized one is declined
    // here for the same reason the compile service declines one. The editor
    // enforces the same limit, so reaching this means something other than the
    // editor is sending it.
    replaceDocument(text) {
        if (text.length > MAX_SOURCE_BYTES) {
            this.log(`declining a ${text.length} byte document; the limit is ${MAX_SOURCE_BYTES}`);
            return;
        }

        this.analyser.replaceDocument(text);
    }

    close(reason) {
        if (this.closed) return;
        this.closed = true;

        clearTimeout(this.idleTimer);
        clearTimeout(this.lifetimeTimer);

        this.log(`closing: ${reason}${this.cost()}`);

        const endCpu = cpuSeconds(this.analyser.process?.pid);

        outcome(this.repl, {
            event: 'ended',
            result: END_REASONS[reason] ?? 'other',
            seconds: Math.round((Date.now() - this.startedAt) / 1000),
            cpu: this.startCpu === null || endCpu === null ? undefined : Number((endCpu - this.startCpu).toFixed(1))
        });

        // The analyser is destroyed rather than returned: a process a client
        // has touched is never handed to another one.
        this.analyser.onMessage = null;
        this.analyser.kill();

        try {
            this.socket.close(1000, reason);
        } catch { /* already gone */ }

        sessions.delete(this);

        replenish();
    }
}

// --- wiring ---------------------------------------------------------------

const server = http.createServer((request, response) => {
    // Always-on: a front end uses this to decide whether to offer editing at
    // all, so it must answer even when every slot is taken. It reports that the
    // service exists, not that a slot is free.
    if (request.url.startsWith('/health')) {
        // Probed cross-origin by whatever page is deciding whether to offer
        // editing at all, so it has to say so. Without this the browser blocks
        // the read and an embedding site concludes there is no back end.
        response.writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': '*'
        });
        response.end(JSON.stringify({
            ok: true,
            sessions: sessions.size,
            maxSessions: MAX_SESSIONS,
            pool: poolState(),
            // Read by the front end so the editor can enforce the same limit
            // the services do, rather than a reader discovering it by having a
            // paste silently do nothing.
            maxSourceBytes: MAX_SOURCE_BYTES,
            // Whether this service serves interactive sessions' analysers, so a
            // page can decide whether to offer the REPL without asking the
            // compile service, whose cell route is rate limited.
            repl: REPL_ENABLED,
            // So a front end can tell whether to ask for a token at all. Asking
            // for one the services do not want is worse than not asking: it
            // reads as a closed door on a service that is open.
            tokensRequired: tokens.required
        }));
        return;
    }

    response.writeHead(404).end('not found');
});

// A connection asking for an interactive session's analyser.
function isRepl(request) {
    return new URL(request.url, 'http://localhost').searchParams.has('repl');
}

// A connection asking for its program to be analysed as the wasm target would
// compile it. Honoured only where the image carries the library sources; an
// analyser for .NET answers otherwise, as every one did before.
function isWasm(request) {
    return wasm !== null &&
        new URL(request.url, 'http://localhost').searchParams.get('target') === 'wasm';
}

// What a wasm analyser is started with: the target, and the library sources
// named on its command line in place of reference assemblies, exactly as the
// compile service compiles for wasm. Started for the client rather than taken
// from the pool, like a REPL session's: about two seconds to a first answer.
// The session outlives any one version of the program, so it carries raster
// whether or not the program uses it yet.
const wasmFlags = () => ['--target', 'wasm', ...(wasm.withRaster ?? wasm).args];

// A browser cannot set headers on a WebSocket, so the token arrives as a
// subprotocol rather than a query parameter, which keeps it out of access logs.
//
// The check has to be in verifyClient, not handleProtocols: declining a
// subprotocol does not refuse the connection, it just leaves the connection
// without one. Rejecting at the upgrade gives the client an HTTP 401 and a
// socket that never opens.
const wss = new WebSocketServer({
    server,
    path: '/analyse',

    // A frame can only ever be an LSP message about a document that is itself
    // capped, so anything materially larger is not a client of ours.
    maxPayload: 4 * MAX_SOURCE_BYTES,

    verifyClient: (info, callback) => {
        if (isRepl(info.req) && !REPL_ENABLED) {
            callback(false, 404, 'not found');
            return;
        }

        // Sessions are a small fixed pool, so a third-party page opening them
        // from its visitors' browsers would deny editing to everyone at no cost
        // to itself. Browsers always send Origin on a WebSocket and cannot
        // forge it; anything that can is answered by the session cap instead.
        if (!origins.accepts(info.req.headers.origin)) {
            log(`refusing connection: origin ${info.req.headers.origin} not allowed`);
            outcome(isRepl(info.req), { event: 'refused', result: 'origin-not-allowed', status: 403 });
            callback(false, 403, 'origin not allowed');
            return;
        }

        const offered = (info.req.headers['sec-websocket-protocol'] ?? '')
            .split(',')
            .map(protocol => protocol.trim())
            .filter(Boolean);

        if (tokens.accepts(tokens.fromSubprotocols(offered))) {
            callback(true);
            return;
        }

        log('refusing connection: invalid or missing access token');
        outcome(isRepl(info.req), { event: 'refused', result: 'unauthorized', status: 401 });
        callback(false, 401, 'invalid or missing access token');
    },

    // Echo the plain marker, never the token-bearing one.
    handleProtocols: protocols => protocols.has('ghul-playground') ? 'ghul-playground' : false
});

wss.on('connection', async (socket, request) => {
    const address = clientAddress(request);
    const mine = address ? sessionsFrom(address) : [];

    if (mine.length >= MAX_SESSIONS_PER_ADDRESS) {
        const quiet = mine.find(session =>
            session.close && Date.now() - session.lastActive >= EVICT_QUIET_MS);

        if (!quiet) {
            log(`refusing connection: ${mine.length}/${MAX_SESSIONS_PER_ADDRESS} sessions ` +
                'from one address, none quiet enough to give up');
            socket.close(1013, 'address limit');
            outcome(isRepl(request), { event: 'refused', result: 'address-limit', status: 1013 });
            return;
        }

        // The client reads this reason as going dormant, like an idle close:
        // it reconnects when its reader next does something, not on a timer.
        quiet.close('evicted');
    }

    if (sessions.size >= MAX_SESSIONS) {
        log(`refusing connection: ${sessions.size}/${MAX_SESSIONS} sessions in use`);
        socket.close(1013, 'try again later');
        outcome(isRepl(request), { event: 'refused', result: 'capacity', status: 1013 });
        return;
    }

    // A client speaks as soon as the socket opens, and an analyser started
    // cold takes seconds to arrive, so what it says meanwhile is kept for the
    // session rather than dropped.
    const early = [];
    const keep = data => early.push(data);
    socket.on('message', keep);

    // Hold the slot while acquiring, so two connections arriving together
    // cannot both pass the checks above. It counts against the address and is
    // never evicted, since nobody has used it yet.
    const placeholder = { closed: false, address, lastActive: Infinity };
    sessions.add(placeholder);

    const repl = isRepl(request);

    // A REPL session's analyser runs in submission mode, which the pool's
    // analysers do not, so it is started for the client.
    let analyser;
    try {
        analyser = repl ? await startCold(REPL_FLAGS)
            : isWasm(request) ? await startCold(wasmFlags(), [])
                : await acquire();
    } finally {
        sessions.delete(placeholder);
    }

    if (!analyser || socket.readyState !== socket.OPEN) {
        analyser?.kill();
        try { socket.close(1011, 'no analyser available'); } catch { }
        outcome(repl, { event: 'refused', result: 'no-analyser', status: 1011 });
        return;
    }

    const session = new Session(socket, analyser, address, repl);
    sessions.add(session);

    outcome(repl, { event: 'started', warm: !!analyser.warm });

    session.log(`${repl ? 'REPL: ' : ''}took analyser ${analyser.id} (${analyser.warm ? 'warm' : 'cold'}), ` +
        `pool now ${JSON.stringify(poolState())}`);

    socket.off('message', keep);
    socket.on('message', data => {
        session.touch();
        session.fromClient(data.toString());
    });

    for (const data of early) session.fromClient(data.toString());

    socket.on('close', () => session.close('client disconnected'));
    socket.on('error', () => session.close('socket error'));
});

(async () => {
    references = await resolveReferencePaths();
    compiler = `dotnet ${await resolveCompiler()}`;
    wasm = await resolveWasmLibraries();

    log(`references: ${references.length}`);
    log(`compiler: ${compiler}`);
    log(wasm
        ? `wasm: ${wasm.libraries.map(l => `${l.name}@${l.version}, ${l.files.length} files`).join('; ')}`
        : 'wasm: off, no library sources configured');

    server.listen(PORT, HOST, () => {
        log(`analyse service on ws://${HOST}:${PORT}/analyse ` +
            `(max ${MAX_SESSIONS} sessions, ${MAX_SESSIONS_PER_ADDRESS} per address, ` +
            `pool ${POOL_SIZE}, idle ${IDLE_TIMEOUT_MS / 1000}s, evictable after ${EVICT_QUIET_MS / 1000}s)`);
        log(tokens.describe());
        log(origins.describe());

        replenish();
    });
})();

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        for (const session of [...sessions]) session.close?.('service shutting down');
        for (const analyser of idle) analyser.kill();
        process.exit(0);
    });
}
