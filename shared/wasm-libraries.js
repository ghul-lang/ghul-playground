// The libraries a program compiled with --target wasm is built against.
//
// A wasm build loads no .NET assemblies. What they supply on .NET comes from
// two ghūl libraries compiled into the module from source: ghul-core, which
// gives the built-in types their members, and ghul-runtime, which supplies the
// pipes and the rest of Ghul. Each is passed to the compiler as
// `--library-source <name>@<version>=<root>` followed by its files, core first,
// which is the command line ghul-cli writes for `ghul run --target wasm`.
//
// The image checks both out at the tags ghul-cli pins for its compiler (see
// scripts/check-wasm-pins.js), so a program behaves here as it does locally.

const { readdir, readFile } = require('fs/promises');
const { existsSync } = require('fs');
const path = require('path');

// Every .ghul file under `directory`, sorted so the command line, and the
// toolchain identity hashed from it, do not depend on directory order.
async function ghulFilesUnder(directory) {
    const found = [];

    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            found.push(...await ghulFilesUnder(full));
        } else if (entry.name.endsWith('.ghul')) {
            found.push(full);
        }
    }

    return found.sort();
}

// The files a response file lists, one relative path a line, resolved against
// the directory it is in. Blank lines and `#` comments are skipped.
function listedFiles(root, text) {
    return text.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => path.join(root, line));
}

// The compiler arguments for a set of source libraries, in order.
function libraryArguments(libraries) {
    const args = [];

    for (const { name, version, root, files } of libraries) {
        args.push('--library-source', `${name}@${version}=${root}`, ...files);
    }

    return args;
}

// The core library's sources are its manifest's `src/**/*.ghul`; the runtime
// lists the subset that builds for wasm in `wasm-sources.rsp`. Answers null
// where the image carries no libraries, which leaves the wasm target off.
async function resolveWasmLibraries(environment = process.env) {
    const coreRoot = environment.GHUL_CORE_DIR;
    const runtimeRoot = environment.GHUL_RUNTIME_SOURCE_DIR;

    if (!coreRoot || !runtimeRoot) {
        return null;
    }

    const runtimeList = path.join(runtimeRoot, 'wasm-sources.rsp');

    for (const required of [path.join(coreRoot, 'src'), runtimeList]) {
        if (!existsSync(required)) {
            throw new Error(`wasm library sources not found: ${required}`);
        }
    }

    const libraries = [
        {
            name: 'ghul-core',
            version: environment.GHUL_CORE_VERSION,
            root: coreRoot,
            files: await ghulFilesUnder(path.join(coreRoot, 'src'))
        },
        {
            name: 'ghul-runtime',
            version: environment.GHUL_RUNTIME_SOURCE_VERSION,
            root: runtimeRoot,
            files: listedFiles(runtimeRoot, await readFile(runtimeList, 'utf8'))
        }
    ];

    const missing = libraries.flatMap(l => l.files).filter(f => !existsSync(f));

    if (missing.length > 0) {
        throw new Error(`wasm library sources not found: ${missing.join(', ')}`);
    }

    return { libraries, args: libraryArguments(libraries) };
}

module.exports = { ghulFilesUnder, listedFiles, libraryArguments, resolveWasmLibraries };
