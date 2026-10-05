// The compile service's --target wasm path, end to end: a program compiles to
// a module and the loader beside it, and the module runs under Node and prints
// what it should; source that does not compile reports its errors; a target
// the service does not know is refused; a .NET compile of the same source is
// still an assembly; and a repeat is answered from the cache.
//
// Needs the compiler (GHUL_COMPILER_DLL, or the newest in the NuGet cache) and
// the library sources: GHUL_CORE_DIR, GHUL_CORE_VERSION, GHUL_RUNTIME_SOURCE_DIR
// and GHUL_RUNTIME_SOURCE_VERSION.
//
//   node test/wasm-compile.mjs

const { spawn, execFileSync } = await import('child_process');
const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import('fs');
const { tmpdir } = await import('os');
const path = await import('path');
const { fileURLToPath } = await import('url');

const { libraryArguments, listedFiles } = await import('../shared/wasm-libraries.js');

let failures = 0;
const check = (what, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : ' - ' + detail}`);
    if (!ok) failures++;
};

// The pieces that need no compiler.
check('library arguments put each library\'s files after its declaration',
    JSON.stringify(libraryArguments([
        { name: 'core', version: '1.0.0', root: '/c', files: ['/c/a.ghul'] },
        { name: 'runtime', version: '2.0.0', root: '/r', files: ['/r/b.ghul', '/r/c.ghul'] }
    ])) === JSON.stringify([
        '--library-source', 'core@1.0.0=/c', '/c/a.ghul',
        '--library-source', 'runtime@2.0.0=/r', '/r/b.ghul', '/r/c.ghul'
    ]));

check('a source list skips blank lines and comments',
    JSON.stringify(listedFiles('/r', 'src/a.ghul\n\n# note\n  src/b.ghul  \n'))
        === JSON.stringify(['/r/src/a.ghul', '/r/src/b.ghul']));

const PORT = 5096;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = mkdtempSync(path.join(tmpdir(), 'wasm-compile-test-'));

const service = spawn('node', ['compile-service/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), RESULT_CACHE_DIR: cacheDir },
    stdio: ['ignore', 'inherit', 'inherit']
});

async function post(body) {
    const response = await fetch(`http://127.0.0.1:${PORT}/compile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });

    return { status: response.status, result: await response.json() };
}

const HELLO = 'use IO.Std.write_line\n\nentry() is\n    write_line("hello {6 * 7}")\nsi\n';
const BROKEN = 'use IO.Std.write_line\n\nentry() is\n    write_line(no_such_thing)\nsi\n';

try {
    for (let i = 0; ; i++) {
        try {
            await fetch(`http://127.0.0.1:${PORT}/health`);
            break;
        } catch (e) {
            if (i > 60) throw new Error('the service did not start');
            await new Promise(r => setTimeout(r, 500));
        }
    }

    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    check('health lists the wasm target', health.targets?.includes('wasm'),
        JSON.stringify(health.targets));

    const wasm = await post({ source: HELLO, target: 'wasm' });
    const module = Buffer.from(wasm.result.module ?? '', 'base64');

    check('a wasm compile succeeds', wasm.status === 200 && wasm.result.ok,
        JSON.stringify(wasm.result.diagnostics));
    check('it returns a WebAssembly module', module.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d])));
    check('it returns the loader', /export\s+async\s+function\s+run/.test(wasm.result.loader ?? ''));
    check('it returns no assembly', wasm.result.assembly === undefined);

    if (wasm.result.ok) {
        const run = mkdtempSync(path.join(tmpdir(), 'wasm-compile-run-'));

        try {
            writeFileSync(path.join(run, 'main.wasm'), module);
            writeFileSync(path.join(run, 'main.mjs'), wasm.result.loader);

            const output = execFileSync('node', ['main.mjs'], { cwd: run, encoding: 'utf8' });

            check('the module runs and prints what it should', output === 'hello 42\n',
                JSON.stringify(output));
        } finally {
            rmSync(run, { recursive: true, force: true });
        }
    }

    const again = await post({ source: HELLO, target: 'wasm' });
    check('a repeat is answered from the cache', again.result.cached === true && again.result.module);

    const dotnet = await post({ source: HELLO });
    check('the same source without a target is still an assembly',
        dotnet.result.ok && dotnet.result.assembly && dotnet.result.module === undefined);

    const broken = await post({ source: BROKEN, target: 'wasm' });
    check('source that does not compile reports its errors',
        !broken.result.ok && broken.result.module === null &&
        broken.result.diagnostics.some(d => d.severity === 'error'));

    const unknown = await post({ source: HELLO, target: 'jvm' });
    check('an unknown target is refused', unknown.status === 400, String(unknown.status));
} finally {
    service.kill();
    rmSync(cacheDir, { recursive: true, force: true });
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
