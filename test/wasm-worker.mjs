// The browser side of the wasm target, as far as Node can run it: the worker
// script with the loader the compiler writes, standard input through the
// shared buffer, an unhandled exception shown as the .NET runner shows one,
// and the helpers the page decides with.
//
// The worker script is run in a Node worker thread with the few browser
// globals it uses supplied, so it is the page's own code that is tested rather
// than a copy of it.
//
// Needs the compiler and the library sources, as test/wasm-compile.mjs does.
//
//   node test/wasm-worker.mjs

const { Worker } = await import('worker_threads');
const { execFileSync } = await import('child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('fs');
const { tmpdir } = await import('os');
const path = await import('path');
const { fileURLToPath, pathToFileURL } = await import('url');

const { resolveCompiler } = await import('../shared/toolchain.js');
const { resolveWasmLibraries } = await import('../shared/wasm-libraries.js');
const { unhandledException, needsDotnet, wasmSupported } = await import('../web/wwwroot/wasm-support.js');
const { inputBuffer, supplyInput } = await import('../web/wwwroot/wasm-input.js');
const { wasmFlag } = await import('../web/wwwroot/collections.js').catch(() => ({}));

let failures = 0;
const check = (what, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : ' - ' + detail}`);
    if (!ok) failures++;
};

check('an unhandled exception reads as the .NET runner shows one',
    unhandledException('Unhandled exception. Ghul.InvalidOperationException: boom\n')
        === '[unhandled: InvalidOperationException: boom]');
check('ordinary standard error is not an exception', unhandledException('warning: careful\n') === null);

check('a construct wasm cannot compile falls back to .NET',
    needsDotnet([{ severity: 'error', message: 'code generation for a decimal literal is not supported on the wasm target' }]));
check('a .NET API the core library lacks falls back to .NET',
    needsDotnet([{ severity: 'error', message: 'member File not found in IO' }]));
check('a type error does not fall back',
    !needsDotnet([{ severity: 'error', message: 'cannot assign string to int' }]));
check('warnings alone do not fall back',
    !needsDotnet([{ severity: 'warn', message: 'not supported on the wasm target' }]));

check('this Node can run a wasm build', await wasmSupported());

if (wasmFlag) {
    const index = { tasks: [{ slug: 'a', parts: [{ id: 'a', wasm: true }] },
        { slug: 'b', parts: [{ id: 'b/01-x', wasm: false }, { id: 'b/02-y', wasm: true }] }] };

    check('a flagged program runs on wasm', wasmFlag(index, 'a') && wasmFlag(index, 'b/02-y'));
    check('an unflagged or unknown program does not',
        !wasmFlag(index, 'b/01-x') && !wasmFlag(index, 'c') && !wasmFlag(null, 'a'));
}

// A program that reads two lines, echoes them, and then throws.
const SOURCE = `use IO.Std.write_line

entry() is
    let first = IO.Std.read_line()
    let second = IO.Std.read_line()

    write_line("got {first} and {second}")
    write_line("then {IO.Std.read_line() ?? "the end"}")

    throw Ghul.InvalidOperationException("boom")
si
`;

const work = mkdtempSync(path.join(tmpdir(), 'wasm-worker-test-'));

try {
    const [compiler, wasm] = await Promise.all([resolveCompiler(), resolveWasmLibraries()]);

    if (!wasm) throw new Error('set GHUL_CORE_DIR and GHUL_RUNTIME_SOURCE_DIR');

    writeFileSync(path.join(work, 'main.ghul'), SOURCE);

    execFileSync('dotnet', [compiler, '--target', 'wasm', ...wasm.args,
        '-o', path.join(work, 'main.wasm'), path.join(work, 'main.ghul')], { stdio: 'inherit' });

    const workerScript = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),
        '../web/wwwroot/wasm-worker.js')).href;

    // The browser globals the worker script uses, then the script itself.
    const shim = `
        const { parentPort } = await import('worker_threads');
        globalThis.self = globalThis;
        globalThis.postMessage = message => parentPort.postMessage(message);
        parentPort.on('message', data => self.onmessage({ data }));
        await import(${JSON.stringify(workerScript)});
        parentPort.postMessage({ type: 'loaded' });
    `;

    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(shim)}`));
    const input = inputBuffer();
    const lines = ['alpha', 'beta'];

    let output = '';
    let asked = 0;

    const code = await new Promise((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', message => {
            switch (message.type) {
                case 'loaded':
                    worker.postMessage({
                        module: readFileSync(path.join(work, 'main.wasm')),
                        loader: readFileSync(path.join(work, 'main.mjs'), 'utf8'),
                        args: [],
                        input
                    });
                    break;

                case 'output':
                    output += message.stream === 'stderr'
                        ? (unhandledException(message.text) ?? message.text)
                        : message.text;
                    break;

                case 'input':
                    asked++;
                    supplyInput(input, lines.length ? `${lines.shift()}\n` : null);
                    break;

                case 'exit':
                    resolve(message.code);
                    break;

                case 'failed':
                    reject(new Error(message.message));
                    break;
            }
        });
    });

    await worker.terminate();

    check('the program read its input a line at a time', asked >= 3, `asked ${asked} times`);
    check('what it printed reached the page', output.startsWith('got alpha and beta\nthen the end\n'),
        JSON.stringify(output));
    check('its unhandled exception is shown as .NET shows one',
        output.includes('[unhandled: InvalidOperationException: boom]'), JSON.stringify(output));
    check('it ended with .NET\'s status for an unhandled exception', code === 134, String(code));
} finally {
    rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
