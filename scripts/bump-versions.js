// Bumps the toolchain versions at every site they are written, so a bump is
// one edit instead of several kept in sync by hand - the history this repository has is exactly the other way
// round, a version landing in all but one site and check-versions.js catching
// it after the fact.
//
//   node scripts/bump-versions.js --compiler 52.2.1
//   node scripts/bump-versions.js --runtime 18.0.1
//   node scripts/bump-versions.js --raster 0.4.1
//   node scripts/bump-versions.js --compiler 52.2.1 --runtime 18.0.1
//   node scripts/bump-versions.js --core 1.3.0 --llvm 1.6.0
//   node scripts/bump-versions.js --repl 9.4.2 --ilspy 11.1.0.9782 --language-server 1.33.2
//   node scripts/bump-versions.js --latest
//
// The compiler, runtime and raster are checked against each other by
// check-versions.js; ghul-core, ghul-llvm, the ghul.repl package, ilspycmd and
// the language server each have their own flag. `--latest` resolves every one
// of them to its current release (nuget.org for the packages, the npm registry
// for the language server, the GitHub release for ghul-core and ghul-llvm) and
// bumps all of them; an explicit flag bumps only what it names, and wins over
// `--latest` for that tool. Running with no flags prints the current versions
// and does nothing.

const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, text) => fs.writeFileSync(path.join(root, f), text);

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'user-agent': 'ghul-playground-bump-versions' } }, res => {
            if (res.statusCode !== 200) {
                reject(new Error(`${url}: HTTP ${res.statusCode}`));
                res.resume();
                return;
            }

            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(new Error(`${url}: ${err.message}`));
                }
            });
        }).on('error', reject);
    });
}

// Highest stable version nuget.org lists for a package - prereleases
// (anything with a `-`) are never what a routine bump wants.
async function latestPublished(packageId) {
    const index = await fetchJson(`https://api.nuget.org/v3-flatcontainer/${packageId}/index.json`);

    const stable = index.versions.filter(v => !v.includes('-'));

    stable.sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);

        for (let i = 0; i < 3; i++) {
            if (pa[i] !== pb[i]) return pa[i] - pb[i];
        }

        return 0;
    });

    return stable[stable.length - 1];
}

