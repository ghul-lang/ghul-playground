// Compile service for the ghūl playground.
//
// SECURITY: run this in the container. It runs the ghūl compiler on whatever it
// is posted, and its own limits - a source size cap, a compile timeout and a
// cap on how many compile at once - bound what one request costs, not what the
// compiler can reach. The container is what does that.
//
//   POST /compile  {"source": "...", "target": "dotnet"|"wasm"}
//     -> {"ok": bool, "diagnostics": [...], "assembly": "<base64>"|null}
//
//   POST /compile/view  {"source": "...", "target": "dotnet"|"wasm", "scope": "program"|"all"}
//     -> {"ok": true, "target", "language": "il"|"wat", "text": "...", "lines": [...],
//         "truncated": bool, "omitted": n, "cached": bool}
//     ("omitted" counts the library functions a wasm view of scope "program"
//     leaves out; IL has none to leave out)
//     or {"ok": false, "target", "diagnostics": [...], "cached": bool}
//
//   POST /compile/view  {"source": "...", "target": "llvm", "view": "llvm-ir"|"x86-asm", "scope": ..., "optimise": 0|2}
//     -> as above, with "language": "llvm-ir"|"x86-asm", counting the functions
//     a view of scope "program" leaves out in "omitted". "optimise", 2 unless
//     given, is the level both are built at. Offered only where GHUL_LLVM
//     names ghul-llvm and the wasm libraries are present, and nothing
//     compiled for llvm is run.
//
//   The compiled code as text, built by a compile of its own only when asked
//   for, so a POST /compile never pays for it. See view.js.
//
//   GET /compile
//     -> {"targets": [...], "views": [...]}, what a compile and a view may ask for.
//
//   with "target": "wasm"
//     -> {"ok": bool, "diagnostics": [...], "module": "<base64>"|null,
//         "loader": "<the loader's JavaScript>"|null}
//
// `target` defaults to "dotnet". The assembly or module is returned to the
// browser, which runs it. The service never executes what it compiles.

const http = require('http');
const { execFile } = require('child_process');
const { mkdtemp, writeFile, readFile, rm } = require('fs/promises');
const { tmpdir } = require('os');
const path = require('path');

const { resolveCompiler, resolveReferencePaths } = require('../shared/toolchain');
const { resolveWasmLibraries, usesRaster } = require('../shared/wasm-libraries');
const { MAX_SOURCE_BYTES } = require('../shared/limits');
const origins = require('../shared/origins');
const tokens = require('../shared/tokens');
const { recordOutcome } = require('../shared/outcomes');
const cells = require('./cells');
const results = require('./results');
const view = require('./view');

const PORT = Number(process.env.PORT ?? 5090);
const HOST = process.env.HOST ?? '127.0.0.1';

const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS ?? 10000);

// A compile costs about a CPU-second and peaks near 200 MB, so the number that
// may run at once is the service's real resource limit. Without one, enough
// simultaneous requests drive the container into its memory cap, the kernel
// kills compilers, and every request in flight fails: measured, thirty at once
// was enough. A queue turns that into waiting, which is a far better failure.
//
// The queue is deliberately short. Past its end the honest answer is that the
// service is busy, not a request that waits a minute and then times out.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_COMPILES ?? 2);
const MAX_QUEUED = Number(process.env.MAX_QUEUED_COMPILES ?? 6);

// The cells of an interactive session (see cells.js) are served only where
// this is set: with it unset the endpoint does not exist, whatever a page asks
// for. A cell request carries the source of every cell before it, so it has
// limits of its own on the number of cells and their total size.
const REPL_ENABLED = process.env.REPL_ENABLED === '1';
const MAX_CELLS = Number(process.env.MAX_CELLS ?? 50);
const MAX_CHAIN_BYTES = Number(process.env.MAX_CHAIN_BYTES ?? 256 * 1024);
const CELL_CACHE_DIR = process.env.CELL_CACHE_DIR ?? path.join(tmpdir(), 'ghul-cells');
const CELL_CACHE_BYTES = Number(process.env.CELL_CACHE_BYTES ?? 64 * 1024 * 1024);

