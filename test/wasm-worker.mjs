// The browser side of the wasm target, as far as Node can run it: the worker
// script with the loader the compiler writes, standard input through the
// shared buffer, a file the program writes shown as a picture, an unhandled
// exception shown as the .NET runner shows one, and the helpers the page
// decides with.
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
const { LiveOutput } = await import('../web/wwwroot/live-output.js');
const { wasmFlag, dataFilePaths } = await import('../web/wwwroot/collections.js').catch(() => ({}));

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

if (dataFilePaths) {
    const root = 'https://example.org/repo/';
    const named = dataFilePaths('../../data/words.txt\nnotes.txt\nmaths/square.ghi\n# a comment\n',
        `${root}tasks/t/playground-files`, root).map(f => f.name);

    check('a shared file is named by its last segment, and a task\'s own by its path there',
        JSON.stringify(named) === JSON.stringify(['words.txt', 'notes.txt', 'maths/square.ghi']), JSON.stringify(named));

    let refused = false;

    try {
        dataFilePaths('../../../elsewhere.txt', `${root}tasks/t/playground-files`, root);
    } catch {
        refused = true;
    }

    check('a file outside the repository is refused', refused);
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

// A program that writes a picture and names it, as ghul.raster's `show`
// does. The host import is declared here, as the core library declares it,
// so the test does not wait on a core library that writes files itself.
const PICTURE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const PICTURE_SOURCE = `use IO.Std.write_line

@intrinsic("host.file_written")
written(path: string, content: string)

entry() is
    write_line("drawing")
    written("dot.png", "${PICTURE}")
    write_line("<<image ./dot.png>>")
    write_line("done")
si
`;

// A program that reads the files it starts with, one of them as bytes, and
// writes one of its own.
const FILES_SOURCE = `use IO.Std.write_line

entry() is
    for line in IO.File.read_all_lines("words.txt") do
        write_line("read {line}")
    od

    write_line(IO.File.read_all_text("notes.txt"))
    write_line("{IO.File.read_all_bytes("data.bin").count} {IO.File.exists("missing.txt")}")

    IO.File.write_all_text("notes.txt", "changed")
    write_line(IO.File.read_all_text("notes.txt"))
si
`;

const work = mkdtempSync(path.join(tmpdir(), 'wasm-worker-test-'));

const workerScript = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),
    '../web/wwwroot/wasm-worker.js')).href;

// The browser globals the worker script uses, then the script itself.
const shim = `
    const { parentPort } = await import('worker_threads');
    globalThis.self = globalThis;
    globalThis.postMessage = message => parentPort.postMessage(message);
    parentPort.on('message', data => self.onmessage({ data }));
    const { wasmWorker } = await import(${JSON.stringify(workerScript)});
    wasmWorker();
    parentPort.postMessage({ type: 'loaded' });
`;

