// The compile service builds --target wasm programs against ghul-core and
// ghul-runtime sources at the tags its Dockerfile names, and the analyse
// service reads the same ghul-core so what the editor reports is what the
// wasm compile says. This checks the two images name the same ghul-core.
//
//   node scripts/check-wasm-pins.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function dockerArg(text, name) {
    const match = text.match(new RegExp(`^ARG ${name}=(.+)$`, 'm'));

    if (!match) {
        throw new Error(`Dockerfile: no ${name}`);
    }

    return match[1].trim();
}

async function main() {
    const dockerfile = fs.readFileSync(path.join(root, 'compile-service/Dockerfile'), 'utf8');

    let failed = false;

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
