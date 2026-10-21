// What an error event says besides its class: the name of one of the page's
// own scripts and the phase the page was in, and nothing a reader could have
// written. The page's listeners are driven with a stand-in window.
//
//   node test/error-detail.mjs

let failures = 0;

const check = (what, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

const listeners = {};
const workers = [];

globalThis.location = { href: 'https://ghul.dev/playground/rosetta-code/ludic-numbers', origin: 'https://ghul.dev', pathname: '/playground/rosetta-code/ludic-numbers' };
globalThis.window = {
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    Worker: class { constructor(url) { this.url = url; this.handlers = []; workers.push(this); } addEventListener(type, fn) { this.handlers.push(fn); } }
};

const { countErrors, reportError, setPhase } = await import('../web/wwwroot/errors.js');

let counted = [];
countErrors('mini-ide-error/standalone', path => counted.push(path));

const script = filename => listeners.error.forEach(fn => fn({ filename }));

setPhase('running');
script('https://ghul.dev/playground/main.js?token=secret#x');

check('a script error names the page\'s own script and the phase',
    counted.join() === 'mini-ide-error/standalone/script/main.js/running', counted.join());

counted = [];
script('https://ghul.dev/playground/main.js');
check('a class is counted once a page load', counted.length === 0, counted.join());

// A fresh module state for each case that needs one.
async function fresh(setup) {
    listeners.error = []; listeners.unhandledrejection = []; workers.length = 0;
    const m = await import(`../web/wwwroot/errors.js?${Math.random()}`);
    const out = [];
    m.countErrors('f', path => out.push(path));
    setup(m);
    return out;
}

let out = await fresh(m => { m.setPhase('starting runtime'); listeners.unhandledrejection.forEach(fn => fn({})); });
check('a status with a space is read as one word', out.join() === 'f/unhandled-rejection/starting-runtime', out.join());

out = await fresh(() => script('https://evil.example/x.js'));
check('a script from another origin is not named', out.join() === 'f/script', out.join());

out = await fresh(() => script('https://ghul.dev/play ground/with space.js'));
check('a name that is not a plain file name is not recorded', out.join() === 'f/script', out.join());

out = await fresh(() => script('https://ghul.dev/playground/rosetta-code/ludic-numbers'));
check('an error from the page\'s own document is inline, not named by its address', out.join() === 'f/script/inline', out.join());

out = await fresh(() => script(''));
check('a cross-origin error with no file name has no source', out.join() === 'f/script', out.join());

out = await fresh(() => {
    new window.Worker('blob:https://ghul.dev/0e1f');
    workers[0].handlers.forEach(fn => fn({}));
});
check('a worker made in the page is a blob', out.join() === 'f/worker/blob', out.join());

out = await fresh(() => {
    new window.Worker('https://ghul.dev/playground/editor.worker.js');
    workers[0].handlers.forEach(fn => fn({}));
});
check('a worker from a script of the page is named', out.join() === 'f/worker/editor.worker.js', out.join());

out = await fresh(() => {
    new window.Worker('blob:https://elsewhere.example/0e1f');
    workers[0].handlers.forEach(fn => fn({}));
});
check('a worker from another origin is not named', out.join() === 'f/worker', out.join());

out = await fresh(m => { m.reportError('script', 'secret message with spaces'); });
check('words from a frame that are not plain are dropped', out.join() === 'f/script', out.join());

out = await fresh(m => { m.reportError('worker', 'main.js/running'); });
check('plain words from a frame are kept', out.join() === 'f/worker/main.js/running', out.join());

out = await fresh(m => { m.reportError('nonsense', 'main.js'); });
check('a class the page does not know is dropped', out.length === 0, out.join());

console.log(failures ? `${failures} failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