// The same for one-shot compiles. Sized larger than the cells cache because a
// result holds the assembly as base64 rather than as bytes, and because the
// corpus it is mostly answering for is a few hundred programs.
const RESULT_CACHE_DIR = process.env.RESULT_CACHE_DIR ?? path.join(tmpdir(), 'ghul-results');
const RESULT_CACHE_BYTES = Number(process.env.RESULT_CACHE_BYTES ?? 128 * 1024 * 1024);

// The disassembler the assembly view runs, installed beside the compiler in
// the image.
const ILSPYCMD = process.env.ILSPYCMD ?? 'ilspycmd';

// What an llvm view optimises and writes assembly with: ghul-llvm, at the
// release the compiler names in its requirements.json. Without GHUL_LLVM
// there is no llvm view.
const GHUL_LLVM = process.env.GHUL_LLVM ?? null;
const GHUL_LLVM_VERSION = process.env.GHUL_LLVM_VERSION ?? 'unknown';

// The two listings an llvm view can be.
const LLVM_VIEWS = new Set(['llvm-ir', 'x86-asm']);

// The request body as JSON can be up to six times its source when every
// character needs escaping, plus the names and punctuation around each cell.
const MAX_CELL_REQUEST_BYTES = MAX_CHAIN_BYTES * 6 + MAX_CELLS * 64;

// `file: LINE,COL..LINE,COL: severity: message`
const DIAGNOSTIC = /^(.*?):\s*(\d+),(\d+)\.\.(\d+),(\d+):\s*(error|warn|info|hint):\s*(.*)$/;

let toolchain = null;

async function getToolchain() {
    if (!toolchain) {
        const [compiler, references, wasm] = await Promise.all([
            resolveCompiler(), resolveReferencePaths(), resolveWasmLibraries()
        ]);

        toolchain = { compiler, references, wasm };

        console.log(`compiler:   ${compiler}`);
        console.log(`references: ${references.length}`);
        console.log(wasm
            ? `wasm:       ${(wasm.withRaster ?? wasm).libraries.map(l => `${l.name}@${l.version}, ${l.files.length} files`).join('; ')}`
            : 'wasm:       off, no library sources configured');
    }

    return toolchain;
}

// The target a request names, checked before it waits for a slot. llvm is a
// view's target only: nothing runs natively in the browser.
async function requestedTarget(target, { view = false } = {}) {
    if (target === undefined || target === null || target === 'dotnet') {
        return 'dotnet';
    }

    if (target === 'llvm' && view) {
        if (!GHUL_LLVM || !(await getToolchain()).wasm) {
            throw new cells.BadRequest(400, 'the llvm target is not available here');
        }

        return 'llvm';
    }

    if (target !== 'wasm') {
        throw new cells.BadRequest(400, `unknown target ${JSON.stringify(target)}`);
    }

    if (!(await getToolchain()).wasm) {
        throw new cells.BadRequest(400, 'the wasm target is not available here');
    }

    return 'wasm';
}

function parseDiagnostics(text) {
    const diagnostics = [];

    for (const line of text.split('\n')) {
        const m = DIAGNOSTIC.exec(line.trim());

        if (m) {
            diagnostics.push({
                startLine: +m[2], startColumn: +m[3],
                endLine: +m[4], endColumn: +m[5],
                severity: m[6],
                message: m[7]
            });
        }
    }

    return diagnostics;
}

