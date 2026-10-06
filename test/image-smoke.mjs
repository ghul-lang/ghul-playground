// Checks the built service images rather than the source they come from: an
// image that leaves out a module the service loads, or a library it compiles
// against, passes every test run from the checkout and fails on its first
// request in production.
//
// Run from inside the compile container, with both containers on a network
// that reaches nothing outside it, as production's do not: a tool that
// reaches out to the internet works on a runner and hangs in production.
//
//   docker exec -e ANALYSE_URL=http://analyse:5091 compile node /tmp/image-smoke.mjs

const COMPILE = process.env.COMPILE_URL ?? 'http://127.0.0.1:5090';
const ANALYSE = process.env.ANALYSE_URL ?? 'http://127.0.0.1:5091';

// Longer than any compile, so a request that runs past it is one that hung.
const REQUEST_MS = 90000;

let failures = 0;
const check = (what, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : ' - ' + detail}`);
    if (!ok) failures++;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function json(url, body) {
    const response = await fetch(url, body === undefined ? { signal: AbortSignal.timeout(REQUEST_MS) } : {
        signal: AbortSignal.timeout(REQUEST_MS),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });

    return { status: response.status, result: await response.json().catch(() => null) };
}

// Until each service answers healthy, which for the compile service means it
// has compiled a program.
async function healthy(base, ready) {
    for (let i = 0; i < 120; i++) {
        try {
            const { status, result } = await json(`${base}/health`);
            if (status === 200 && ready(result)) return result;
        } catch { /* not listening yet */ }
        await sleep(2000);
    }

    return null;
}

const HELLO = 'use IO.Std.write_line\n\nentry() is\n    write_line("hello {6 * 7}")\nsi\n';
const DRAWING = 'use Raster.IMAGE\n\nentry() is\n    let image = IMAGE(40, 30)\n' +
    '    image.line(0.0D, 0.0D, 40.0D, 30.0D)\n    image.write("dot.png")\n    image.show("dot.png")\nsi\n';

const compileHealth = await healthy(COMPILE, h => h.ok === true);
check('the compile image starts and compiles its health program', compileHealth !== null);
check('it offers the wasm target', compileHealth?.targets?.includes('wasm'), JSON.stringify(compileHealth?.targets));

const analyseHealth = await healthy(ANALYSE, h => h.pool?.idle > 0);
check('the analyse image starts an analyser', analyseHealth !== null, JSON.stringify(analyseHealth));

if (compileHealth) {
    for (const target of ['dotnet', 'wasm']) {
        const built = await json(`${COMPILE}/compile`, { source: HELLO, target });
        check(`a program compiles for ${target}`, built.status === 200 && built.result?.ok,
            JSON.stringify(built.result?.diagnostics ?? built.result));
    }

    const drawn = await json(`${COMPILE}/compile`, { source: DRAWING, target: 'wasm' });
    check('a program that draws compiles for wasm', drawn.status === 200 && drawn.result?.ok,
        JSON.stringify(drawn.result?.diagnostics ?? drawn.result));

    const il = await json(`${COMPILE}/compile/view`, { source: HELLO, target: 'dotnet' });
    check('the IL view answers', il.status === 200 && il.result?.ok && il.result.language === 'il'
        && il.result.text.includes('.method'), JSON.stringify(il.result).slice(0, 200));

    const wat = await json(`${COMPILE}/compile/view`, { source: HELLO, target: 'wasm' });
    check('the WAT view answers', wat.status === 200 && wat.result?.ok && wat.result.language === 'wat'
        && wat.result.text.includes(';; main.ghul:') && wat.result.omitted > 0, JSON.stringify(wat.result).slice(0, 200));
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
