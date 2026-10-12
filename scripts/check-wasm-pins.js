// The compile service builds --target wasm programs against ghul-core and
// ghul-runtime sources at the tags its Dockerfile names. ghul-cli, which is how
// a reader builds the same program locally, takes a release of each library
// that the compiler and the library each accept, by the requirements.json
// each publishes, and falls back on a tag pinned to each range of compiler
// versions only for a compiler from before those. This checks the image
// takes releases ghul-cli would accept for the image's compiler, so a program
// behaves here as it does with `ghul run --target wasm`.
//
// The pins live in ghul-cli's source, so this reads them from its main branch.
//
// It also holds the image's ghul-llvm, which the native views link with, to
// the release the image's compiler requires.
//
//   node scripts/check-wasm-pins.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.join(__dirname, '..');
const PINS = 'https://raw.githubusercontent.com/ghul-lang/ghul-cli/main/project/src';

function fetchText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'user-agent': 'ghul-playground-check-wasm-pins' } }, res => {
            if (res.statusCode !== 200) {
                reject(new Error(`${url}: HTTP ${res.statusCode}`));
                res.resume();
                return;
            }

            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

function compareVersions(a, b) {
    const [x, y] = [a, b].map(v => v.split('.').map(Number));

    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i]) return x[i] - y[i];
    }

    return 0;
}

// The tag ghul-cli takes for `compiler`: the entry with the newest earliest
// compiler that is no newer than it, as ghul-cli's own pinned_tag does.
function pinnedTag(source, compiler) {
    const pins = [...source.matchAll(/earliest_compiler\s*=\s*"([^"]+)",\s*tag\s*=\s*"([^"]+)"/g)]
        .map(m => ({ earliest: m[1], tag: m[2] }))
        .filter(p => compareVersions(p.earliest, compiler) <= 0)
        .sort((a, b) => compareVersions(a.earliest, b.earliest));

    return pins.length ? pins[pins.length - 1].tag : null;
}

function dockerArg(text, name) {
    const match = text.match(new RegExp(`^ARG ${name}=(.+)$`, 'm'));

    if (!match) {
        throw new Error(`Dockerfile: no ${name}`);
    }

    return match[1].trim();
}

async function main() {
    const dockerfile = fs.readFileSync(path.join(root, 'compile-service/Dockerfile'), 'utf8');

    const compiler = dockerArg(dockerfile, 'GHUL_COMPILER_VERSION');

    // A compiler names the oldest release of each library it works with in
    // build/requirements.json at its own tag, and each library release names
    // the oldest compiler that builds it in a requirements.json of its own.
    // ghul-cli takes the newest release satisfying both, falling back on its
    // pin table only for a compiler from before the file, so the image is
    // held to the same rule. The native views' ghul-llvm is named there too.
    let requirements = null;

    try {
        requirements = JSON.parse(await fetchText(
            `https://raw.githubusercontent.com/ghul-lang/ghul/v${compiler}/build/requirements.json`));
    } catch {
        requirements = null;
    }

    const checks = [
        { library: 'ghul-core', file: 'core_library.ghul', arg: 'GHUL_CORE_VERSION' },
        { library: 'ghul-runtime', file: 'runtime_library.ghul', arg: 'GHUL_RUNTIME_VERSION' }
    ];

    let failed = false;

    for (const { library, file, arg } of checks) {
        const actual = dockerArg(dockerfile, arg);

        if (requirements?.[library]) {
            const floor = requirements[library];
            let own = null;

            try {
                own = JSON.parse(await fetchText(
                    `https://raw.githubusercontent.com/ghul-lang/${library}/v${actual}/requirements.json`))['minimum-compiler'];
            } catch {
                own = null;
            }

            if (compareVersions(actual, floor) < 0) {
                failed = true;
                console.error(`${library}: the image takes v${actual}, but compiler ${compiler} requires v${floor} or newer; ` +
                    `set ${arg} in compile-service/Dockerfile`);
            } else if (own && compareVersions(own, compiler) > 0) {
                failed = true;
                console.error(`${library}: v${actual} requires compiler ${own} or newer, but the image takes ${compiler}; ` +
                    `set ${arg} in compile-service/Dockerfile`);
            } else {
                console.log(`${library}: v${actual}, which compiler ${compiler} accepts and which accepts it`);
            }

            continue;
        }

        const wanted = pinnedTag(await fetchText(`${PINS}/${file}`), compiler);

        if (wanted === `v${actual}`) {
            console.log(`${library}: v${actual}, as ghul-cli pins for compiler ${compiler}`);
            continue;
        }

        failed = true;

        console.error(`${library}: the image takes v${actual}, but ghul-cli pins ${wanted ?? 'none'} ` +
            `for compiler ${compiler}; set ${arg} in compile-service/Dockerfile to match`);
    }

    const llvm = `v${dockerArg(dockerfile, 'GHUL_LLVM_VERSION')}`;

    if (!requirements) {
        console.log(`ghul-llvm: compiler ${compiler} names no release, so ${llvm} is not checked`);
    }

    if (requirements?.['ghul-llvm']) {
        const named = `v${requirements['ghul-llvm']}`;

        if (named === llvm) {
            console.log(`ghul-llvm: ${llvm}, as compiler ${compiler} requires`);
        } else {
            failed = true;
            console.error(`ghul-llvm: the image takes ${llvm}, but compiler ${compiler} requires ${named}; ` +
                'set GHUL_LLVM_VERSION in compile-service/Dockerfile to match');
        }
    }

    // The analyse service reads the same library sources for a wasm session,
    // so what the editor reports is what the wasm compile says. check-versions
    // already holds the compiler and runtime versions of the two images equal.
    const analyse = fs.readFileSync(path.join(root, 'analyse-service/Dockerfile'), 'utf8');
    const compileCore = dockerArg(dockerfile, 'GHUL_CORE_VERSION');
    const analyseCore = dockerArg(analyse, 'GHUL_CORE_VERSION');

    if (analyseCore === compileCore) {
        console.log(`ghul-core: v${analyseCore} in the analyse image too`);
    } else {
        failed = true;
        console.error(`ghul-core: the analyse image takes v${analyseCore} and the compile image v${compileCore}; ` +
            'set GHUL_CORE_VERSION in analyse-service/Dockerfile to match');
    }

    process.exit(failed ? 1 : 0);
}

if (require.main === module) {
    main().catch(e => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = { pinnedTag, compareVersions };
