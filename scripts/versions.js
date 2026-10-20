// Every place the playground names a tool version, and how to read and write
// each one. versions.json is the one list of what the site runs; every other
// file below is written from it by sync-versions.js and checked against it by
// check-versions.js, so a tool is never on one version in one service and
// another in the next.
//
// Adding a tool, or a place that names one, is a change to this table and to
// versions.json, and nowhere else.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, text) => fs.writeFileSync(path.join(root, f), text);

// The tools versions.json names, and where each is released.
const TOOLS = [
    'compiler', 'runtime', 'raster', 'core', 'llvm', 'languageServer', 'disassembler', 'repl'
];

// A line in a Dockerfile: `ARG <name>=<version>`.
function dockerArg(file, tool, arg) {
    const pattern = new RegExp(`^ARG ${arg}=(.+)$`, 'm');

    return {
        file, tool, argName: arg,
        read: () => (read(file).match(pattern) ?? [])[1]?.trim(),
        write: version => write(file, read(file).replace(pattern, `ARG ${arg}=${version}`))
    };
}

// A PackageReference's Version attribute.
function packageReference(file, tool, id) {
    const pattern = new RegExp(`(Include="${id.replace(/\./g, '\\.')}"\\s+Version=")([^"]+)(")`);

    return {
        file, tool, id,
        read: () => (read(file).match(pattern) ?? [])[2],
        write: version => write(file, read(file).replace(pattern, `$1${version}$3`))
    };
}

// A tool pinned in the local tool manifest.
function toolManifest(file, tool, id) {
    return {
        file, tool, id,
        read: () => JSON.parse(read(file)).tools[id]?.version,
        write: version => write(file, read(file).replace(
            new RegExp(`("${id.replace(/\./g, '\\.')}":\\s*\\{\\s*"version":\\s*")([^"]+)(")`), `$1${version}$3`))
    };
}

const SITES = [
    toolManifest('.config/dotnet-tools.json', 'compiler', 'ghul.compiler'),

    packageReference('web/web.csproj', 'runtime', 'ghul.runtime'),
    packageReference('web/web.csproj', 'raster', 'ghul.raster'),
    packageReference('runner/runner.ghulproj', 'runtime', 'ghul.runtime'),
    packageReference('runner/runner.ghulproj', 'repl', 'ghul.repl'),

    dockerArg('compile-service/Dockerfile', 'compiler', 'GHUL_COMPILER_VERSION'),
    dockerArg('compile-service/Dockerfile', 'runtime', 'GHUL_RUNTIME_VERSION'),
    dockerArg('compile-service/Dockerfile', 'raster', 'GHUL_RASTER_VERSION'),
    dockerArg('compile-service/Dockerfile', 'core', 'GHUL_CORE_VERSION'),
    dockerArg('compile-service/Dockerfile', 'llvm', 'GHUL_LLVM_VERSION'),
    dockerArg('compile-service/Dockerfile', 'disassembler', 'ILSPYCMD_VERSION'),

    dockerArg('analyse-service/Dockerfile', 'compiler', 'GHUL_COMPILER_VERSION'),
    dockerArg('analyse-service/Dockerfile', 'runtime', 'GHUL_RUNTIME_VERSION'),
    dockerArg('analyse-service/Dockerfile', 'raster', 'GHUL_RASTER_VERSION'),
    dockerArg('analyse-service/Dockerfile', 'core', 'GHUL_CORE_VERSION'),
    dockerArg('analyse-service/Dockerfile', 'languageServer', 'GHUL_LANGUAGE_SERVER_VERSION')
];

function wanted() {
    const versions = JSON.parse(read('versions.json'));

    for (const tool of TOOLS) {
        if (typeof versions[tool] !== 'string') {
            throw new Error(`versions.json: no version for ${tool}`);
        }
    }

    for (const tool of Object.keys(versions)) {
        if (!TOOLS.includes(tool)) {
            throw new Error(`versions.json: ${tool} is not a tool scripts/versions.js knows`);
        }
    }

    return versions;
}

module.exports = { TOOLS, SITES, wanted, read, write, root };