// The compiler runs as the head of its own process group, and a timeout kills
// the whole group: an llvm build hands its module to ghul-llvm, which has no
// timeout of its own and would outlive a compiler killed alone. A timeout is
// reported as execFile reports its own, with error.killed set.
function runCompiler(args, cwd, env = null) {
    return new Promise(resolve => {
        let timedOut = false;

        const child = execFile('dotnet', args,
            { cwd, detached: true, maxBuffer: 4 << 20, ...(env ? { env: { ...process.env, ...env } } : {}) },
            (error, stdout, stderr) => {
                clearTimeout(timer);

                if (timedOut) {
                    error ??= new Error('the compiler timed out');
                    error.killed = true;
                }

                resolve({ error, stdout, stderr });
            });

        const timer = setTimeout(() => {
            timedOut = true;

            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                // the group has already gone
            }
        }, COMPILE_TIMEOUT_MS);
    });
}

// --- the concurrency gate -------------------------------------------------

class Busy extends Error { }

let running = 0;
const queue = [];

function acquireSlot() {
    if (running < MAX_CONCURRENT) {
        running++;
        return Promise.resolve();
    }

    if (queue.length >= MAX_QUEUED) {
        return Promise.reject(new Busy());
    }

    return new Promise(resolve => queue.push(resolve));
}

function releaseSlot() {
    // Hand the slot straight to whoever is next rather than releasing and
    // reacquiring it, so `running` stays accurate with no window in between.
    const next = queue.shift();

    if (next) {
        next();
        return;
    }

    running--;
}

async function withSlot(work) {
    await acquireSlot();

    try {
        return await work();
    } finally {
        releaseSlot();
    }
}

let cellState = null;

// The cache and the identity of the toolchain it is keyed on, made once, on
// the first cell request; requests arriving together share the one promise.
function getCellState() {
    cellState ??= (async () => {
        const { compiler, references } = await getToolchain();

        return {
            cache: await new cells.CellCache(CELL_CACHE_DIR, CELL_CACHE_BYTES).init(),
            toolchainId: await cells.toolchainIdentity({
                compiler, references, flags: ['--compile-server'],
                salt: process.env.CELL_TOOLCHAIN_SALT
            })
        };
    })();

    return cellState;
}

