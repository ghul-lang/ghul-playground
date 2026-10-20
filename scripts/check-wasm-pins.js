// The compile service builds --target wasm programs against ghul-core and
// ghul-runtime sources at the tags its Dockerfile names, and links the native
// views with the ghul-llvm release it names. ghul-cli, which is how a reader
// builds the same program locally, always takes the newest release of each
// tool, so the image is held to the same rule: a program behaves here as it
// does with `ghul run --target wasm`.
//
// This checks the image takes the newest release of ghul-core, ghul-runtime
// and ghul-llvm, and that the analyse image reads the same ghul-core.
//
//   node scripts/check-wasm-pins.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.join(__dirname, '..');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'user-agent': 'ghul-playground-check-wasm-pins' } }, res => {
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

function dockerArg(text, name) {
    const match = text.match(new RegExp(`^ARG ${name}=(.+)$`, 'm'));

    if (!match) {
        throw new Error(`Dockerfile: no ${name}`);
    }

    return match[1].trim();
}

async function latestRelease(repository) {
    const release = await fetchJson(`https://api.github.com/repos/ghul-lang/${repository}/releases/latest`);

    return release.tag_name.replace(/^v/, '');
}

async function main() {
    const dockerfile = fs.readFileSync(path.join(root, 'compile-service/Dockerfile'), 'utf8');

    const checks = [
        { repository: 'ghul-core', arg: 'GHUL_CORE_VERSION' },
        { repository: 'ghul-runtime', arg: 'GHUL_RUNTIME_VERSION' },
        { repository: 'ghul-llvm', arg: 'GHUL_LLVM_VERSION' }
    ];

    let failed = false;

    for (const { repository, arg } of checks) {
        const actual = dockerArg(dockerfile, arg);
        const latest = await latestRelease(repository);

        if (actual === latest) {
            console.log(`${repository}: v${actual}, the newest release`);
        } else {
            failed = true;
            console.error(`${repository}: the image takes v${actual}, but the newest release is v${latest}; ` +
                `set ${arg} in compile-service/Dockerfile`);
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
