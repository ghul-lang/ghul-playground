// Every ghul.dev example, through the compile service.
//
// The service compiles against a deliberately short reference list rather than
// the compiler's usual set, so an example can build everywhere else and fail
// here. That is the case this covers, and it is the one a reader meets first:
// the examples on the site are what they paste into the playground.
//
//   CORPUS=../ghul-dev/examples node test/corpus.js
//   CORPUS=... SERVICE=http://127.0.0.1:5090 node test/corpus.js
//
// Expects the compile service to be running and the corpus to be a directory
// of <name>/<name>.ghul. Exits non-zero if an example that should compile does
// not.
//
// What each example is expected to do is read from the ghul-dev suite beside
// it rather than restated here. A case carrying `fail.expected` documents a
// compile error, and a case built `--library` declares types without an entry
// point - which this service has no way to accept, since it compiles a program
// to run in the browser and offers no library mode. Both are expected not to
// compile, and it is a change in that answer, either way, that this reports.

const fs = require('fs');
const path = require('path');

const CORPUS = process.env.CORPUS ?? '../ghul-dev/examples';
const SERVICE = process.env.SERVICE ?? 'http://127.0.0.1:5090';
const TESTS = process.env.CORPUS_TESTS ?? path.join(CORPUS, '..', 'example-tests');

// A handful at a time: the service caps concurrency and answers 503 past the
// queue, and a flood would measure the cap rather than the compiler.
const CONCURRENCY = Number(process.env.CORPUS_CONCURRENCY ?? 4);

function expectedToFail(name) {
    if (fs.existsSync(path.join(TESTS, name, 'fail.expected'))) return true;

    return isLibrary(path.join(TESTS, name));
}

// An example built as a library has no entry point, so it is not a program
// the service can run. A test says so with "library": true in its test.json,
// or with --library in its flags; one written before test.json says it in its
// ghulflags.
function isLibrary(test) {
    const settings = path.join(test, 'test.json');

    if (fs.existsSync(settings)) {
        const text = fs.readFileSync(settings, 'utf8')
            .replace(/^\uFEFF/, '')
            .replace(/\/\/[^\n]*/g, '')
            .replace(/,(\s*[}\]])/g, '$1');
        const parsed = JSON.parse(text);

        return parsed.library === true || (parsed.flags ?? '').split(/\s+/).includes('--library');
    }

    const flags = path.join(test, 'ghulflags');

    return fs.existsSync(flags) && fs.readFileSync(flags, 'utf8').includes('--library');
}

function corpus() {
    return fs.readdirSync(CORPUS, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(name => fs.existsSync(path.join(CORPUS, name, `${name}.ghul`)))
        // Project-backed examples reference ASP.NET and are not single-file
        // programs, so they are not something this service can be asked for.
        .filter(name => !fs.readdirSync(path.join(CORPUS, name)).some(f => f.endsWith('.ghulproj')))
        // A native example is a ghul-cli project for the llvm target, which
        // the service doesn't compile for, and the site never sends here.
        .filter(name => !fs.existsSync(path.join(CORPUS, name, 'ghul-project.json')))
        .sort();
}

async function compile(source) {
    const response = await fetch(`${SERVICE}/compile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source })
    });

    if (response.status === 503) return { busy: true };

    if (!response.ok) {
        return { ok: false, diagnostics: [], error: `HTTP ${response.status}` };
    }

    return response.json();
}

async function attempt(source) {
    // A 503 is the queue being full rather than an answer about the program,
    // so it is waited out rather than counted.
    for (let i = 0; i < 20; i++) {
        const result = await compile(source);

        if (!result.busy) return result;

        await new Promise(r => setTimeout(r, 500));
    }

    return { ok: false, diagnostics: [], error: 'service stayed busy' };
}

(async () => {
    const names = corpus();

    if (names.length === 0) {
        console.error(`no examples under ${CORPUS}`);
        process.exit(1);
    }

    console.log(`${names.length} examples through ${SERVICE}`);

    const failures = [];
    let done = 0;
    let index = 0;

    async function worker() {
        while (index < names.length) {
            const name = names[index++];
            const source = fs.readFileSync(path.join(CORPUS, name, `${name}.ghul`), 'utf8');

            const result = await attempt(source);
            const shouldFail = expectedToFail(name);

            if (result.ok === shouldFail) {
                const errors = (result.diagnostics ?? [])
                    .filter(d => d.severity === 'error')
                    .map(d => `${d.startLine},${d.startColumn}: ${d.message}`);

                failures.push({
                    name,
                    why: shouldFail ? 'compiled, but is not expected to' : 'did not compile',
                    detail: result.error ?? errors[0] ?? ''
                });
            }

            if (++done % 50 === 0) console.log(`  ${done}/${names.length}`);
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (failures.length === 0) {
        console.log(`all ${names.length} examples behaved as the site documents`);
        process.exit(0);
    }

    console.error(`\n${failures.length} of ${names.length} did not:`);

    for (const f of failures.sort((a, b) => a.name.localeCompare(b.name))) {
        console.error(`  ${f.name}: ${f.why}${f.detail ? ` - ${f.detail}` : ''}`);
    }

    process.exit(1);
})();