// Compiles `source` for the wasm target and runs it in the worker script,
// answering each request for input with the next of `lines`. Answers what it
// printed, the files it wrote, how often it asked for input, and its exit
// status. `files` are the files the program starts with, as the page hands
// them to the run. Answers null, without running it, where the loader the
// compiler wrote has no `needs` among its host functions.
async function compileAndRun(name, source, lines = [], needs = null, startFiles = {}) {
    const [compiler, wasm] = await Promise.all([resolveCompiler(), resolveWasmLibraries()]);

    if (!wasm) throw new Error('set GHUL_CORE_DIR and GHUL_RUNTIME_SOURCE_DIR');

    writeFileSync(path.join(work, `${name}.ghul`), source);

    execFileSync('dotnet', [compiler, '--target', 'wasm', ...wasm.args,
        '-o', path.join(work, `${name}.wasm`), path.join(work, `${name}.ghul`)], { stdio: 'inherit' });

    const loader = readFileSync(path.join(work, `${name}.mjs`), 'utf8');

    if (needs && !loader.includes(needs)) return null;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(shim)}`));
    const input = inputBuffer();
    const files = new Map();

    let output = '';
    let asked = 0;

    const code = await new Promise((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', message => {
            switch (message.type) {
                case 'loaded':
                    worker.postMessage({
                        module: readFileSync(path.join(work, `${name}.wasm`)),
                        loader,
                        args: [],
                        files: startFiles,
                        input
                    });
                    break;

                case 'output':
                    output += message.stream === 'stderr'
                        ? (unhandledException(message.text) ?? message.text)
                        : message.text;
                    break;

                case 'file':
                    // Recorded with what had been printed by then, to show
                    // the file arrives ahead of the marker naming it.
                    files.set(message.path, { bytes: message.bytes, before: output });
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

    return { output, files, asked, code };
}

try {
    const { output, asked, code } = await compileAndRun('main', SOURCE, ['alpha', 'beta']);

    check('the program read its input a line at a time', asked >= 3, `asked ${asked} times`);
    check('what it printed reached the page', output.startsWith('got alpha and beta\nthen the end\n'),
        JSON.stringify(output));
    check('its unhandled exception is shown as .NET shows one',
        output.includes('[unhandled: InvalidOperationException: boom]'), JSON.stringify(output));
    check('it ended with .NET\'s status for an unhandled exception', code === 134, String(code));

    // A loader that predates the host import cannot instantiate a module
    // that declares it, so there is nothing to run until the compiler the
    // playground pins writes one that has it.
    const drawn = await compileAndRun('picture', PICTURE_SOURCE, [], 'file_written');

    if (!drawn) {
        console.log('skip  pictures: this compiler\'s loader does not hand written files to the page');
    } else {
        const file = drawn.files.get('dot.png');

        check('the file the program wrote reached the page', file !== undefined, [...drawn.files.keys()].join(', '));
        check('it arrived before the marker naming it', file?.before === 'drawing\n', JSON.stringify(file?.before));
        check('its bytes are the ones the program wrote',
            Buffer.from(file?.bytes ?? []).toString('base64') === PICTURE);

        // What the page does with the run: the marker shown as the picture.
        const live = new LiveOutput({ readFile: p => drawn.files.get(p.replace(/^(\.\/)+/, ''))?.bytes ?? null });

        live.feed(drawn.output);
        live.finish();

        check('the marker is shown as the picture', live.images.length === 1 && live.images[0].name === 'dot.png'
            && live.images[0].url === `data:image/png;base64,${PICTURE}`, JSON.stringify(live.images.map(i => i.name)));
        check('and is taken out of the text', live.text === 'drawing\ndone\n', JSON.stringify(live.text));
    }

    // A program starts with the files it is given, which it reads by name,
    // and what it writes over one is its own. Needs a loader that hands the
    // files to the program and a core library that takes them.
    const core = (await resolveWasmLibraries()).libraries.find(l => l.name === 'ghul-core');
    const coreTakesFiles = readFileSync(path.join(core.root, 'src/file_system.ghul'), 'utf8').includes('input_file_count');

    const read = coreTakesFiles
        ? await compileAndRun('files', FILES_SOURCE, [], 'input_file_count', {
            'words.txt': 'alpha\nbeta\n',
            'notes.txt': 'from the notes \u20ac',
            'data.bin': new Uint8Array(256)
        })
        : null;

    if (!read) {
        console.log('skip  files: this compiler\'s loader or core library does not hand files to the program');
    } else {
        check('the program read the files it was given', read.output.startsWith('read alpha\nread beta\nfrom the notes \u20ac\n256 false\n'),
            JSON.stringify(read.output));
        check('what it wrote over one replaced it', read.output.endsWith('changed\n'), JSON.stringify(read.output));
        check('and reached the page', Buffer.from(read.files.get('notes.txt')?.bytes ?? []).toString() === 'changed');
        check('it ended normally', read.code === 0, String(read.code));
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
