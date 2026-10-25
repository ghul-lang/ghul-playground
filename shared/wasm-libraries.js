// The libraries a program compiled with --target wasm is built against.
//
// A wasm build loads no .NET assemblies. What they supply on .NET comes from
// two ghūl libraries compiled into the module from source: ghul-core, which
// gives the built-in types their members, and ghul-runtime, which supplies the
// pipes and the rest of Ghul. Each is passed to the compiler as
// `--library-source <name>@<version>=<root>` followed by its files, core first,
// which is the command line ghul-cli writes for `ghul run --target wasm`.
//
// The image checks both out at pinned releases (see
// scripts/check-wasm-pins.js), the same in the compile and analyse images.
//
// ghul-raster is a third, for a program that draws: its sources at the tag of
// the ghul.raster package the .NET build references, every .ghul file under
// its src/ as its ghul-project.json lists them. It roughly doubles what a
// compile reads, so it is only added for a program that names it.

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

// The compiler arguments for a set of source libraries, in order.
function libraryArguments(libraries) {
    const args = [];

    for (const { name, version, root, files } of libraries) {
        // The loader that runs a program ships with the core library.
        if (name === 'ghul-core') {
            args.push('--wasm-loader', path.join(root, 'host', 'loader.mjs'));
        }

        args.push('--library-source', `${name}@${version}=${root}`, ...files);
    }

    return args;
}

// Whether a program uses ghul.raster. Its namespace has to be named to reach
// anything in it, so a program that does not name it cannot need it.
function usesRaster(source) {
    return /\bRaster\b/.test(source);
}

// Both libraries' sources are their trees' `src/**/*.ghul`, the file-level
// IF pragmas deciding what a wasm build compiles. Answers null
// where the image carries no libraries, which leaves the wasm target off.
//
// Answers the libraries and their compiler arguments, and `withRaster`, the
// same with ghul-raster after them, or null where the image carries no raster
// sources.
async function resolveWasmLibraries(environment = process.env) {
    const coreRoot = environment.GHUL_CORE_DIR;
    const runtimeRoot = environment.GHUL_RUNTIME_SOURCE_DIR;

    if (!coreRoot || !runtimeRoot) {
        return null;
    }

    for (const required of [path.join(coreRoot, 'src'), path.join(coreRoot, 'host', 'loader.mjs'), path.join(runtimeRoot, 'ghul-runtime', 'src')]) {
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
            files: await ghulFilesUnder(path.join(runtimeRoot, 'ghul-runtime', 'src'))
        }
    ];

    const missing = libraries.flatMap(l => l.files).filter(f => !existsSync(f));

    if (missing.length > 0) {
        throw new Error(`wasm library sources not found: ${missing.join(', ')}`);
    }

    const rasterRoot = environment.GHUL_RASTER_SOURCE_DIR;

    let withRaster = null;

    if (rasterRoot) {
        const rasterSources = path.join(rasterRoot, 'src');

        if (!existsSync(rasterSources)) {
            throw new Error(`wasm library sources not found: ${rasterSources}`);
        }

        const all = [...libraries, {
            name: 'ghul-raster',
            version: environment.GHUL_RASTER_SOURCE_VERSION,
            root: rasterRoot,
            files: await ghulFilesUnder(rasterSources)
        }];

        withRaster = { libraries: all, args: libraryArguments(all) };
    }

    return { libraries, args: libraryArguments(libraries), withRaster };
}

module.exports = { ghulFilesUnder, libraryArguments, resolveWasmLibraries, usesRaster };
