// The compile service builds --target wasm programs against ghul-core and
// ghul-runtime sources at the tags its Dockerfile names. ghul-cli, which is how
// a reader builds the same program locally, pins a tag of each library to each
// range of compiler versions. This checks the image takes the tags ghul-cli
// would take for the image's compiler, so a program behaves here as it does
// with `ghul run --target wasm`.
//
// The pins live in ghul-cli's source, so this reads them from its main branch.
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
        throw new Error(`compile-service/Dockerfile: no ${name}`);
    }

    return match[1].trim();
}

async function main() {
    const dockerfile = fs.readFileSync(path.join(root, 'compile-service/Dockerfile'), 'utf8');

    const compiler = dockerArg(dockerfile, 'GHUL_COMPILER_VERSION');

    const checks = [
        { library: 'ghul-core', file: 'core_library.ghul', arg: 'GHUL_CORE_VERSION' },
        { library: 'ghul-runtime', file: 'runtime_library.ghul', arg: 'GHUL_RUNTIME_VERSION' }
    ];

    let failed = false;

    for (const { library, file, arg } of checks) {
        const wanted = pinnedTag(await fetchText(`${PINS}/${file}`), compiler);
        const actual = `v${dockerArg(dockerfile, arg)}`;

        if (wanted === actual) {
            console.log(`${library}: ${actual}, as ghul-cli pins for compiler ${compiler}`);
            continue;
        }

        failed = true;

        console.error(`${library}: the image takes ${actual}, but ghul-cli pins ${wanted ?? 'none'} ` +
            `for compiler ${compiler}; set ${arg} in compile-service/Dockerfile to match`);
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