function bumpCompiler(version) {
    const manifestFile = '.config/dotnet-tools.json';
    const original = read(manifestFile);
    const before = JSON.parse(original).tools['ghul.compiler'].version;

    // A regex substitution rather than a parse/stringify round-trip, so a
    // manifest with no trailing newline (or different indentation) is left
    // exactly as it was apart from the one field this bump changes.
    const pin = /("ghul\.compiler":\s*\{\s*"version":\s*")[^"]+(")/;

    if (!pin.test(original)) {
        throw new Error(`${manifestFile}: no ghul.compiler version to update`);
    }

    write(manifestFile, original.replace(pin, `$1${version}$2`));

    for (const image of ['compile-service/Dockerfile', 'analyse-service/Dockerfile']) {
        const text = read(image);

        if (!/^ARG GHUL_COMPILER_VERSION=.+$/m.test(text)) {
            throw new Error(`${image}: no ARG GHUL_COMPILER_VERSION line to update`);
        }

        write(image, text.replace(/^ARG GHUL_COMPILER_VERSION=.+$/m, `ARG GHUL_COMPILER_VERSION=${version}`));
    }

    console.log(`compiler: ${before} -> ${version}`);
}

// Only the web app references raster and only the images carry its version,
// so this has fewer sites than the runtime rather than the same ones.
function bumpRaster(version) {
    const project = 'web/web.csproj';
    const text = read(project);
    const match = text.match(/Include="ghul\.raster"\s+Version="([^"]+)"/);

    if (!match) {
        throw new Error(`${project}: no ghul.raster PackageReference`);
    }

    write(project, text.replace(/(Include="ghul\.raster"\s+Version=")[^"]+(")/, `$1${version}$2`));

    for (const image of ['compile-service/Dockerfile', 'analyse-service/Dockerfile']) {
        const text = read(image);

        if (!/^ARG GHUL_RASTER_VERSION=.+$/m.test(text)) {
            throw new Error(`${image}: no ARG GHUL_RASTER_VERSION line to update`);
        }

        write(image, text.replace(/^ARG GHUL_RASTER_VERSION=.+$/m, `ARG GHUL_RASTER_VERSION=${version}`));
    }

    console.log(`raster: ${match[1]} -> ${version}`);
}

function bumpRuntime(version) {
    let before;

    for (const project of ['web/web.csproj', 'runner/runner.ghulproj']) {
        const text = read(project);
        const match = text.match(/Include="ghul\.runtime"\s+Version="([^"]+)"/);

        if (!match) {
            throw new Error(`${project}: no ghul.runtime PackageReference`);
        }

        before = match[1];

        const updated = text.replace(
            /(Include="ghul\.runtime"\s+Version=")[^"]+(")/,
            `$1${version}$2`
        );

        write(project, updated);
    }

    for (const image of ['compile-service/Dockerfile', 'analyse-service/Dockerfile']) {
        const text = read(image);

        if (!/^ARG GHUL_RUNTIME_VERSION=.+$/m.test(text)) {
            throw new Error(`${image}: no ARG GHUL_RUNTIME_VERSION line to update`);
        }

        write(image, text.replace(/^ARG GHUL_RUNTIME_VERSION=.+$/m, `ARG GHUL_RUNTIME_VERSION=${version}`));
    }

    console.log(`runtime: ${before} -> ${version}`);
}

// The latest release of a GitHub repository, without its leading `v`.
async function latestRelease(repository) {
    const release = await fetchJson(`https://api.github.com/repos/${repository}/releases/latest`);

    return release.tag_name.replace(/^v/, '');
}

async function latestNpm(packageName) {
    const metadata = await fetchJson(`https://registry.npmjs.org/${packageName}/latest`);

    return metadata.version;
}

// Replaces the value of every `ARG <name>=...` line in the given images.
function bumpImageArg(label, arg, images, version) {
    let before;

    for (const image of images) {
        const text = read(image);
        const match = text.match(new RegExp(`^ARG ${arg}=(.+)$`, 'm'));

        if (!match) {
            throw new Error(`${image}: no ARG ${arg} line to update`);
        }

        before = match[1].trim();

        write(image, text.replace(new RegExp(`^ARG ${arg}=.+$`, 'm'), `ARG ${arg}=${version}`));
    }

    console.log(`${label}: ${before} -> ${version}`);
}

function bumpCore(version) {
    bumpImageArg('ghul-core', 'GHUL_CORE_VERSION', ['compile-service/Dockerfile', 'analyse-service/Dockerfile'], version);
}

function bumpLlvm(version) {
    bumpImageArg('ghul-llvm', 'GHUL_LLVM_VERSION', ['compile-service/Dockerfile'], version);
}

function bumpIlspy(version) {
    bumpImageArg('ilspycmd', 'ILSPYCMD_VERSION', ['compile-service/Dockerfile'], version);
}

function bumpLanguageServer(version) {
    bumpImageArg('language server', 'GHUL_LANGUAGE_SERVER_VERSION', ['analyse-service/Dockerfile'], version);
}

function bumpRepl(version) {
    const project = 'runner/runner.ghulproj';
    const text = read(project);
    const match = text.match(/Include="ghul\.repl"\s+Version="([^"]+)"/);

    if (!match) {
        throw new Error(`${project}: no ghul.repl PackageReference`);
    }

    write(project, text.replace(/(Include="ghul\.repl"\s+Version=")[^"]+(")/, `$1${version}$2`));

    console.log(`ghul.repl: ${match[1]} -> ${version}`);
}

async function main() {
    const args = process.argv.slice(2);
    const wantLatest = args.includes('--latest');

    const flagValue = name => {
        const i = args.indexOf(name);
        return i === -1 ? null : args[i + 1];
    };

    const wanted = {
        compiler: flagValue('--compiler'),
        runtime: flagValue('--runtime'),
        raster: flagValue('--raster'),
        core: flagValue('--core'),
        llvm: flagValue('--llvm'),
        repl: flagValue('--repl'),
        ilspy: flagValue('--ilspy'),
        languageServer: flagValue('--language-server'),
    };

    if (wantLatest) {
        const latest = {
            compiler: () => latestPublished('ghul.compiler'),
            runtime: () => latestPublished('ghul.runtime'),
            raster: () => latestPublished('ghul.raster'),
            core: () => latestRelease('ghul-lang/ghul-core'),
            llvm: () => latestRelease('ghul-lang/ghul-llvm'),
            repl: () => latestPublished('ghul.repl'),
            ilspy: () => latestPublished('ilspycmd'),
            languageServer: () => latestNpm('@ghul/language-server'),
        };

        await Promise.all(Object.keys(latest).map(async key => {
            wanted[key] = wanted[key] || await latest[key]();
        }));
    }

    if (!Object.values(wanted).some(Boolean)) {
        const manifest = JSON.parse(read('.config/dotnet-tools.json'));
        const web = read('web/web.csproj');
        const runner = read('runner/runner.ghulproj');
        const compile = read('compile-service/Dockerfile');
        const analyse = read('analyse-service/Dockerfile');
        const reference = (text, id) => text.match(new RegExp(`Include="${id}"\\s+Version="([^"]+)"`))?.[1] ?? '(not found)';
        const arg = (text, name) => text.match(new RegExp(`^ARG ${name}=(.+)$`, 'm'))?.[1].trim() ?? '(not found)';

        console.log(`compiler:        ${manifest.tools['ghul.compiler'].version}`);
        console.log(`runtime:         ${reference(web, 'ghul\\.runtime')}`);
        console.log(`raster:          ${reference(web, 'ghul\\.raster')}`);
        console.log(`ghul-core:       ${arg(compile, 'GHUL_CORE_VERSION')}`);
        console.log(`ghul-llvm:       ${arg(compile, 'GHUL_LLVM_VERSION')}`);
        console.log(`ghul.repl:       ${reference(runner, 'ghul\\.repl')}`);
        console.log(`ilspycmd:        ${arg(compile, 'ILSPYCMD_VERSION')}`);
        console.log(`language server: ${arg(analyse, 'GHUL_LANGUAGE_SERVER_VERSION')}`);
        console.log('\nNothing to do - pass a --<tool> flag or --latest to bump.');
        return;
    }

    if (wanted.compiler) bumpCompiler(wanted.compiler);
    if (wanted.runtime) bumpRuntime(wanted.runtime);
    if (wanted.raster) bumpRaster(wanted.raster);
    if (wanted.core) bumpCore(wanted.core);
    if (wanted.llvm) bumpLlvm(wanted.llvm);
    if (wanted.repl) bumpRepl(wanted.repl);
    if (wanted.ilspy) bumpIlspy(wanted.ilspy);
    if (wanted.languageServer) bumpLanguageServer(wanted.languageServer);
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