async function compileCell(request) {
    const toolchain = await getToolchain();
    const { cache, toolchainId } = await getCellState();
    const directory = await mkdtemp(path.join(tmpdir(), 'ghul-playground-cell-'));

    const keys = cells.chainKeys(toolchainId, request);

    try {
        const result = await cells.compileCells({
            cells: request, keys, cache, toolchain, directory,
            timeoutMs: COMPILE_TIMEOUT_MS
        });

        // The keys are how the page later names these cells to the analyse
        // service. Knowing one gives nothing but the assembly this service
        // built from the sources that hash to it.
        return result.ok ? { ...result, keys } : result;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

let resultState = null;

// The result cache and the toolchain identity of each target it is keyed on,
// made once on the first compile; requests arriving together share the one
// promise, as the cells cache does. A wasm build reads the library sources
// rather than the reference assemblies, so its identity hashes those, and the
// two targets never share a key. Whether raster is among them is decided by
// the source, which is the rest of the key, so one identity covers both.
function getResultState() {
    resultState ??= (async () => {
        const { compiler, references, wasm } = await getToolchain();
        const salt = process.env.RESULT_TOOLCHAIN_SALT;

        return {
            cache: await new results.ResultCache(RESULT_CACHE_DIR, RESULT_CACHE_BYTES).init(),
            toolchainIds: {
                dotnet: await cells.toolchainIdentity({ compiler, references, flags: [], salt }),
                wasm: wasm
                    ? await cells.toolchainIdentity({
                        compiler,
                        references: (wasm.withRaster ?? wasm).libraries.flatMap(l => l.files),
                        flags: ['--target', 'wasm', ...(wasm.withRaster ?? wasm).libraries.map(l => `${l.name}@${l.version}`)],
                        salt
                    })
                    : null,
                // An llvm view builds against the same library sources as
                // wasm, and is linked by ghul-llvm, so its version is part
                // of the identity.
                llvm: wasm && GHUL_LLVM
                    ? await cells.toolchainIdentity({
                        compiler,
                        references: (wasm.withRaster ?? wasm).libraries.flatMap(l => l.files),
                        flags: ['--target', 'llvm', `ghul-llvm@${GHUL_LLVM_VERSION}`,
                            ...(wasm.withRaster ?? wasm).libraries.map(l => `${l.name}@${l.version}`)],
                        salt
                    })
                    : null
            }
        };
    })();

    return resultState;
}

// What the source compiles to, from the cache where it has been compiled
// before. A compile is a function of the source, the target and the
// toolchain, so the answer does not depend on who asked or when.
async function compile(source, target = 'dotnet') {
    const { cache, toolchainIds } = await getResultState();

    return cache.answer(results.resultKey(toolchainIds[target], source),
        () => compileUncached(source, target));
}

// The compiler's arguments for `source`, written to main.ghul in `directory`.
function compilerArguments({ compiler, references, wasm }, directory, target, source) {
    const args = [compiler];

    if (target === 'wasm') {
        const libraries = wasm.withRaster && usesRaster(source) ? wasm.withRaster : wasm;

        args.push('--target', 'wasm', ...libraries.args,
            '-o', path.join(directory, 'main.wasm'));
    } else {
        for (const reference of references) {
            args.push('-a', reference);
        }
    }

    args.push(path.join(directory, 'main.ghul'));

    return args;
}

// The built program: the assembly, or the module and the loader the compiler
// writes beside it, which is how a page runs that module.
async function readOutput(directory, target) {
    if (target === 'wasm') {
        const [module, loader] = await Promise.all([
            readFile(path.join(directory, 'main.wasm')),
            readFile(path.join(directory, 'main.mjs'), 'utf8')
        ]);

        return { module: module.toString('base64'), loader };
    }

    return { assembly: (await readFile(path.join(directory, 'main.exe'))).toString('base64') };
}

// What a failed compile carries in place of the program.
function noOutput(target) {
    return target === 'wasm' ? { module: null, loader: null } : { assembly: null };
}

async function compileUncached(source, target = 'dotnet') {
    const toolchain = await getToolchain();
    const directory = await mkdtemp(path.join(tmpdir(), 'ghul-playground-'));
    const none = noOutput(target);

    try {
        await writeFile(path.join(directory, 'main.ghul'), source, 'utf8');

        const args = compilerArguments(toolchain, directory, target, source);

        const { error, stdout, stderr } = await runCompiler(args, directory);
        const diagnostics = parseDiagnostics(`${stderr}\n${stdout}`);

        if (error) {
            // Killed at the timeout, whether or not it had said anything
            // first. What it managed to report before it died is not the
            // whole answer about the source, so this is flagged either way
            // and nothing keeps it.
            if (error.killed && diagnostics.length) {
                return { ok: false, diagnostics, ...none, timedOut: true };
            }

            // The compiler reported nothing and did not run to completion: it
            // failed to start, or was killed by something other than the
            // timeout. That says nothing about the source either.
            if (!error.killed && !diagnostics.length) {
                return { ok: false, diagnostics, ...none, failed: true };
            }

            // A timeout kills the compiler without it reporting anything, so
            // say so rather than returning an empty, puzzling failure.
            if (error.killed && !diagnostics.length) {
                diagnostics.push({
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
                    severity: 'error',
                    message: `compilation timed out after ${COMPILE_TIMEOUT_MS} ms`
                });

                // Said in a field as well as in the diagnostic, so a caller can
                // tell a timeout from a program that does not compile without
                // matching on the wording of a message meant for a reader.
                return { ok: false, diagnostics, ...none, timedOut: true };
            }

            return { ok: false, diagnostics, ...none };
        }

        return { ok: true, diagnostics, ...await readOutput(directory, target) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// The compiled code of `source` as text, from the cache where it has been
// viewed before. Keyed apart from the compile a Run asks for, which it never
// replaces: the view is a separate build, with debug information on.
async function compileView(source, target, scope, language, optimise = 2) {
    const { cache, toolchainIds } = await getResultState();
    const level = target === 'llvm' ? `:O${optimise}` : '';
    const key = `${toolchainIds[target]}:view${target === 'llvm' ? `:${language}` : ''}${level}${scope === 'all' ? ':all' : ''}`;

    return cache.answer(results.resultKey(key, source), () => compileViewUncached(source, target, scope, language, optimise));
}

async function compileViewUncached(source, target, scope = 'program', language = null, optimise = 2) {
    if (target === 'wasm') {
        return compileWatView(source, scope);
    }

    if (target === 'llvm') {
        return compileLlvmView(source, scope, language, optimise);
    }

    const toolchain = await getToolchain();
    const directory = await mkdtemp(path.join(tmpdir(), 'ghul-playground-view-'));

    try {
        await writeFile(path.join(directory, 'main.ghul'), source, 'utf8');

        const args = [...compilerArguments(toolchain, directory, target, source)];
        args.splice(1, 0, '--debug');

        const { error, stdout, stderr } = await runCompiler(args, directory);
        const diagnostics = parseDiagnostics(`${stderr}\n${stdout}`);

        if (error) {
            const timedOut = !!error.killed;
            const failed = !error.killed && !diagnostics.length;

            return { ok: false, target, diagnostics, ...(timedOut ? { timedOut } : {}), ...(failed ? { failed } : {}) };
        }

        const listing = await view.disassemble(ILSPYCMD, path.join(directory, 'main.exe'), COMPILE_TIMEOUT_MS);

        return {
            ok: true, target, language: 'il',
            ...view.shapeListing(listing, path.basename(directory)),
            omitted: 0
        };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// The WAT the compiler prints for `source`, with each statement's source line
// marked. Compiled from the bare name main.ghul in its directory, so the
// positions name that rather than a temporary path. The program's own
// functions only, unless `scope` asks for the whole module.
async function compileWatView(source, scope) {
    const { compiler, wasm } = await getToolchain();
    const directory = await mkdtemp(path.join(tmpdir(), 'ghul-playground-view-'));

    try {
        await writeFile(path.join(directory, 'main.ghul'), source, 'utf8');

        const libraries = wasm.withRaster && usesRaster(source) ? wasm.withRaster : wasm;
        const args = [compiler, '--target', 'wasm', ...libraries.args,
            '--wat', 'main.wat', '--wat-lines',
            ...(scope === 'all' ? [] : ['--wat-program-only']),
            '-o', 'main.wasm', 'main.ghul'];

        const { error, stdout, stderr } = await runCompiler(args, directory);
        const diagnostics = parseDiagnostics(`${stderr}\n${stdout}`);

        if (error) {
            const timedOut = !!error.killed;
            const failed = !error.killed && !diagnostics.length;

            return { ok: false, target: 'wasm', diagnostics, ...(timedOut ? { timedOut } : {}), ...(failed ? { failed } : {}) };
        }

        const wat = await readFile(path.join(directory, 'main.wat'), 'utf8');

        return { ok: true, target: 'wasm', language: 'wat', ...view.shapeWat(wat, 'main.ghul') };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// The program as LLVM IR or as x86-64 assembly, at `optimise`, 2 for what
// `ghul build` makes or 0 for one function per method with every line
// marked. The compiler writes the whole module with its debug information;
// ghul-llvm turns that into optimised IR or into assembly, and an unoptimised
// IR listing is the compiler's own. The compiler still links an executable
// beside the module, which nothing uses and nothing runs. The program's own
// functions are those holding its code, read from the IR at the same level,
// unless `scope` asks for everything.
async function compileLlvmView(source, scope, language, optimise = 2) {
    const { compiler, wasm } = await getToolchain();
    const directory = await mkdtemp(path.join(tmpdir(), 'ghul-playground-view-'));

    try {
        await writeFile(path.join(directory, 'main.ghul'), source, 'utf8');

        const libraries = wasm.withRaster && usesRaster(source) ? wasm.withRaster : wasm;
        const args = [compiler, '--target', 'llvm', '--debug', ...libraries.args,
            '--llvm-output', 'module.ll', '-o', 'main', 'main.ghul'];

        const { error, stdout, stderr } = await runCompiler(args, directory, { GHUL_LLVM });
        const diagnostics = parseDiagnostics(`${stderr}\n${stdout}`);

        if (error) {
            const timedOut = !!error.killed;
            const failed = !error.killed && !diagnostics.length;

            return { ok: false, target: 'llvm', diagnostics, ...(timedOut ? { timedOut } : {}), ...(failed ? { failed } : {}) };
        }

        const programOnly = scope !== 'all';
        const ir = optimise === 0
            ? await readFile(path.join(directory, 'module.ll'), 'utf8')
            : await emit(directory, optimise, 'll');

        if (language === 'llvm-ir') {
            return { ok: true, target: 'llvm', language, toolchain: GHUL_LLVM_VERSION, ...view.shapeLlvm(ir, programOnly) };
        }

        const asm = await emit(directory, optimise, 'asm');
        const names = programOnly ? view.programFunctions(ir) : null;

        return { ok: true, target: 'llvm', language, toolchain: GHUL_LLVM_VERSION, ...view.shapeAsm(asm, names) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// What ghul-llvm makes of the compiler's module.ll at `optimise`: `ll` for
// the optimised IR, `asm` for the assembly. Nothing is linked.
function emit(directory, optimise, kind) {
    const output = `module.O${optimise}.${kind === 'll' ? 'll' : 's'}`;

    return new Promise((resolve, reject) => {
        execFile(GHUL_LLVM, ['module.ll', `-O${optimise}`, `--emit=${kind}`, '-o', output],
            { cwd: directory, timeout: COMPILE_TIMEOUT_MS },
            error => error
                ? reject(new Error(`ghul-llvm could not emit ${kind}: ${error.message.split('\n')[0]}`))
                : resolve(readFile(path.join(directory, output), 'utf8')));
    });
}

// How many errors a compile reported: the diagnostics themselves are the
// reader's program talking, so only their number is recorded.
function errorCount(diagnostics) {
    return Array.isArray(diagnostics) ? diagnostics.filter(d => d.severity === 'error').length : undefined;
}

// A compile of a fixed program, so a broken toolchain shows as unhealthy
// rather than as failing user requests. Cached, because the container checks
// every thirty seconds and a compile costs about a CPU-second.
const HEALTH_SOURCE = 'use IO.Std.write_line;\n\nentry() is\n    write_line("ok");\nsi\n';
const HEALTH_CACHE_MS = 60000;

let health = { at: 0, ok: false, error: 'not checked yet' };

async function checkHealth() {
    if (Date.now() - health.at < HEALTH_CACHE_MS) return health;

    try {
        // Through the gate like any other compile, so the check cannot add load
        // to an already saturated service, and so saturation is reported rather
        // than hidden.
        //
        // Past the cache, though: the check is asking whether the compiler
        // still runs, and its source never changes, so a cached answer would
        // report the first success for as long as the service lived. What
        // breaks a toolchain without changing a byte of it - a runtime that
        // will not start, a full disk, a compiler that has begun to hang - is
        // exactly what this is for.
        const result = await withSlot(() => compileUncached(HEALTH_SOURCE));

        health = { at: Date.now(), ok: result.ok, error: result.ok ? null : 'compile failed' };
    } catch (e) {
        health = {
            at: Date.now(),
            ok: false,
            error: e instanceof Busy ? 'busy' : String(e)
        };
    }

    return health;
}

http.createServer((request, response) => {
    const allowed = origins.allowOriginHeader(request.headers.origin);

    if (allowed) {
        response.setHeader('Access-Control-Allow-Origin', allowed);
        response.setHeader('Vary', 'Origin');
    }

    response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');

    if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
    }

    // Deliberately unauthenticated, and deliberately before the token check:
    // the container's own health check has no token to present, and gating
    // this behind one made the service permanently unhealthy while it was in
    // fact working.
    //
    // Answers to every origin whatever the list says, because deciding whether
    // to offer editing at all is exactly what a page does before it knows it is
    // welcome, and the answer discloses nothing but a session count.
    if (request.method === 'GET' && request.url.startsWith('/health')) {
        response.setHeader('Access-Control-Allow-Origin', '*');
        checkHealth().then(state => {
            response.writeHead(state.ok ? 200 : 503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ok: state.ok,
                error: state.error ?? undefined,
                tokensRequired: tokens.required,
                maxSourceBytes: MAX_SOURCE_BYTES,
                // What a page may ask a compile for. Known once the health
                // check's own compile has resolved the toolchain.
                targets: toolchain ? (toolchain.wasm ? ['dotnet', 'wasm'] : ['dotnet']) : undefined,
                repl: REPL_ENABLED
                    ? { maxCells: MAX_CELLS, maxChainBytes: MAX_CHAIN_BYTES }
                    : undefined
            }));
        });
        return;
    }

    // How the REPL page asks whether sessions are on here, from the same path
    // it will post to: the page's own `/health` is the analyse service's, and
    // this answer has to come from the service that decides.
    if (request.method === 'GET' && request.url.startsWith('/compile/cell')) {
        if (!REPL_ENABLED) {
            response.writeHead(404).end('not found');
            return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ maxCells: MAX_CELLS, maxChainBytes: MAX_CHAIN_BYTES }));
        return;
    }

    // The targets a compile can ask for, and the native listings a view can,
    // answered on the very path the page compiles through, which every proxy
    // in front of this service already forwards: the page's own /health is the
    // analyse service's, which cannot say what this service builds.
    const route = request.url.split('?')[0];

    if (request.method === 'GET' && route === '/compile') {
        getToolchain().then(({ wasm }) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                targets: wasm ? ['dotnet', 'wasm'] : ['dotnet'],
                views: wasm && GHUL_LLVM ? [...LLVM_VIEWS] : []
            }));
        }, () => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ targets: [], views: [] }));
        });
        return;
    }

    const isCell = request.method === 'POST' && request.url.startsWith('/compile/cell');
    const isView = request.method === 'POST' && route === '/compile/view';

    // Off unless enabled, and off means absent rather than refused.
    if ((isCell && !REPL_ENABLED) || request.method !== 'POST' || !request.url.startsWith('/compile')) {
        response.writeHead(404).end('not found');
        return;
    }

    const maxBodyBytes = isCell ? MAX_CELL_REQUEST_BYTES : MAX_SOURCE_BYTES;

    const startedAt = Date.now();

    const outcome = (status, result, fields = {}) => recordOutcome({
        service: 'compile', kind: isCell ? 'cell' : isView ? 'view' : 'program', event: 'request',
        status, result, ms: Date.now() - startedAt, ...fields
    });

    if (!origins.accepts(request.headers.origin)) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'origin not allowed' }));
        outcome(403, 'origin-not-allowed');
        return;
    }

    // 401 rather than 403, and a distinguishable body, so the front end can
    // say the token is wrong instead of showing a bare failure.
    if (!tokens.accepts(tokens.fromAuthorizationHeader(request.headers.authorization))) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'invalid or missing access token' }));
        outcome(401, 'unauthorized');
        return;
    }

    let body = '';
    let aborted = false;

    // Whether the client is still there to receive an answer. The request
    // stream cannot say: it is auto-destroyed once it has been read to the end,
    // so a completed upload looks exactly like an abandoned one. The response
    // closing before it has been written is the signal that means what it says.
    let clientGone = false;

    response.on('close', () => { clientGone = !response.writableEnded; });

    request.on('data', chunk => {
        body += chunk;

        if (body.length > maxBodyBytes) {
            aborted = true;
            response.writeHead(413, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ok: false, diagnostics: [], assembly: null,
                error: isCell
                    ? `a session here is limited to ${Math.floor(MAX_CHAIN_BYTES / 1024)} KB of source`
                    : `a program here is limited to ${Math.floor(MAX_SOURCE_BYTES / 1024)} KB`
            }));
            request.destroy();
            outcome(413, 'too-big');
        }
    });

    request.on('end', async () => {
        if (aborted) return;

        try {
            let work;
            let target;

            if (isCell) {
                // Checked in full before it waits for a slot, so a request
                // over a limit costs a parse and nothing else.
                const request = cells.parseCellRequest(body, {
                    maxCells: MAX_CELLS, maxChainBytes: MAX_CHAIN_BYTES
                });

                work = () => compileCell(request);
            } else {
                const parsed = JSON.parse(body);
                const source = parsed.source ?? '';
                target = await requestedTarget(parsed.target, { view: isView });

                if (isView) {
                    const scope = parsed.scope ?? 'program';

                    if (scope !== 'program' && scope !== 'all') {
                        throw new cells.BadRequest(400, `unknown scope ${JSON.stringify(scope)}`);
                    }

                    const language = target === 'llvm' ? (parsed.view ?? 'llvm-ir') : null;

                    if (target === 'llvm' && !LLVM_VIEWS.has(language)) {
                        throw new cells.BadRequest(400, `unknown view ${JSON.stringify(parsed.view)}`);
                    }

                    const optimise = parsed.optimise ?? 2;

                    if (optimise !== 0 && optimise !== 2) {
                        throw new cells.BadRequest(400, `unknown optimise ${JSON.stringify(parsed.optimise)}`);
                    }

                    work = () => compileView(source, target, scope, language, optimise);
                } else {
                    work = () => compile(source, target);
                }
            }

            const result = await withSlot(() => {
                // The wait may have outlasted the client. Compiling for a
                // socket that has gone would spend a slot on nobody.
                if (clientGone) return null;

                return work();
            });

            if (result === null) {
                outcome(null, 'client-gone');
                return;
            }

            // A session whose earlier cells no longer compile - the toolchain
            // changed under it - has to be started again.
            const status = result.sessionBroken ? 409 : 200;

            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result));

            outcome(status,
                result.sessionBroken ? 'session-broken'
                    : result.ok ? 'ok'
                        : result.timedOut ? 'timeout'
                            : 'compile-error',
                { diagnostics: errorCount(result.diagnostics), target });
        } catch (e) {
            if (e instanceof cells.BadRequest) {
                response.writeHead(e.status, { 'content-type': 'application/json' });
                response.end(JSON.stringify({
                    ok: false, diagnostics: [], assembly: null, error: e.message
                }));
                outcome(e.status, 'bad-request');
                return;
            }

            if (e instanceof Busy) {
                response.writeHead(503, {
                    'content-type': 'application/json',
                    'retry-after': '5'
                });
                response.end(JSON.stringify({
                    ok: false, diagnostics: [], assembly: null,
                    error: 'the compile service is busy; try again in a moment'
                }));
                outcome(503, 'busy');
                return;
            }

            console.error(e);

            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ok: false, diagnostics: [], assembly: null, error: String(e)
            }));
            outcome(500, 'error');
        }
    });
}).listen(PORT, HOST, () => {
    console.log(`compile service on http://${HOST}:${PORT}`);
    console.log(`at most ${MAX_CONCURRENT} compile(s) at once, ${MAX_QUEUED} queued, ` +
        `${COMPILE_TIMEOUT_MS} ms each, ${MAX_SOURCE_BYTES} bytes of source`);
    console.log(`compiled results cached in ${RESULT_CACHE_DIR}, up to ${RESULT_CACHE_BYTES} bytes`);
    console.log(REPL_ENABLED
        ? `session cells ENABLED: at most ${MAX_CELLS} cells, ${MAX_CHAIN_BYTES} bytes of source, ` +
            `a ${CELL_CACHE_BYTES} byte cache in ${CELL_CACHE_DIR}`
        : 'session cells disabled (REPL_ENABLED is unset)');
    console.log(tokens.describe());
    console.log(origins.describe());
});
