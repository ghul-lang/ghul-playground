// The playground in a real browser: does the editor load, does the analyser
// answer, and does a program compile and run?
//
// There is no way to check this without a browser. The pieces that break are
// the ones only a browser exercises: the wasm runtime, Monaco's loader, the
// WebSocket to the analyse service, and the interaction between them.
//
//   node test/browser-end-to-end.js
//   BASE=https://playground.ghul.dev/ TOKEN=... node test/browser-end-to-end.js
//
// Needs a Chrome or Chromium binary; set CHROME if it is not where Playwright
// puts it. Drives it over the DevTools protocol rather than through a test
// framework, so it has no dependencies of its own.

const { spawn, execFileSync } = require('child_process');
const { startNginxStandIn } = require('./nginx-stand-in');

const CHROME = process.env.CHROME
    ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1140/chrome-linux/chrome`;

const BASE = process.env.BASE ?? 'http://127.0.0.1:5080/';
const TOKEN = process.env.TOKEN;
const PORT = Number(process.env.CDP_PORT ?? 9321);

// A run against a deployment would otherwise count itself: the pages honour
// ?notrack and send no events under it. The one page that checks the events
// themselves is navigated to without it, and serves a stub counter instead.
const untracked = url => {
    const u = new URL(url);

    u.searchParams.set('notrack', '');

    return u.toString();
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

let failures = 0;

// Chromium left running by an earlier run has init as its parent. Reported
// rather than killed, since it could belong to something else.
try {
    const orphans = execFileSync('ps', ['-eo', 'ppid=,args='], { encoding: 'utf8' })
        .split('\n')
        .filter(line => /^\s*1\s/.test(line) && line.includes('ms-playwright/chromium'))
        .length;

    if (orphans) log(`warning: ${orphans} Chromium process(es) left by an earlier run are still running`);
} catch { /* no ps to ask */ }

function check(what, ok, detail = '') {
    if (!ok) failures++;
    log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    // For a run against a stand-in for production, such as nginx in a container
    // answering for ghul.dev on another port: a JSON array, since a flag can
    // hold spaces.
    ...JSON.parse(process.env.CHROME_FLAGS ?? '[]'),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/ghul-playground-test-${process.pid}`,
    'about:blank'
], { stdio: 'ignore' });

// The browser outlives this process unless it is stopped, so it is stopped
// on every way out: the end of the run, a check that throws, a timeout's
// signal. Node reaches its exit event after an uncaught exception too.
process.on('exit', () => chrome.kill());

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
        log(`stopped by ${signal}`);
        process.exit(1);
    });
}

chrome.on('error', e => {
    console.error(`could not start ${CHROME}: ${e.message}`);
    process.exit(1);
});

(async () => {
    let target;
    for (let i = 0; i < 40; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = list.find(t => t.type === 'page');
            if (target) break;
        } catch { /* not listening yet */ }
        await sleep(500);
    }

    if (!target) { console.error('chrome never became available'); process.exit(1); }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));

    let id = 0;
    const pending = new Map();

    // Requests the browser has paused for the test to answer, by URL.
    const intercepted = new Map();

    // Exceptions a check raises on purpose, which are not failures.
    let expectedExceptions = 0;

    ws.addEventListener('message', e => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Fetch.requestPaused') answerIntercepted(m.params);
        if (m.method === 'Runtime.exceptionThrown' && expectedExceptions > 0) {
            expectedExceptions--;
        } else if (m.method === 'Runtime.exceptionThrown') {
            log(`page exception: ${m.params.exceptionDetails?.exception?.description
                ?? m.params.exceptionDetails?.text}`);
            failures++;
        }
    });

    const cmd = (method, params = {}) => new Promise(res => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });

    // Answered from the map, or as not found, with the header a cross-origin
    // fetch needs to be allowed to read the answer.
    function answerIntercepted({ requestId, request }) {
        const body = intercepted.get(request.url);

        ws.send(JSON.stringify({
            id: ++id,
            method: 'Fetch.fulfillRequest',
            params: {
                requestId,
                responseCode: body === undefined ? 404 : 200,
                responseHeaders: [
                    { name: 'Access-Control-Allow-Origin', value: '*' },
                    ...(request.url.endsWith('.js') ? [{ name: 'Content-Type', value: 'text/javascript' }] : []),
                    // A page standing in for ghul.dev's, framing the playground:
                    // it has to isolate itself as ghul.dev does, or the frame
                    // it holds cannot be.
                    ...(request.url.endsWith('.html') ? [
                        { name: 'Content-Type', value: 'text/html' },
                        { name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
                        { name: 'Cross-Origin-Embedder-Policy', value: 'require-corp' }
                    ] : [])
                ],
                body: Buffer.from(body ?? '').toString('base64')
            }
        }));
    }

    const ev = async expression => (await cmd('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

    await cmd('Runtime.enable');
    await cmd('Page.enable');

    // The token lives in the playground origin's storage, which is where a
    // reader would have entered it.
    if (TOKEN) {
        await cmd('Page.navigate', { url: untracked(new URL('embed.html', BASE)) });
        await sleep(4000);
        await ev(`localStorage.setItem('ghul-playground-token', ${JSON.stringify(TOKEN)}); true`);
    }

    await cmd('Page.navigate', { url: untracked(BASE) });

    for (let i = 0; i < 120; i++) {
        if (await ev(`document.getElementById('compiler')?.dataset.state === 'ready'`)) break;
        await sleep(500);
    }
    check('the runtime and editor load',
        await ev(`document.getElementById('compiler')?.dataset.state === 'ready'`),
        await ev(`document.getElementById('status')?.innerText`));

    // The help mentions the REPL exactly when the back end serves sessions.
    const replLink = await ev(`(async () => {
        const { replOffered } = await import('./playground.js');
        const offered = await replOffered();
        const help = document.getElementById('help-repl');
        const helpHref = document.getElementById('help-repl-link')?.getAttribute('href') ?? null;
        return JSON.stringify({ offered, bar: !!document.getElementById('repl-link'), help: !!help && !help.hidden, helpHref });
    })()`);

    check('the playground links to the REPL from its help, and not its bar, when sessions are on',
        (() => {
            const r = JSON.parse(replLink ?? '{}');
            return !r.bar && r.help === r.offered && (!r.help || !!r.helpHref);
        })(), replLink);

    for (let i = 0; i < 90; i++) {
        if (await ev(`document.getElementById('analyser')?.dataset.state === 'ready'`)) break;
        await sleep(500);
    }
    check('the analyser connects',
        await ev(`document.getElementById('analyser')?.dataset.state === 'ready'`),
        await ev(`document.getElementById('analyser')?.innerText`));

    // Diagnostics as you type: break the program and wait for a marker.
    const broken = [
        'use IO.Std.write_line;', '', 'entry() is',
        '    let squares = [1, 2, 3] | .map(n => n * n) | .collect_mutable();',
        '    write_line("{squares.no_such_member}");', 'si', ''
    ].join('\n');

    const started = Date.now();
    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(broken)}); true`);

    let markers = '[]';
    for (let i = 0; i < 120; i++) {
        markers = await ev(
            `JSON.stringify(monaco.editor.getModelMarkers({owner:'ghul-analyse'}).map(m => m.message))`);
        if (markers && markers !== '[]') break;
        await sleep(250);
    }
    check('live diagnostics arrive', markers !== '[]', `${Date.now() - started} ms, ${markers}`);

    // Hover, driven through the real UI: there is no public API to invoke it.
    await ev(`(() => {
        const editor = monaco.editor.getEditors()[0];
        editor.setPosition({ lineNumber: 4, column: 9 });
        editor.trigger('test', 'editor.action.showHover', {});
        return true;
    })()`);
    await sleep(2500);
    const hover = await ev(`(document.querySelector('.monaco-hover-content') || {}).innerText || null`);
    check('hover answers', Boolean(hover), hover ? JSON.stringify(hover.slice(0, 60)) : '');

    // Completion.
    await ev(`(() => {
        const editor = monaco.editor.getEditors()[0];
        editor.getModel().setValue('use IO.Std.write_line;\\n\\nentry() is\\n    let xs = [1, 2, 3] | .collect_mutable();\\n    xs.\\nsi\\n');
        editor.setPosition({ lineNumber: 5, column: 8 });
        return true;
    })()`);
    await sleep(1500);
    await ev(`monaco.editor.getEditors()[0].trigger('test','editor.action.triggerSuggest',{}); true`);
    await sleep(3000);

    const suggestions = await ev(
        `document.querySelectorAll('.suggest-widget .monaco-list-row').length`);
    check('completion offers members', suggestions > 0, `${suggestions} suggestion(s)`);

    // Compile and run, which exercises the compile service and the wasm host.
    await ev(`(() => {
        monaco.editor.getModels()[0].setValue(
            'use IO.Std.write_line;\\n\\nentry() is\\n    IO.Std.error.write_line("and complained");\\n    write_line("it ran");\\nsi\\n');
        return true;
    })()`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    // Waits for what the program actually prints rather than for the pane to
    // become non-empty: the pane carries a placeholder when there is no output,
    // which would satisfy "non-empty" the moment the tab is shown.
    let output = '';
    for (let i = 0; i < 180; i++) {
        output = await ev(`document.getElementById('output').innerText`);
        if (output.includes('it ran')) break;
        await sleep(500);
    }
    check('the program compiles and runs', output.includes('it ran'), JSON.stringify(output.trim()));

    // Standard error goes to the same stream as standard output, so a program
    // that writes to it is not left talking to the browser's own console,
    // where nobody using the page would look. The program writes this line
    // before the one above, so a run that got as far as the check above gave
    // this one its chance to arrive too.
    check('standard error reaches the output pane', output.includes('and complained'),
        JSON.stringify(output.trim()));

    // The pane's empty state is a verdict - the program produced no output -
    // and it used to appear the moment a run began, while the status bar still
    // said the run was compiling, telling a reader there was nothing to wait
    // for. What stands in the pane instead is the spinner, and the verdict is
    // for a run that has finished with nothing. A program that prints, goes
    // quiet, then prints again covers both: the spinner rides after the first
    // line through the quiet stretch, and neither line is ever called no
    // output.
    await ev(`(() => {
        monaco.editor.getModels()[0].setValue(
            'use IO.Std.write_line;\\n\\nentry() is\\n    write_line("before the wait");\\n'
            + '    System.Threading.Thread.sleep(System.TimeSpan.from_milliseconds(4000L));\\n'
            + '    write_line("after the wait");\\nsi\\n');
        return true;
    })()`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    const paneWithSpinner = () => ev(`(() => {
        const pane = document.getElementById('output').innerText;
        const spin = document.querySelector('#output .spin');
        return { pane: pane.trim(), spinning: Boolean(spin) };
    })()`);

    let spinnerAfterOutput = false;
    let verdictWhileRunning = false;
    let afterTheWait = null;
    for (let i = 0; i < 90; i++) {
        const state = await paneWithSpinner();
        if (state.pane.includes('before the wait') && state.spinning) spinnerAfterOutput = true;
        if (state.spinning && state.pane.includes('produced no output')) verdictWhileRunning = true;
        if (state.pane.includes('after the wait')) { afterTheWait = state; break; }
        await sleep(250);
    }
    check('the spinner rides after output through a quiet stretch', spinnerAfterOutput);
    check('no verdict while a run is under way', !verdictWhileRunning);
    check('the second line arrives and the spinner goes',
        afterTheWait && afterTheWait.pane.includes('after the wait') && !afterTheWait.spinning,
        afterTheWait ? JSON.stringify(afterTheWait.pane.slice(0, 60)) : 'never finished');

    // A run that genuinely produces nothing is told so, once it has finished.
    await ev(`(() => {
        monaco.editor.getModels()[0].setValue('entry() is\\n    let quiet = 1;\\nsi\\n');
        return true;
    })()`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let quietPane = null;
    for (let i = 0; i < 60; i++) {
        quietPane = await ev(`document.getElementById('output').innerText.trim()`);
        if (quietPane.includes('produced no output')) break;
        await sleep(500);
    }
    check('a run that produces nothing is said so at the end',
        quietPane.includes('The program produced no output.'), JSON.stringify(quietPane));

    // A program that reads a line. This is the one thing on the page that
    // cannot work at all unless the runtime is on a worker thread and the page
    // is cross-origin isolated, so it is also the check that says both are
    // true - and neither shows up as a failure anywhere else, because a
    // runtime that will not start looks like a run that never finishes.
    check('the page is cross-origin isolated', await ev(`self.crossOriginIsolated`));

    // Visibility rather than the hidden attribute. A style rule of its own
    // outranks the user agent's [hidden] rule, so the box can carry the
    // attribute and still be on screen - which it was, permanently, and no
    // check that asked the attribute could see it.
    const boxShowing = () => ev(`(() => { const r = document.getElementById('input-row');
                 return Boolean(r) && r.offsetParent !== null; })()`);

    // Asked separately, because boxShowing() is also false when the box is not
    // there at all - so on its own it would pass against a build that has no
    // input row, which is the one build where it means nothing.
    check('the input row exists',
        await ev(`Boolean(document.getElementById('input-row'))`));

    check('no box before a program has asked for a line', !(await boxShowing()));

    const reading = [
        'use IO.Std.write_line;', 'use IO.Std.read_line;', '', 'entry() is',
        '    write_line("what is your name?");', '', '    let name = read_line();', '',
        '    write_line("hello, {name ?? "nobody"}");', 'si', ''
    ].join('\n');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(reading)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let asked = false;
    for (let i = 0; i < 180; i++) {
        asked = await boxShowing();
        if (asked) break;
        await sleep(500);
    }
    check('a program that reads asks for a line', asked);

    // Mid-run, so this is the state the button is actually in while something
    // is running rather than what it settles back to afterwards.
    check('the button offers to stop while the program runs',
        (await ev(`document.getElementById('run-label').textContent`)) === 'Stop'
        && !(await ev(`document.getElementById('run').disabled`)));

    // The prompt has to be readable before anything is typed, which is only
    // possible if output reaches the page while the program is still running.
    check('output arrives before the run has finished',
        (await ev(`document.getElementById('output').innerText`)).includes('what is your name?'));

    await ev(`(() => {
        document.getElementById('stdin').value = 'world';
        document.getElementById('input-row')
            .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
    })()`);

    let answered = '';
    for (let i = 0; i < 180; i++) {
        answered = await ev(`document.getElementById('output').innerText`);
        if (answered.includes('hello, world')) break;
        await sleep(500);
    }
    check('the typed line reaches the program', answered.includes('hello, world'),
        JSON.stringify(answered.trim()));
    // A line of its own, so this is the echo rather than the greeting that
    // also contains the word.
    check('what was typed is echoed into the transcript', /^world$/m.test(answered));
    check('the box goes away once the run has finished', !(await boxShowing()));

    // Following the output. A program printing more than the pane holds, and
    // then asking for a line: the box appearing takes its height off the pane,
    // so a build that decides whether to follow by measuring the pane when the
    // text arrives reads as scrolled up from that moment on and never follows
    // again. The board games are exactly this shape.
    const long = [
        'use IO.Std.write_line;', 'use IO.Std.read_line;', '', 'entry() is',
        '    for i in 1::200 do', '        write_line("line {i}");', '    od', '',
        '    write_line("what is your name?");', '', '    let name = read_line();', '',
        '    write_line("hello, {name ?? "nobody"}");', 'si', ''
    ].join('\n');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(long)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let longAsked = false;
    for (let i = 0; i < 180; i++) {
        longAsked = await boxShowing();
        if (longAsked) break;
        await sleep(500);
    }
    check('a long program that reads asks for a line', longAsked);

    const pane = () => ev(`(() => { const o = document.getElementById('output');
                 return { top: o.scrollTop, height: o.clientHeight, total: o.scrollHeight }; })()`);

    // Asked first, because every check below passes for free on a pane whose
    // content fits - which is the one case where following means nothing.
    const asking = await pane();
    check('the output overflows the pane', asking.total > asking.height,
        JSON.stringify(asking));

    check('the pane follows the output up to the prompt',
        asking.top + asking.height >= asking.total - 4, JSON.stringify(asking));

    // Scrolled away from the tail on purpose, and then answered, so that more
    // output arrives while the reader is somewhere else. Following is for a
    // reader at the bottom, not a rule that drags one back from what they went
    // to look at.
    await ev(`(() => { const o = document.getElementById('output');
                 o.scrollTop = 0; return true; })()`);
    await sleep(200);

    await ev(`(() => {
        document.getElementById('stdin').value = 'world';
        document.getElementById('input-row')
            .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
    })()`);

    let longAnswered = '';
    for (let i = 0; i < 180; i++) {
        longAnswered = await ev(`document.getElementById('output').innerText`);
        if (longAnswered.includes('hello, world')) break;
        await sleep(500);
    }
    check('the long program read the typed line', longAnswered.includes('hello, world'));

    const parked = await pane();
    check('output arriving does not drag a scrolled-up reader back',
        parked.top < 4, JSON.stringify(parked));
    // The button is how a program is stopped while it runs, so it has to stay
    // live through that state rather than being disabled with the rest.
    check('the run button offers to stop a running program, and returns to Run after',
        (await ev(`document.getElementById('run-label').textContent`)) === 'Run'
        && !(await ev(`document.getElementById('run').hasAttribute('data-stop')`)));

    // Stop, clicked rather than merely looked at. The button showing the right
    // word proves nothing about what pressing it does: it went a whole round
    // saying Stop while still being wired to run the program again.
    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(reading)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let waiting = false;
    for (let i = 0; i < 180; i++) {
        waiting = await boxShowing();
        if (waiting) break;
        await sleep(500);
    }
    check('the program is waiting again', waiting);

    await ev(`document.getElementById('run').click(); true`);

    let stopped = '';
    for (let i = 0; i < 60; i++) {
        stopped = await ev(`document.getElementById('run-label').textContent`);
        if (stopped === 'Run') break;
        await sleep(500);
    }
    check('stopping ends the program rather than starting another', stopped === 'Run',
        await ev(`document.getElementById('status').textContent`));

    // Ending the input is what a waiting program is told, so it runs on to
    // whatever it does with no more input rather than being cut off.
    check('the stopped program saw the end of its input',
        (await ev(`document.getElementById('output').innerText`)).includes('hello, nobody'));

    // A program that draws: the picture has to survive being written to the
    // wasm filesystem, read back by the host, and carried to the page as a
    // data URL, and the marker naming it has to leave the text. Nothing short
    // of a browser exercises any of that.
    const drawing = require('fs')
        .readFileSync(`${__dirname}/../examples/draw.ghul`, 'utf8');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(drawing)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let drawn = 0;
    for (let i = 0; i < 180; i++) {
        drawn = await ev(`document.querySelectorAll('#images-grid img').length`);
        if (drawn > 0) break;
        await sleep(500);
    }

    check('a drawing reaches the page', drawn === 1, `${drawn} image(s)`);
    check('the picture decoded',
        await ev(`(() => { const i = document.querySelector('#images-grid img');
                           return Boolean(i && i.naturalWidth === 640 && i.naturalHeight === 400); })()`));
    check('the image marker leaves the output',
        !(await ev(`document.getElementById('output').innerText`)).includes('<<image'));

    // An animation: the same name shown over and over while the program runs,
    // each showing replacing the picture where it is. So the picture has to
    // change while the run is still going, and it has to be the same element
    // throughout - a pane rebuilt per frame flickers and loses its scroll.
    const bouncing = require('fs')
        .readFileSync(`${__dirname}/../examples/bounce.ghul`, 'utf8');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(bouncing)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    for (let i = 0; i < 180; i++) {
        if (await ev(`document.querySelectorAll('#images-grid img').length === 1
                      && document.getElementById('run-label').textContent === 'Stop'`)) break;
        await sleep(250);
    }

    await ev(`window.firstFrame = document.querySelector('#images-grid img'); true`);

    const frames = new Set();
    let sameElement = true;

    for (let i = 0; i < 20; i++) {
        const frame = await ev(`(() => {
            const img = document.querySelector('#images-grid img');
            return img ? { src: img.src, same: img === window.firstFrame,
                           running: document.getElementById('run-label').textContent === 'Stop' } : null;
        })()`);

        if (!frame?.running) break;

        frames.add(frame.src);
        sameElement &&= frame.same;

        await sleep(200);
    }

    check('an animation changes the picture while it runs', frames.size >= 3, `${frames.size} distinct frame(s)`);
    check('each frame replaces the picture in place', sameElement);

    for (let i = 0; i < 120; i++) {
        if (await ev(`document.getElementById('run-label').textContent`) === 'Run') break;
        await sleep(500);
    }

    const ended = await ev(`document.getElementById('output').innerText`);

    check('the animation finishes with one picture and no markers',
        ended.includes('done') && !ended.includes('<<image')
        && await ev(`document.querySelectorAll('#images-grid img').length`) === 1,
        JSON.stringify(ended.trim()));

    // A carriage return goes back to the start of the line, as a terminal's
    // does, which is how a text spinner draws in place.
    const spinner = [
        'use IO.Std.write;', '', 'entry() is',
        '    write("working |\\r");', '    write("finished  \\n");', 'si', ''
    ].join('\n');

    await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(spinner)}); true`);
    await sleep(1000);
    await ev(`document.getElementById('run').click(); true`);

    let spun = '';
    for (let i = 0; i < 120; i++) {
        spun = await ev(`document.getElementById('output').innerText`);
        if (spun.includes('finished')) break;
        await sleep(500);
    }
    check('a carriage return overwrites the line', spun.includes('finished') && !spun.includes('working'),
        JSON.stringify(spun));

    // The file menu, as far as a headless browser can be taken: the pickers
    // themselves are native dialogs with nothing to drive them, so what is
    // checked is that the menu opens, says what Save would do, and closes.
    await ev(`document.getElementById('images-close').click();
              document.getElementById('file-toggle').click(); true`);
    await sleep(500);

    check('the file menu opens', await ev(`!document.getElementById('file-menu').hidden`));
    check('Ctrl+S is the page\'s, not the browser\'s', await ev(`(() => {
        const e = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(e);
        return e.defaultPrevented;
    })()`));

    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(300);
    check('Escape closes the file menu', await ev(`document.getElementById('file-menu').hidden`));

    // A page out of sight gives its analyser session back, and takes one again
    // when it is looked at. A headless tab is never hidden, so the page is told
    // it is: the client reads document.hidden when the event arrives.
    const setHidden = hidden => ev(`(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
        document.dispatchEvent(new Event('visibilitychange'));
        return true;
    })()`);

    const analyserState = () => ev(`document.getElementById('analyser')?.dataset.state`);

    await setHidden(true);

    let released = '';
    for (let i = 0; i < 90; i++) {
        released = await analyserState();
        if (released === 'dormant') break;
        await sleep(500);
    }
    check('a hidden page gives its analyser session back', released === 'dormant', released);

    await setHidden(false);

    let resumed = '';
    for (let i = 0; i < 90; i++) {
        resumed = await analyserState();
        if (resumed === 'ready') break;
        await sleep(500);
    }
    check('and takes one again when it is looked at', resumed === 'ready', resumed);

    // A program opened by path is fetched from its collection into the editor,
    // which exercises the path fallback, the <base> the page's own assets are
    // resolved against, and the cross-origin fetch.
    await cmd('Page.navigate', { url: untracked(new URL('rosetta-code/hello-world-text', BASE)) });

    let opened = '';
    for (let i = 0; i < 120; i++) {
        opened = await ev(`globalThis.monaco?.editor.getModels()[0]?.getValue() ?? ''`);
        if (opened.includes('Hello world!')) break;
        await sleep(500);
    }
    check('a program opens by path', opened.includes('Hello world!'), JSON.stringify(opened.slice(0, 60)));

    let arrived = '';
    for (let i = 0; i < 180; i++) {
        arrived = await ev(`document.getElementById('output').innerText`) ?? '';
        if (arrived.includes('Hello world!')) break;
        await sleep(500);
    }
    check('a program opened by path runs on arrival', arrived.includes('Hello world!'), JSON.stringify(arrived.trim()));

    for (let i = 0; i < 60; i++) {
        if (await ev(`document.getElementById('run-label').textContent`) === 'Run') break;
        await sleep(500);
    }

    // The path says where the buffer came from, so editing the program leaves
    // it alone - the link still loads what it names - while replacing the
    // buffer wholesale gives it up, along with the name Save would offer.
    await ev(`monaco.editor.getModels()[0].applyEdits(
        [{ range: new monaco.Range(1, 1, 1, 1), text: '// edited\\n' }]); true`);
    await sleep(300);
    check('editing a program keeps its path',
        await ev(`location.pathname`) === new URL('rosetta-code/hello-world-text', BASE).pathname);

    await ev(`monaco.editor.getModels()[0].setValue('entry() is si\\n'); true`);
    await sleep(300);
    check('replacing the buffer gives up the path', await ev(`location.pathname`) === new URL(BASE).pathname);

    // A program that reads files it names in playground-files. The collection
    // is served by the test rather than fetched, so this checks the playground
    // and not what the repository holds today. One file is reached through a
    // path outside the task's own directory, as a shared one would be.
    const TASKS = 'https://raw.githubusercontent.com/ghul-lang/ghul-rosetta-code/main/';
    const INDEX_URL = 'https://raw.githubusercontent.com/ghul-lang/ghul-rosetta-code/index/index.json';
    const reader = [
        'use IO.Std.write_line;', '', 'entry() is',
        '    for line in IO.File.read_all_lines("words.txt") do',
        '        write_line("read {line}");',
        '    od', '',
        '    write_line(IO.File.read_all_text("notes.txt"));',
        '    IO.File.write_all_text("notes.txt", "changed");',
        'si', ''
    ].join('\n');

    intercepted.set(`${TASKS}tasks/reads-files/reads-files.ghul`, reader);
    intercepted.set(`${TASKS}tasks/reads-files/playground-files`, '../../data/words.txt\nnotes.txt\n');
    intercepted.set(`${TASKS}data/words.txt`, 'alpha\nbeta\n');
    intercepted.set(`${TASKS}tasks/reads-files/notes.txt`, 'from the notes');
    // Carries a recorded wait before the program's first line, as the tasks
    // measured as slow do, so the run below can check the page says so.
    intercepted.set(`${TASKS}tasks/reads-files/task.json`,
        '{ "task": "Reads files", "first_output_ms": 5000 }');

    // The analytics counter, replaced by one that records what it is asked
    // to count, so the run events can be checked without a GoatCounter. It
    // keeps the two rules of the real one that decide whether anything is
    // counted at all: nothing from inside a frame unless allow_frame is set,
    // and a pageview on load unless no_onload is. The pageview goes in a list
    // of its own, so the checks on events are not shifted by it.
    const COUNTER = new URL('/stats/count.js', BASE).toString();
    intercepted.set(COUNTER, [
        'window.goatcounter.count = e => {',
        '    if (!window.goatcounter.allow_frame && location !== parent.location) return;',
        '    (window.counted ??= []).push(e.path);',
        '};',
        'if (!window.goatcounter.no_onload && (window.goatcounter.allow_frame || location === parent.location)) {',
        '    (window.pageviews ??= []).push(location.pathname);',
        '}'
    ].join('\n'));

    // A page framing a task as ghul.dev's pages do, as a panel.
    const FRAMING = new URL('framing.html', BASE).toString();
    intercepted.set(FRAMING,
        '<!DOCTYPE html><iframe src="rosetta-code/takes-args?panel&host=rosetta-task-page" style="width: 1000px; height: 700px"></iframe>');

    // The real counter has already loaded on an earlier page, and a deployed
    // one is cacheable for a day: from the cache it would never reach the
    // interception above.
    await cmd('Network.enable');
    await cmd('Network.setCacheDisabled', { cacheDisabled: true });

    await cmd('Fetch.enable', { patterns: [
        { urlPattern: `${TASKS}*` }, { urlPattern: INDEX_URL }, { urlPattern: COUNTER }, { urlPattern: FRAMING }
    ] });
    await cmd('Page.navigate', { url: new URL('rosetta-code/reads-files', BASE).toString() });

    let ready = false;
    for (let i = 0; i < 120; i++) {
        ready = await ev(`document.getElementById('compiler')?.dataset.state === 'ready'
            && (globalThis.monaco?.editor.getModels()[0]?.getValue() ?? '').includes('words.txt')`);
        if (ready) break;
        await sleep(500);
    }
    check('a program that reads files opens by path', ready);

    // Run twice: the program overwrites one of its inputs, and the second run
    // has to be handed the original again. The first run is the one the page
    // starts itself on arrival.
    let waitNoteSeen = false;
    let waitNoteText = '';

    for (const attempt of ['first', 'second']) {
        if (attempt === 'second') await ev(`document.getElementById('run').click(); true`);

        let read = '';
        for (let i = 0; i < 180; i++) {
            const note = await ev(`document.querySelector('#output .note')?.textContent`);

            if (note) {
                waitNoteSeen = true;
                waitNoteText = note;
            }

            read = await ev(`document.getElementById('output').innerText`) ?? '';
            if (read.includes('from the notes') || read.includes('unhandled')) break;
            await sleep(500);
        }
        check(`the program reads the files it names (${attempt} run)`,
            read.includes('read alpha') && read.includes('read beta') && read.includes('from the notes'),
            JSON.stringify(read.trim()));

        for (let i = 0; i < 60; i++) {
            if (await ev(`document.getElementById('run-label').textContent`) === 'Run') break;
            await sleep(500);
        }
    }

    // The recorded wait is said beside the spinner while the program has yet
    // to print, and only there: once its output arrives the pane is the
    // program's again.
    check('a recorded wait is said while the program is silent',
        waitNoteSeen && waitNoteText.includes('works silently') && waitNoteText.includes('seconds'),
        JSON.stringify(waitNoteText.trim()));
    check('and stops being said once the program has printed',
        !(await ev(`Boolean(document.querySelector('#output .note'))`)));

    const about = await ev(`(() => { const a = document.getElementById('task-identity');
                 return a.offsetParent !== null ? a.innerText : null; })()`);
    check('the program is named in the tab row', about?.startsWith('Reads files'), JSON.stringify(about));
    check('and linked to its page on ghul.dev', await ev(
        `Boolean(document.querySelector('#task-identity a[href="https://ghul.dev/rosetta/reads-files"]'))`));

    const counted = JSON.parse(await ev(`JSON.stringify(window.counted ?? [])`));
    const shown = JSON.stringify(counted);

    // The runs and their outcomes, in order: this is the part that has to be
    // exactly right, and the only part that does not depend on how long
    // anything took or on what the browser's colour scheme is.
    check('the run on arrival and the one asked for are counted apart, each with one outcome',
        JSON.stringify(counted.filter(p => /^mini-ide-(run|result)\/standalone\//.test(p))) === JSON.stringify([
            'mini-ide-run/standalone/automatic/rosetta-code/reads-files',
            'mini-ide-result/standalone/compiled-ok',
            'mini-ide-run/standalone/manual/rosetta-code/reads-files',
            'mini-ide-result/standalone/compiled-ok'
        ]), shown);

    check('the page load is counted once, saying where the program came from',
        counted.filter(p => p === 'mini-ide-open/standalone/rosetta-code').length === 1, shown);

    // Twice would mean the second run was counted as a cold start, which it is
    // not: the runtime is in the browser's cache by then.
    check('the wait for first output is counted once, for the first run only',
        counted.filter(p => /^mini-ide-first-output\/standalone\/(under-1s|1-3s|3-10s|over-10s)$/.test(p)).length === 1,
        shown);

    // --- a command line ---------------------------------------------------

    // The reads-files page takes no arguments, so the row is not there.
    check('a program that takes no arguments shows no arguments row',
        await ev(`document.getElementById('arguments-row').offsetParent === null`));

    // A task that names its arguments in run.args, exactly as the corpus does.
    // The program writes each one back in brackets, so an argument containing a
    // space can be told from two arguments.
    const echo = [
        'use IO.Std.write_line;', '', 'entry(args: string[]) is',
        '    write_line("count {args.count}");', '',
        '    for argument in args do',
        '        write_line("[{argument}]");',
        '    od', 'si', ''
    ].join('\n');

    intercepted.set(`${TASKS}tasks/takes-args/takes-args.ghul`, echo);
    intercepted.set(`${TASKS}tasks/takes-args/run.args`, '-c\nalpha beta\n"quoted"\n');
    intercepted.set(`${TASKS}tasks/takes-args/task.json`, '{ "task": "Takes args" }');

    // Not untracked, like the page before it: the events are checked against
    // the stub counter, which ?notrack would stop reaching.
    await cmd('Page.navigate', { url: new URL('rosetta-code/takes-args', BASE).toString() });

    let echoed = '';
    for (let i = 0; i < 240; i++) {
        echoed = await ev(`document.getElementById('output').innerText`) ?? '';
        if (echoed.includes('count ')) break;
        await sleep(500);
    }

    check('a task naming its arguments runs with them', echoed.includes('count 3')
        && echoed.includes('[-c]') && echoed.includes('[alpha beta]') && echoed.includes('["quoted"]'),
        JSON.stringify(echoed.trim()));

    check('and the row shows them, quoted as a command line is',
        await ev(`document.getElementById('arguments').value`) === '-c "alpha beta" "\\"quoted\\""',
        JSON.stringify(await ev(`document.getElementById('arguments').value`)));

    check('and the row is visible without being asked for',
        await ev(`document.getElementById('arguments-row').offsetParent !== null`));

    // What the reader types is what the program gets, including a space inside
    // one argument and a quote inside another.
    await ev(`(() => {
        const field = document.getElementById('arguments');
        field.value = '"two words" plain "say \\\\"hi\\\\""';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);

    await ev(`document.getElementById('run').click(); true`);

    let retyped = '';
    for (let i = 0; i < 240; i++) {
        retyped = await ev(`document.getElementById('output').innerText`) ?? '';
        if (retyped.includes('count 3') && retyped.includes('[plain]')) break;
        await sleep(500);
    }

    check('a command line the reader types reaches the program exactly',
        retyped.includes('count 3') && retyped.includes('[two words]')
        && retyped.includes('[plain]') && retyped.includes('[say "hi"]'),
        JSON.stringify(retyped.trim()));

    // Using the field is counted; what is in it never is.
    const withArguments = JSON.parse(await ev(`JSON.stringify(window.counted ?? [])`));

    check('using the arguments field is counted once, and its contents are not',
        withArguments.filter(p => p === 'mini-ide-action/standalone/arguments').length === 1
        && !withArguments.some(p => /alpha|quoted|two words|plain/.test(p)),
        JSON.stringify(withArguments));

    // --- failures the server cannot see -----------------------------------

    // Counted by class, once a page load, and never with what the error said.
    expectedExceptions = 3;

    await ev(`setTimeout(() => { throw new Error('secret-one'); }); true`);
    await ev(`setTimeout(() => { throw new Error('secret-two'); }); true`);
    await ev(`setTimeout(() => { Promise.reject(new Error('secret-three')); }); true`);
    await sleep(500);

    const withErrors = JSON.parse(await ev(`JSON.stringify(window.counted ?? [])`));

    check('a script error is counted once, by class',
        withErrors.filter(p => p === 'mini-ide-error/standalone/script').length === 1, JSON.stringify(withErrors));
    check('and an unhandled rejection likewise',
        withErrors.filter(p => p === 'mini-ide-error/standalone/unhandled-rejection').length === 1, JSON.stringify(withErrors));
    check('with nothing the error said', !withErrors.some(p => p.includes('secret')), JSON.stringify(withErrors));

    // Whatever the block did not use up must not excuse a real failure later.
    expectedExceptions = 0;

    // --- a framed panel counts its runs -----------------------------------

    // ghul.dev frames a task on its own page and counts the view there, so the
    // panel counts no pageview of its own - but what happens inside it, the
    // run and its result, only the panel can see.
    await cmd('Page.navigate', { url: FRAMING });

    const inFrame = expression => ev(`(() => {
        const frame = document.querySelector('iframe')?.contentWindow;
        return frame ? frame.eval(${JSON.stringify(expression)}) : null;
    })()`);

    let framedOutput = '';
    for (let i = 0; i < 240; i++) {
        framedOutput = await inFrame(`document.getElementById('output')?.innerText ?? ''`) ?? '';
        if (framedOutput.includes('count ')) break;
        await sleep(500);
    }

    check('a framed panel runs its task on arrival', framedOutput.includes('count 3'),
        JSON.stringify(framedOutput.trim()));

    const framedCounted = JSON.parse(await inFrame(`JSON.stringify(window.counted ?? [])`) ?? '[]');

    check('and counts the run and its result, saying which page it was on',
        framedCounted.some(p => /^mini-ide-run\/rosetta-task-page\//.test(p))
        && framedCounted.some(p => /^mini-ide-result\/rosetta-task-page\//.test(p)),
        JSON.stringify(framedCounted));

    check('but no pageview of its own',
        JSON.parse(await inFrame(`JSON.stringify(window.pageviews ?? [])`) ?? '[]').length === 0);

    // A program that takes none: the reader can still ask for the field.
    await cmd('Page.navigate', { url: new URL('rosetta-code/reads-files', BASE).toString() });

    for (let i = 0; i < 120; i++) {
        if (await ev(`document.getElementById('compiler')?.dataset.state === 'ready'`)) break;
        await sleep(500);
    }

    check('the row is hidden again on a task that names no arguments',
        await ev(`document.getElementById('arguments-row').offsetParent === null`));

    await ev(`document.getElementById('file-toggle').click(); true`);
    await sleep(300);
    await ev(`document.getElementById('file-arguments').click(); true`);
    await sleep(300);

    check('and the File menu brings it up',
        await ev(`document.getElementById('arguments-row').offsetParent !== null`)
        && await ev(`document.getElementById('arguments').value`) === '');
    // --- more to run ------------------------------------------------------

    // The index is fetched from the collection, which this section is serving,
    // and nothing answers for it yet - so this is the failed-fetch case: the
    // strip stays hidden and the line above it is untouched.
    check('a task index that will not load leaves no strip',
        await ev(`document.getElementById('more-to-run').offsetParent === null`));
    check('and leaves the task named in the tab row alone', about?.startsWith('Reads files'));

    // A made-up index, so what the strip offers is decided here rather than by
    // what the corpus happens to hold today. `cannot-run` is what a task
    // carrying playground-unsupported looks like from the index: the generator
    // writes that file's absence as this flag, and the strip reads the flag.
    const task = (slug, title, tags, parts) => ({
        slug, title, tags, images: [], playground: true,
        parts: parts ?? [{ id: slug, heading: null, playground: true, images: [] }]
    });

    const INDEX = {
        version: 1,
        tags: { files: 'reads or writes a file' },
        showcase: ['show-off'],
        tasks: [
            task('reads-files', 'Reads files', ['files']),
            task('related-one', 'Related one', ['files']),
            task('related-two', 'Related two', ['files']),
            { ...task('cannot-run', 'Cannot run', ['files']), playground: false,
              parts: [{ id: 'cannot-run', heading: null, playground: false, images: [] }] },
            task('show-off', 'Show off', ['strings']),
            task('two-parts', 'Two parts', ['files'], [
                { id: 'two-parts/01-first', heading: 'The first way', playground: true, images: [] },
                { id: 'two-parts/02-second', heading: 'The second way', playground: true, images: [] }
            ])
        ]
    };

    intercepted.set(INDEX_URL, JSON.stringify(INDEX));

    const says = (slug, text) => {
        intercepted.set(`${TASKS}tasks/${slug}/${slug.split('/').at(-1)}.ghul`,
            `use IO.Std.write_line;\n\nentry() is\n    write_line("${text}");\nsi\n`);
        intercepted.set(`${TASKS}tasks/${slug.split('/')[0]}/task.json`,
            JSON.stringify({ task: INDEX.tasks.find(t => t.slug === slug.split('/')[0])?.title ?? slug }));
    };

    for (const slug of ['related-one', 'related-two', 'show-off', 'cannot-run']) says(slug, slug);
    says('two-parts/01-first', 'the first way');
    says('two-parts/02-second', 'the second way');

    // Waits for a program to have run: the pane carries a placeholder from the
    // moment a run starts, so the text the program printed is the only signal.
    const ranSaying = async text => {
        for (let i = 0; i < 180; i++) {
            if ((await ev(`document.getElementById('output').innerText`) ?? '').includes(text)) return true;
            await sleep(500);
        }
        return false;
    };

    const cards = () => ev(`JSON.stringify([...document.querySelectorAll('#suggestions a')]
        .map(a => [a.textContent, a.title]))`);

    await cmd('Page.navigate', { url: new URL('rosetta-code/reads-files', BASE).toString() });

    check('a task with an index runs on arrival', await ranSaying('from the notes'));

    // The index is fetched at the first output and not before it, so the strip
    // arrives a moment after the program's own text does.
    for (let i = 0; i < 60; i++) {
        if (await ev(`document.querySelectorAll('#suggestions a').length > 0`)) break;
        await sleep(500);
    }

    const offered = JSON.parse(await cards() ?? '[]');

    check('three tasks are offered once a program has run',
        offered.length === 3, JSON.stringify(offered));
    check('a task that cannot run here is not among them',
        !offered.some(([title]) => title === 'Cannot run'), JSON.stringify(offered));
    check('the task being run is not among them',
        !offered.some(([title]) => title === 'Reads files'), JSON.stringify(offered));
    check('a related card says what the two tasks have in common, in the index\'s own words',
        offered[0]?.[1] === 'reads or writes a file', JSON.stringify(offered[0]));
    check('the showcase pick is last and says why it is there',
        offered[2]?.[0] === 'Show off' && offered[2]?.[1] === 'worth seeing', JSON.stringify(offered[2]));

    // --- taking one -------------------------------------------------------

    const taking = offered[0][0];

    await ev(`document.querySelectorAll('#suggestions a')[0].click(); true`);

    check('taking a suggestion swaps the program in and runs it', await ranSaying('related-one'),
        JSON.stringify(await ev(`document.getElementById('output').innerText`)));
    check('and the URL becomes that task\'s own',
        await ev(`location.pathname`) === new URL('rosetta-code/related-one', BASE).pathname,
        await ev(`location.pathname`));
    check('and the tab row names it',
        (await ev(`document.getElementById('task-identity').innerText`) ?? '').startsWith('Related one'),
        await ev(`document.getElementById('task-identity').innerText`));
    check('and the editor holds its source',
        (await ev(`monaco.editor.getModels()[0].getValue()`) ?? '').includes('related-one'));
    check('and the strip no longer offers the task now being run',
        !JSON.parse(await cards() ?? '[]').some(([title]) => title === taking));

    await ev(`history.back(); true`);

    check('Back returns to the task it was taken from', await ranSaying('from the notes'),
        JSON.stringify(await ev(`document.getElementById('output').innerText`)));
    check('and the URL goes back with it',
        await ev(`location.pathname`) === new URL('rosetta-code/reads-files', BASE).pathname,
        await ev(`location.pathname`));

    // --- a task solved more than one way ----------------------------------

    await cmd('Page.navigate', { url: new URL('rosetta-code/two-parts/01-first', BASE).toString() });

    check('a part of a multi-part task opens and runs', await ranSaying('the first way'));

    for (let i = 0; i < 60; i++) {
        if (await ev(`document.querySelectorAll('#suggestions a').length > 0`)) break;
        await sleep(500);
    }

    const line = await ev(`document.getElementById('task-identity').innerText`) ?? '';

    check('the line says which part this is', line.includes('part 1 of 2'), JSON.stringify(line));
    check('and offers the next one by name', line.includes('next: The second way'), JSON.stringify(line));
    check('and offers no previous one from the first part', !line.includes('previous'), JSON.stringify(line));

    await ev(`[...document.querySelectorAll('#task-identity a')]
        .find(a => a.textContent.startsWith('next')).click(); true`);

    check('a part link swaps the next part in and runs it', await ranSaying('the second way'),
        JSON.stringify(await ev(`document.getElementById('output').innerText`)));
    check('and the URL names that part',
        await ev(`location.pathname`) === new URL('rosetta-code/two-parts/02-second', BASE).pathname,
        await ev(`location.pathname`));

    const second = await ev(`document.getElementById('task-identity').innerText`) ?? '';

    check('and the line now offers the previous part instead',
        second.includes('part 2 of 2') && second.includes('previous: The first way')
        && !second.includes('next:'), JSON.stringify(second));

    // --- what a swap counts ------------------------------------------------

    const swapped = JSON.parse(await ev(`JSON.stringify(window.counted ?? [])`));

    check('taking a part is counted, with a pageview for the task it opened',
        swapped.includes('mini-ide-nav/standalone/part-next')
        && swapped.includes(new URL('rosetta-code/two-parts/02-second', BASE).pathname),
        JSON.stringify(swapped));

    // --- what the line says, and what it drops -----------------------------

    // Nothing in either place may be cut short: a task offered by half its name
    // is not offered, and a title that says it is a link and then hides where
    // it goes is worse than no title. Measured at both widths, because what
    // fits differs and a link that wraps is fine where one that is clipped is
    // not.
    const layout = async where => JSON.parse(await ev(`(() => {
        const identity = document.getElementById('task-identity');
        const strip = document.getElementById('more-to-run');
        const bar = document.querySelector('header');
        const links = [...document.querySelectorAll('#suggestions a, #more-links a')];

        // A cut-short element scrolls where it cannot show: for one line of
        // text these are equal exactly when all of it is visible.
        const clipped = element => element.scrollWidth > element.clientWidth + 1;

        const showing = !strip.hidden;
        const withStrip = bar.getBoundingClientRect().height;

        strip.hidden = true;

        const without = bar.getBoundingClientRect().height;

        strip.hidden = !showing;

        return JSON.stringify({
            where: ${JSON.stringify(where)},
            links: links.length,
            clippedLinks: links.filter(clipped).map(a => a.textContent),
            identityClipped: clipped(identity),
            // Below the tabs rather than merely offset from the row's top: the
            // row centres its items, so an identity shorter than a tab button
            // always sits a few pixels down from it while sharing the line.
            identityOnItsOwnRow:
                identity.getBoundingClientRect().top
                    >= document.getElementById('tab-output').getBoundingClientRect().bottom - 2,
            identityInTheTabRow: identity.closest('#tabs') !== null,
            timingShown: document.getElementById('run-cost').offsetParent !== null,
            stripHeight: Math.round(strip.getBoundingClientRect().height),
            stripWidth: strip.getBoundingClientRect().width,
            barWithStrip: withStrip,
            barWithout: without,
            page: document.documentElement.scrollWidth,
            window: window.innerWidth
        });
    })()`) ?? '{}');

    await cmd('Emulation.setDeviceMetricsOverride',
        { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(1000);

    const wide = await layout('1280px');

    check('the identity is in the tab row', wide.identityInTheTabRow && !wide.identityOnItsOwnRow,
        JSON.stringify(wide));
    check('the timing is beside it while there is room', wide.timingShown, JSON.stringify(wide));
    check('nothing in the strip is cut short at 1280px',
        wide.links > 0 && wide.clippedLinks.length === 0, JSON.stringify(wide));
    check('and neither is the identity', !wide.identityClipped, JSON.stringify(wide));

    // --- a phone ----------------------------------------------------------

    // Measured rather than looked at: a picture does not fail CI. The bar is
    // the one thing that must not change, because a second row of it takes the
    // height from the editor on the screen that has least of it.
    await cmd('Emulation.setDeviceMetricsOverride',
        { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await sleep(1000);

    const narrow = await layout('390px');

    check('the identity takes a row of its own on a phone',
        narrow.identityInTheTabRow && narrow.identityOnItsOwnRow, JSON.stringify(narrow));
    check('the timing has yielded its place by then', !narrow.timingShown, JSON.stringify(narrow));
    check('nothing in the strip is cut short at 390px either',
        narrow.links > 0 && narrow.clippedLinks.length === 0, JSON.stringify(narrow));
    check('and the identity is not cut short', !narrow.identityClipped, JSON.stringify(narrow));

    // Two rows of links at most: the strip wraps rather than truncating, and
    // this is what says the wrapping has an end. One row is about 18px.
    check('the strip is at most three rows tall',
        narrow.stripHeight > 0 && narrow.stripHeight <= 72, JSON.stringify(narrow));

    check('the strip does not change the height of the top bar at 390px',
        narrow.barWithStrip === narrow.barWithout, JSON.stringify(narrow));
    check('and nothing makes the page scroll sideways',
        narrow.page <= narrow.window + 1, JSON.stringify(narrow));
    check('the strip fits the window',
        narrow.stripWidth <= narrow.window + 1, JSON.stringify(narrow));

    // Each suggestion says why it is being offered, in the corpus's own words,
    // where a reader can reach it without it taking a line of its own.
    check('every suggestion carries its reason as a title',
        JSON.parse(await cards() ?? '[]').every(([text, title]) => text && title),
        await cards());

    await cmd('Emulation.clearDeviceMetricsOverride');

    await cmd('Fetch.disable');

    // Cells of an interactive session: compiled by the service against the
    // cells before them, and run in the cell host frame, where a runaway cell
    // is stopped by replacing the frame. Each cell's `use` lines are written
    // out here, where a session would generate them. Skipped where the
    // service has no session cells.
    const COMPILE = process.env.COMPILE ?? (new URL(BASE).hostname === '127.0.0.1'
        ? 'http://127.0.0.1:5090'
        : new URL('.', BASE).toString().replace(/\/$/, ''));

    const health = await (await fetch(`${COMPILE}/health`)).json().catch(() => ({}));

    if (!health.repl) {
        log('skip  session cells: the compile service has none');
    } else {
        const cells = [
            // Definitions only, so there is nothing to run.
            'use default\n_helper(n: int) -> int => n + 1\nclass _HIDDEN(value: int)\n' +
                'let names = LIST[string]()\n',
            'use default\nuse cell1._helper\nuse cell1._HIDDEN\nuse cell1.names\n' +
                'names.add("second")\nwrite_line("{names.count} name")\n_helper(_HIDDEN(41).value)\n',
            'use default\nthrow System.InvalidOperationException("from cell 3")\n',
            'use default\nuse cell1.names\nnames.add("fourth")\nnames.count\n'
        ];

        const session = JSON.parse(await ev(`(async () => {
            const { CellRuntime } = await import('./cell-runtime.js');
            window.cellRuntime = new CellRuntime();
            const headers = { 'content-type': 'application/json' };
            const token = ${JSON.stringify(TOKEN ?? null)};
            if (token) headers.authorization = 'Bearer ' + token;
            window.compileCells = async chain => (await fetch(${JSON.stringify(COMPILE)} + '/compile/cell', {
                method: 'POST', headers, body: JSON.stringify({ cells: chain })
            })).json();
            const accepted = [];
            const results = [];
            for (const [index, source] of ${JSON.stringify(cells)}.entries()) {
                const cell = { name: 'cell' + (index + 1), source };
                const compiled = await compileCells([...accepted, cell]);
                if (!compiled.ok) {
                    results.push({ compiled: false, reply: compiled });
                    break;
                }
                accepted.push(cell);
                results.push(await cellRuntime.run(compiled.assembly, cell.name));
            }
            return JSON.stringify(results);
        })()`) ?? '[]');

        check('a cell of definitions only runs as nothing',
            session[0] !== undefined && session[0].text === '' && !('value' in session[0]) && !session[0].error,
            JSON.stringify(session[0]));
        check("a later cell reaches its state and underscore names",
            session[1]?.text === '1 name\n' && session[1]?.value === '42', JSON.stringify(session[1]));
        check('a cell that throws reports it',
            (session[2]?.error ?? '').includes('from cell 3'), JSON.stringify(session[2]));
        check('and the session carries on after it', session[3]?.value === '2',
            JSON.stringify(session[3]));

        // A cell that never finishes is stopped by replacing the frame: the
        // page survives, the run answers as stopped, and the next cell starts
        // a new session.
        const stopped = JSON.parse(await ev(`(async () => {
            const chain = [{ name: 'cell1', source: 'use default\\nlet spins mut = 0\\nwhile true do spins = spins + 1 od\\n' }];
            const compiled = await compileCells(chain);
            if (!compiled.ok) return JSON.stringify({ compiled: false, reply: compiled });
            const running = cellRuntime.run(compiled.assembly, 'cell1');
            await new Promise(r => setTimeout(r, 2000));
            const busy = cellRuntime.busy;
            cellRuntime.stop();
            const result = await running;
            const fresh = [{ name: 'cell1', source: 'use default\\n6 * 7\\n' }];
            const again = await compileCells(fresh);
            const after = await cellRuntime.run(again.assembly, 'cell1');
            return JSON.stringify({ busy, result, after, frames: document.querySelectorAll('iframe').length });
        })()`) ?? '{}');

        check('a runaway cell is still running until stopped', stopped.busy === true, JSON.stringify(stopped));
        check('stopping it answers as stopped', stopped.result?.stopped === true, JSON.stringify(stopped.result));
        check('and a new session runs on a fresh frame',
            stopped.after?.value === '42' && stopped.frames === 1, JSON.stringify(stopped));
        check('with the page still answering', await ev(`document.getElementById('run-label').textContent`) === 'Run');

        // The .NET dev host sends the cross-origin isolation headers for `/`
        // and `/_framework/` only, where nginx sends them for every page and
        // serves the compile service from the same origin. Locally, a small
        // proxy stands in for nginx, so the page reaches the service by the
        // relative path it uses in production.
        const replBase = new URL(BASE).port === '5080'
            ? `http://127.0.0.1:${(await startNginxStandIn().then(server => { server.unref(); return server; })).address().port}/`
            : BASE;

        // Below /playground/, the REPL is reached as ghul.dev serves it: its
        // entry page at ../repl/, which takes everything else from here.
        const replUrl = new URL(replBase).pathname.endsWith('/playground/')
            ? new URL('../repl/', replBase).toString()
            : new URL('repl.html', replBase).toString();

        await cmd('Page.navigate', { url: untracked(replUrl) });

        for (let i = 0; i < 60; i++) {
            if (await ev(`!document.getElementById('input-row').hidden`)) break;
            await sleep(500);
        }

        const replStarted = await ev(`!document.getElementById('input-row').hidden`);

        // The events this page sends go nowhere without it, and nothing else
        // shows that: the helper drops what it cannot deliver, so a page with no
        // counter is silent rather than broken-looking.
        check('the REPL page loads the counter',
            await ev(`Boolean(document.getElementById('goatcounter'))`));

        check('the REPL page starts, with no flag on its URL', replStarted,
            await ev(`(async () => JSON.stringify({
                probe: await fetch('compile/cell').then(r => r.status).catch(e => String(e)),
                isolated: self.crossOriginIsolated,
                unavailable: !document.getElementById('unavailable').hidden,
                monaco: typeof monaco,
                status: document.getElementById('status').textContent
            }))()`));

        // Typed into the input and submitted with Shift-Enter, or with the
        // Run button, as a reader would; answers the text of the entry it
        // produced once the page is ready for the next.
        const submit = async (text, { click = false } = {}) => {
            const before = await ev(`document.querySelectorAll('.entry').length`);

            await ev(`(() => { const e = monaco.editor.getEditors()[0]; e.setValue(${JSON.stringify(text)}); e.focus(); return true; })()`);
            if (click) {
                await ev(`document.getElementById('run').click(); true`);
            } else {
                await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
                await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
            }

            for (let i = 0; i < 240; i++) {
                const done = await ev(`document.querySelectorAll('.entry').length > ${before} &&
                    !document.getElementById('run').hasAttribute('data-busy') &&
                    !document.getElementById('run').hasAttribute('data-stop')`);

                if (done) break;
                await sleep(250);
            }

            return await ev(`[...document.querySelectorAll('.entry')].at(-1).querySelector('.result').innerText`);
        };

        if (replStarted) {
            // A value's type arrives after the value itself, so the checks
            // that read a value run with types off; the last check turns
            // them on.
            await ev(`(() => { const b = document.getElementById('types'); if (b.getAttribute('aria-pressed') === 'true') b.click(); return true; })()`);

            // Nothing to discard before the first cell.
            const resetBefore = await ev(`document.getElementById('reset').disabled`);

            const defined = await submit('let x = 41');
            const resetAfter = await ev(`document.getElementById('reset').disabled`);

            check('New session is offered once there is a cell to discard',
                resetBefore === true && resetAfter === false, JSON.stringify({ resetBefore, resetAfter }));


            // Run is only offered when there is something to run.
            const runWhenEmpty = await ev(`document.getElementById('run').disabled`);
            await ev(`(() => { monaco.editor.getEditors()[0].setValue('x'); return true; })()`);
            const runWhenTyped = await ev(`document.getElementById('run').disabled`);

            check('Run is greyed out while the cell is empty, and offered once something is typed',
                runWhenEmpty === true && runWhenTyped === false, JSON.stringify({ runWhenEmpty, runWhenTyped }));

            // What is typed next is analysed as the next cell, against the cells
            // before it: x is only an int if the analyser has cell 1.
            await ev(`(() => { monaco.editor.getEditors()[0].setValue('let y: string = x'); return true; })()`);

            let analysed = '[]';

            for (let i = 0; i < 120; i++) {
                analysed = await ev(`JSON.stringify(monaco.editor.getModelMarkers({ owner: 'ghul-analyse' }).map(m => m.message))`);
                if (analysed?.includes('not assignable')) break;
                await sleep(250);
            }

            check('the input is analysed against the cells before it',
                analysed.includes('not assignable') && !analysed.includes('not defined'), analysed);
            const used = await submit('x + 1', { click: true });
            const redefined = await submit('let x = "forty-one"');
            const reread = await submit('x');
            const failed = await submit('let y: int = "s"');
            const after = await submit('x.length');

            check('the REPL page accepts a definition', defined === '', JSON.stringify(defined));
            check('a later cell, run with the Run button, uses it and shows its value', used === '42', JSON.stringify(used));
            check('a redefinition replaces it going forward',
                redefined === '' && reread.includes('forty-one'), JSON.stringify([redefined, reread]));
            check('a cell with an error shows the error', failed.includes('not assignable'), JSON.stringify(failed));
            check('and the session carries on after it', after === '9', JSON.stringify(after));
            check('the prompt numbers every submission, as the terminal does',
                await ev(`document.getElementById('prompt').textContent`) === '[7]',
                await ev(`document.getElementById('prompt').textContent`));

            // The top bar: its indicators, the help panel, and New session,
            // which asks before discarding the cells and does nothing if told no.
            const indicators = await ev(`JSON.stringify([...document.querySelectorAll('header .indicator')].map(i => [i.id, i.dataset.state]))`);

            check('the indicators are the compiler and the analyser, both ready',
                indicators === JSON.stringify([['compiler', 'ready'], ['analyser', 'ready']]), indicators);

            await ev(`document.getElementById('help-toggle').click(); true`);
            const helpShown = await ev(`!document.getElementById('help').hidden`);
            await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

            check('help opens, and Escape closes it',
                helpShown && await ev(`document.getElementById('help').hidden`));

            const declined = await ev(`(() => {
                window.confirm = () => false;
                document.getElementById('reset').click();
                return document.getElementById('prompt').textContent;
            })()`);

            const accepted = await ev(`(() => {
                window.confirm = () => true;
                document.getElementById('reset').click();
                return document.getElementById('prompt').textContent;
            })()`);

            check('new session asks first, and keeps the session when told no',
                declined === '[7]' && accepted === '[1]', JSON.stringify([declined, accepted]));

            check('and is greyed out again in the new session',
                await ev(`document.getElementById('reset').disabled`) === true);

            // Values are written by the runtime's inspect, as the terminal REPL
            // writes them: each shown value is the text inspect gives for it. An
            // absent value on its own shows nothing, as in the terminal, so it
            // is checked inside a list.
            await submit('class PAIRING(left: int, right: bool);');

            const shapes = {
                list: '[1, 2, 3]',
                tuple: '(1, true)',
                record: 'PAIRING(4, false)',
                bool: 'true',
                absent: '(let o: int? = null; [o, 2])'
            };

            const rendered = {};

            for (const [name, expression] of Object.entries(shapes)) {
                const shown = await submit(expression);
                const inspected = await submit(`Ghul.inspect(${expression})`);
                rendered[name] = { shown, inspected };
            }

            check('values are shown as the runtime\'s inspect renders them',
                Object.values(rendered).every(r => r.shown === r.inspected) &&
                rendered.list.shown === '[1, 2, 3]' && rendered.bool.shown === 'true' &&
                rendered.absent.shown === '[null, 2]' &&
                rendered.record.shown.startsWith('PAIRING('),
                JSON.stringify(rendered));

            // A cell's output appears as it is written, not only once it ends.
            const lastResult = `[...document.querySelectorAll('.entry')].at(-1).querySelector('.result').innerText`;

            // Until the page has nothing under way: a stop reruns the
            // earlier cells, which can take a while after Stop is gone.
            const untilIdle = async () => {
                for (let i = 0; i < 600; i++) {
                    if (await ev(`!document.getElementById('run').hasAttribute('data-stop') && !document.getElementById('run').hasAttribute('data-busy')`)) return;
                    await sleep(100);
                }
            };

            await ev(`(() => { monaco.editor.getEditors()[0].setValue(${JSON.stringify(
                'IO.Std.write_line("first"); System.Threading.Thread.sleep(3000); IO.Std.write_line("second");')}); return true; })()`);
            await ev(`document.getElementById('run').click(); true`);

            let seenMidway = null;

            for (let i = 0; i < 200; i++) {
                const now = await ev(`JSON.stringify({ running: document.getElementById('run').hasAttribute('data-stop'), text: ${lastResult} })`);
                const { running, text } = JSON.parse(now);

                if (running && text.includes('first')) {
                    seenMidway = text;
                    break;
                }

                await sleep(100);
            }

            for (let i = 0; i < 200; i++) {
                if (await ev(`!document.getElementById('run').hasAttribute('data-busy') && !document.getElementById('run').hasAttribute('data-stop')`)) break;
                await sleep(150);
            }

            const finished = await ev(lastResult);

            check('a running cell shows what it has written so far',
                seenMidway !== null && !seenMidway.includes('second') && finished === 'first\nsecond',
                JSON.stringify({ seenMidway, finished }));

            // A lot of output, fast: none of it lost or repeated, the last line
            // included, and the page answering while it arrives.
            await ev(`(() => { monaco.editor.getEditors()[0].setValue(${JSON.stringify(
                'for i in 0..100000 do IO.Std.write_line("line {i}"); od')}); return true; })()`);
            await ev(`document.getElementById('run').click(); true`);

            let slowest = 0;

            for (let i = 0; i < 600; i++) {
                const asked = Date.now();
                const done = await ev(`!document.getElementById('run').hasAttribute('data-busy') && !document.getElementById('run').hasAttribute('data-stop')`);

                slowest = Math.max(slowest, Date.now() - asked);

                if (done) break;
                await sleep(100);
            }

            const flood = await ev(`(() => {
                const lines = ${lastResult}.split('\\n');
                return JSON.stringify({ count: lines.length, first: lines[0], last: lines.at(-1), distinct: new Set(lines).size });
            })()`);

            const floodResult = JSON.parse(flood);

            check('a cell writing 100,000 lines shows each exactly once, and the page stays responsive',
                floodResult.count === 100000 && floodResult.distinct === 100000 &&
                floodResult.first === 'line 0' && floodResult.last === 'line 99999' && slowest < 2000,
                JSON.stringify({ ...floodResult, slowest }));

            const thrown = await submit('IO.Std.write_line("before"); throw System.Exception("boom");');

            check('a cell that throws shows its output and then the error',
                thrown.startsWith('before\n') && thrown.includes('boom'), JSON.stringify(thrown));

            // Stopped mid-cell, what it had already written stays.
            await ev(`(() => { monaco.editor.getEditors()[0].setValue(${JSON.stringify(
                'IO.Std.write_line("kept"); let n mut = 0; while true do n = n + 1; od')}); return true; })()`);
            await ev(`document.getElementById('run').click(); true`);

            for (let i = 0; i < 200; i++) {
                if (await ev(`document.getElementById('run').hasAttribute('data-stop') && ${lastResult}.includes('kept')`)) break;
                await sleep(100);
            }

            await ev(`document.getElementById('run').click(); true`);
            await untilIdle();

            const afterStop = await ev(lastResult);

            check('stopping a cell keeps what it had written',
                afterStop.startsWith('kept') && afterStop.includes('stopped'), JSON.stringify(afterStop));

            // A stop throws the frame away; the cells before the stopped one
            // are run again in the new frame, so what they defined is back.
            await submit('let survivor = 41');

            await ev(`(() => { monaco.editor.getEditors()[0].setValue(${JSON.stringify(
                'let spin mut = 0; while true do spin = spin + 1; od')}); return true; })()`);
            await ev(`document.getElementById('run').click(); true`);

            for (let i = 0; i < 200; i++) {
                if (await ev(`document.getElementById('run').hasAttribute('data-stop')`)) break;
                await sleep(100);
            }

            await sleep(500);
            await ev(`document.getElementById('run').click(); true`);
            await untilIdle();

            const replayed = await ev(lastResult);

            check('a stop says only that the cell was stopped',
                replayed === 'stopped', JSON.stringify(replayed));

            const survived = await submit('survivor + 1');

            check('and a later cell sees what they defined', survived === '42', JSON.stringify(survived));

            // Any cell can be run again, as a new cell, from its entry,
            // leaving what is being typed in the input alone.
            await ev(`(() => { monaco.editor.getEditors()[0].setValue('half typed'); return true; })()`);
            await ev(`[...document.querySelectorAll('.entry')].at(-1).querySelector('.again').click(); true`);
            await sleep(500);
            await untilIdle();

            const draftKept = await ev(`monaco.editor.getEditors()[0].getValue()`);

            check('running a cell again keeps what is being typed', draftKept === 'half typed', JSON.stringify(draftKept));

            await ev(`(() => { monaco.editor.getEditors()[0].setValue(''); return true; })()`);

            check('a cell can be run again from its entry',
                await ev(lastResult) === '42' &&
                (await ev(`[...document.querySelectorAll('.entry')].at(-1).querySelector('code').textContent`)).replace(/\s+/g, ' ').trim() === 'survivor + 1',
                await ev(lastResult));

            // A replay that cannot bring a cell back ends there. The middle
            // cell here finishes at once before a moment a few seconds
            // ahead, and spins for ever after it, so its replay has to be
            // stopped: the cell before it comes back, and it and the cell
            // after it are marked as not run. A new session first, so the
            // replay holds only these cells and not the slow ones above.
            await ev(`(() => { window.confirm = () => true; document.getElementById('reset').click(); return true; })()`);
            await untilIdle();

            await submit('let early = 5');
            const middleEntry = await ev(`document.querySelectorAll('.entry').length`);
            const turn = Date.now() + 6000;
            await submit(`let late mut = 0; while System.DateTimeOffset.utc_now.to_unix_time_milliseconds() > ${turn}L do late = late + 1; od`);
            await submit('let after = 7');

            while (Date.now() < turn + 500) await sleep(250);

            await ev(`(() => { monaco.editor.getEditors()[0].setValue(${JSON.stringify(
                'let spin mut = 0; while true do spin = spin + 1; od')}); return true; })()`);
            await ev(`document.getElementById('run').click(); true`);

            for (let i = 0; i < 200; i++) {
                if (await ev(`document.getElementById('run').hasAttribute('data-stop')`)) break;
                await sleep(100);
            }

            await sleep(500);
            await ev(`document.getElementById('run').click(); true`);

            // The replay reaches the spinning cell and stays there: once the
            // new frame's runtime has started, the cells before it take well
            // under a second.
            for (let i = 0; i < 240; i++) {
                await sleep(250);
                if (!(await ev(`document.getElementById('status').textContent`)).startsWith('starting')) break;
            }

            await sleep(3000);
            const replaySpinning = await ev(`document.getElementById('run').hasAttribute('data-stop')`);

            await ev(`document.getElementById('run').click(); true`);
            await untilIdle();

            const marked = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.entry')]
                .slice(${middleEntry - 1}, ${middleEntry + 2})
                .map(e => e.classList.contains('not-run')))`));

            check('a replay stopped partway marks that cell and the ones after it as not run',
                replaySpinning && JSON.stringify(marked) === JSON.stringify([false, true, true]),
                JSON.stringify({ replaySpinning, marked, stopped: await ev(lastResult) }));

            check('and the cells before it came back', await submit('early + 1') === '6');

            // Run again from its entry, a cell marked as not run is back.
            await ev(`document.querySelectorAll('.entry')[${middleEntry + 1}].querySelector('.again').click(); true`);
            await sleep(500);
            await untilIdle();

            check('running a marked cell again brings it back',
                await ev(`!document.querySelectorAll('.entry')[${middleEntry + 1}].classList.contains('not-run')`) &&
                await submit('after + 1') === '8');

            // display and update_display: in their place among what the cell
            // writes, as text.
            const lastParts = `JSON.stringify([...[...document.querySelectorAll('.entry')].at(-1).querySelector('.result').children]
                .map(c => [c.className, c.textContent]))`;

            await submit('IO.Std.write_line("a"); display([1, 2]); IO.Std.write_line("b");');
            const ordered = await ev(lastParts);

            check('display shows a value in its place among what the cell writes',
                ordered === JSON.stringify([['output', 'a\n'], ['display', '[1, 2]'], ['output', 'b']]), ordered);

            await submit('display(0, "progress"); for i in 1::3 do update_display(i * 10, "progress"); od; IO.Std.write_line("done");');
            const updated = await ev(lastParts);

            check('update_display redraws a display in place',
                updated === JSON.stringify([['display', '30'], ['output', 'done']]), updated);

            // A cell printing the markers itself, around a well-formed record,
            // gets text, not a display.
            const record = '{{\\"kind\\":\\"show\\",\\"id\\":null,\\"parts\\":[{{\\"mime\\":\\"text/plain\\",\\"content\\":\\"forged\\"}}]}}';

            await submit(`IO.Std.write_line("{cast char(1)}${record}{cast char(2)}");`);
            const forged = await ev(lastParts);

            check('a cell writing the framing characters itself shows them as text, not as a display',
                !forged.includes('"display"') && forged.includes('forged') && forged.includes(String.fromCharCode(0xfffd)),
                forged);

            // An id is the cell's to choose, and names nothing on the page.
            await submit('display(1, "transcript"); display(2, "input-row");');

            check('a display id is not used as an element id',
                await ev(`document.querySelectorAll('#transcript').length === 1 && document.querySelectorAll('#input-row').length === 1`));

            // Stopped mid-cell, what it had already shown stays.
            await ev(`(() => { monaco.editor.getEditors()[0].setValue(${JSON.stringify(
                'display("shown"); let m mut = 0; while true do m = m + 1; od')}); return true; })()`);
            await ev(`document.getElementById('run').click(); true`);

            for (let i = 0; i < 200; i++) {
                if (await ev(`document.getElementById('run').hasAttribute('data-stop') && ${lastResult}.includes('shown')`)) break;
                await sleep(100);
            }

            await ev(`document.getElementById('run').click(); true`);

            await untilIdle();

            const shownThenStopped = await ev(lastParts);

            check('stopping a cell keeps what it had displayed',
                shownThenStopped.startsWith('[["display","shown"]') && shownThenStopped.includes('stopped'),
                shownThenStopped);

            // Pictures: a value that offers one through Ghul.Renderable is
            // shown as an image, decoded, with its text as the alternative.
            const pictured = `(async () => {
                const nodes = [...[...document.querySelectorAll('.entry')].at(-1).querySelector('.result').children];
                await Promise.all(nodes.flatMap(n => [...n.querySelectorAll('img')]).map(i => i.decode().catch(() => null)));
                return JSON.stringify(nodes.map(n => {
                    const image = n.querySelector('img');
                    return image
                        ? [n.className, 'img', image.naturalWidth, image.src.slice(0, 22), image.alt.slice(0, 12)]
                        : [n.className, n.textContent.slice(0, 80)];
                }));
            })()`;

            await submit('Raster.IMAGE(40, 20)');
            const asValue = JSON.parse(await ev(pictured));

            check('a raster image a cell ends on is shown as a picture',
                asValue.length === 1 && asValue[0][0] === 'value' && asValue[0][1] === 'img' && asValue[0][2] === 40 &&
                asValue[0][3] === 'data:image/png;base64,' && asValue[0][4].startsWith('IMAGE('),
                JSON.stringify(asValue));

            await submit('IO.Std.write_line("a"); display(Raster.IMAGE(10, 10)); IO.Std.write_line("b");');
            const inOrder = JSON.parse(await ev(pictured));

            check('display shows a picture in its place among what the cell writes',
                inOrder.length === 3 && inOrder[0][1] === 'a\n' && inOrder[1][1] === 'img' && inOrder[1][2] === 10 && inOrder[2][1] === 'b',
                JSON.stringify(inOrder));

            await submit('display(Raster.IMAGE(10, 10), "plot"); update_display(Raster.IMAGE(30, 10), "plot");');
            const swapped = JSON.parse(await ev(pictured));

            check('update_display swaps one picture for another in place',
                swapped.length === 1 && swapped[0][1] === 'img' && swapped[0][2] === 30, JSON.stringify(swapped));

            await submit([
                'class MARKUP: Ghul.Renderable is',
                '    init() is si',
                '    representations() -> Collections.Iterable[(mime: string, content: ubyte[])] pure =>',
                '        [(mime = "text/html", content = System.Text.Encoding.utf8.get_bytes("<img src=x onerror=alert(1)>"))]',
                '    to_string() -> string => "markup as text"',
                'si'
            ].join('\n'));
            await submit('display(MARKUP())');
            const markup = JSON.parse(await ev(pictured));

            check('a value offering only markup is shown as its text',
                markup.length === 1 && markup[0][0] === 'display' && markup[0][1] !== 'img', JSON.stringify(markup));

            await submit([
                'class HUGE: Ghul.Renderable is',
                '    init() is si',
                '    representations() -> Collections.Iterable[(mime: string, content: ubyte[])] pure =>',
                '        [(mime = "image/png", content = cast ubyte[](System.Array.create_instance(typeof ubyte, 5_000_000)))]',
                '    to_string() -> string => "huge"',
                'si'
            ].join('\n'));
            await submit('display(HUGE())');
            const huge = JSON.parse(await ev(pictured));

            check('a picture over 4 MB falls back to the text, with a note',
                huge.length === 1 && huge[0][1] !== 'img' && huge[0][1].includes('MB'), JSON.stringify(huge));

            // A picture too large for the live view: said to be coming while
            // the cell runs, and shown whole once it finishes.
            const made = await submit([
                'let bytes = Collections.LIST[ubyte]();',
                'let seed mut = 1L;',
                'for i in 0..120000 do seed = seed * 6364136223846793005L + 1442695040888963407L; bytes.add(cast ubyte(seed >> 56)); od',
                'let noise = Raster.IMAGE.from_rgb(200, 200, bytes.to_array());'
            ].join('\n'));

            if (made) log(`making the noise picture said: ${made}`);

            await ev(`(() => { monaco.editor.getEditors()[0].setValue(${JSON.stringify(
                'display(noise); System.Threading.Thread.sleep(3000); IO.Std.write_line("after");')}); return true; })()`);
            await ev(`document.getElementById('run').click(); true`);

            let pendingPicture = null;

            for (let i = 0; i < 200; i++) {
                const now = await ev(`JSON.stringify({ running: document.getElementById('run').hasAttribute('data-stop'), text: ${lastResult} })`);
                const { running, text } = JSON.parse(now);

                if (running && text.includes('when the cell finishes')) {
                    pendingPicture = text;
                    break;
                }

                await sleep(100);
            }

            for (let i = 0; i < 200; i++) {
                if (await ev(`!document.getElementById('run').hasAttribute('data-busy') && !document.getElementById('run').hasAttribute('data-stop')`)) break;
                await sleep(150);
            }

            const arrived = JSON.parse(await ev(pictured));

            check('a picture too large for the live view is said to be coming, and shown once the cell finishes',
                pendingPicture !== null && arrived.length === 2 && arrived[0][1] === 'img' && arrived[0][2] === 200 && arrived[1][1] === 'after',
                JSON.stringify({ pendingPicture, arrived }));

            // Stopped mid-cell, a picture already shown stays.
            await ev(`(() => { monaco.editor.getEditors()[0].setValue(${JSON.stringify(
                'display(Raster.IMAGE(12, 12)); let k mut = 0; while true do k = k + 1; od')}); return true; })()`);
            await ev(`document.getElementById('run').click(); true`);

            for (let i = 0; i < 200; i++) {
                if (await ev(`document.getElementById('run').hasAttribute('data-stop') && [...document.querySelectorAll('.entry')].at(-1).querySelector('img') !== null`)) break;
                await sleep(100);
            }

            await ev(`document.getElementById('run').click(); true`);

            await untilIdle();

            const pictureStopped = JSON.parse(await ev(pictured));

            check('stopping a cell keeps a picture it had displayed',
                pictureStopped[0]?.[1] === 'img' && pictureStopped[0]?.[2] === 12 && JSON.stringify(pictureStopped).includes('stopped'),
                JSON.stringify(pictureStopped));

            // With types on, a value is shown after the type of the
            // expression the cell ended on, which a lazy comprehension and
            // an array would otherwise share a rendering with.
            await ev(`document.getElementById('types').click(); true`);

            await submit('let squares = {i * i for i in 0..5}');
            let typed = await submit('squares');

            for (let i = 0; i < 120 && !typed.startsWith('Pipe[int]: '); i++) {
                await sleep(250);
                typed = await ev(`[...document.querySelectorAll('.entry')].at(-1).querySelector('.result').innerText`);
            }

            check('with types on, a value is shown after its type',
                typed === 'Pipe[int]: [0, 1, 4, 9, 16]', JSON.stringify(typed));

            // A full session closes the input rather than carrying on into a
            // session that cannot see the cells above it. The page is told
            // the limit is two, so reaching it takes two cells.
            const { identifier: smallLimit } = await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
                const original = window.fetch;
                window.fetch = async (url, init) => {
                    const response = await original(url, init);
                    if (!String(url).endsWith('compile/cell') || (init?.method ?? 'GET') !== 'GET' || !response.ok) return response;
                    const limits = await response.json();
                    return new Response(JSON.stringify({ ...limits, maxCells: 2 }), { headers: { 'content-type': 'application/json' } });
                };
            })()` });

            await cmd('Page.navigate', { url: untracked(replUrl) });

            for (let i = 0; i < 60; i++) {
                if (await ev(`!document.getElementById('input-row').hidden && document.getElementById('prompt').textContent === '[1]'`)) break;
                await sleep(500);
            }

            await submit('1');
            const reached = await submit('2');
            const closed = JSON.parse(await ev(`(() => {
                const e = monaco.editor.getEditors()[0];
                e.setValue('3');
                return JSON.stringify({ readOnly: e.getOption(monaco.editor.EditorOption.readOnly), run: document.getElementById('run').disabled });
            })()`));

            check('a full session says so and closes the input',
                reached.includes('limit of 2 cells reached') && closed.readOnly === true && closed.run === true,
                JSON.stringify({ reached, closed }));

            await ev(`(() => { window.confirm = () => true; document.getElementById('reset').click(); return true; })()`);

            const reopened = JSON.parse(await ev(`(() => {
                const e = monaco.editor.getEditors()[0];
                e.setValue('3');
                return JSON.stringify({ readOnly: e.getOption(monaco.editor.EditorOption.readOnly), run: document.getElementById('run').disabled, prompt: document.getElementById('prompt').textContent });
            })()`));

            check('and a new session opens it again',
                reopened.readOnly === false && reopened.run === false && reopened.prompt === '[1]',
                JSON.stringify(reopened));

            await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: smallLimit });
        }
    }

    // The wasm target. `?wasm` offers it for whatever is in the editor, which
    // is what a program flagged in the corpus index gets. A browser without
    // the features a wasm build needs is offered nothing and runs on .NET, so
    // there the checks are skipped rather than failed.
    await cmd('Page.navigate', { url: untracked(new URL('?wasm', BASE)) });

    for (let i = 0; i < 120; i++) {
        if (await ev(`document.getElementById('compiler')?.dataset.state === 'ready'`)) break;
        await sleep(500);
    }

    const wasmSupported = await ev(`(async () => (await import('./playground.js')).wasmAvailable())()`);
    const choiceShowing = () => ev(`(() => { const t = document.getElementById('target');
                 return Boolean(t) && t.offsetParent !== null; })()`);

    if (!wasmSupported) {
        log('skip  wasm: this browser or compile service cannot run a wasm build');
        check('no wasm/.NET choice where wasm cannot run', !(await choiceShowing()));
    } else {
        check('the wasm/.NET choice is offered', await choiceShowing());
        check('wasm is chosen by default',
            await ev(`document.querySelector('#target [data-target="wasm"]').getAttribute('aria-pressed') === 'true'`));

        await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(reading)}); true`);
        await sleep(1000);
        await ev(`document.getElementById('run').click(); true`);

        let wasmAsked = false;
        for (let i = 0; i < 180; i++) {
            wasmAsked = await boxShowing();
            if (wasmAsked) break;
            await sleep(500);
        }
        check('a wasm program that reads asks for a line', wasmAsked);

        await ev(`(() => {
            document.getElementById('stdin').value = 'world';
            document.getElementById('input-row')
                .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            return true;
        })()`);

        let wasmAnswered = '';
        for (let i = 0; i < 120; i++) {
            wasmAnswered = await ev(`document.getElementById('output').innerText`);
            if (wasmAnswered.includes('hello, world')) break;
            await sleep(500);
        }
        check('a wasm program reads the typed line', wasmAnswered.includes('hello, world'),
            JSON.stringify(wasmAnswered.trim()));
        check('and echoes it into the transcript', /^world$/m.test(wasmAnswered));

        let cost = '';
        for (let i = 0; i < 40; i++) {
            cost = await ev(`document.getElementById('run-cost').textContent`);
            if (cost) break;
            await sleep(250);
        }
        check('the run says it ran on wasm', cost.includes('on wasm'), JSON.stringify(cost));

        // A program that never ends. Stopping a .NET one means reloading the
        // page; a wasm one is in a worker the page can terminate.
        const endless = ['use IO.Std.write_line;', '', 'entry() is', '    let i mut = 0;',
            '    while true do', '        i = i + 1;', '    od', 'si', ''].join('\n');

        await ev(`window.notReloaded = true; monaco.editor.getModels()[0].setValue(${JSON.stringify(endless)}); true`);
        await sleep(1000);
        await ev(`document.getElementById('run').click(); true`);

        for (let i = 0; i < 120; i++) {
            if (await ev(`document.getElementById('run-label').textContent === 'Stop'`)) break;
            await sleep(500);
        }

        await sleep(1000);
        await ev(`document.getElementById('run').click(); true`);

        let stopped = false;
        for (let i = 0; i < 40; i++) {
            stopped = await ev(`window.notReloaded === true && document.getElementById('run-label').textContent === 'Run'`);
            if (stopped) break;
            await sleep(250);
        }
        check('Stop ends a busy wasm program without reloading the page', stopped);

        // Something the wasm target cannot compile runs on .NET instead.
        const usesDecimal = ['use IO.Std.write_line;', '', 'entry() is',
            '    write_line("{1.5m + 2.25m}");', 'si', ''].join('\n');

        await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(usesDecimal)}); true`);
        await sleep(1000);
        await ev(`document.getElementById('run').click(); true`);

        let fellBack = '';
        for (let i = 0; i < 180; i++) {
            fellBack = await ev(`document.getElementById('output').innerText`);
            if (fellBack.includes('3.75')) break;
            await sleep(500);
        }
        check('a program wasm cannot compile runs on .NET, with a note',
            fellBack.includes('3.75') && fellBack.includes('ran on .NET'), JSON.stringify(fellBack.trim()));

        // Chosen .NET, a program that would run on wasm runs on .NET.
        await ev(`document.querySelector('#target [data-target="dotnet"]').click(); true`);
        await ev(`monaco.editor.getModels()[0].setValue(${JSON.stringify(reading)}); true`);
        await sleep(1000);
        await ev(`document.getElementById('run').click(); true`);

        for (let i = 0; i < 180; i++) {
            if (await boxShowing()) break;
            await sleep(500);
        }

        await ev(`(() => {
            document.getElementById('stdin').value = 'world';
            document.getElementById('input-row')
                .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            return true;
        })()`);

        let dotnetCost = '';
        for (let i = 0; i < 120; i++) {
            dotnetCost = await ev(`document.getElementById('run-cost').textContent`);
            if (dotnetCost && (await ev(`document.getElementById('output').innerText`)).includes('hello, world')) break;
            await sleep(500);
        }
        check('choosing .NET runs on .NET', dotnetCost && !dotnetCost.includes('on wasm'),
            JSON.stringify(dotnetCost));
    }

    log(failures ? `${failures} failure(s)` : 'all checks passed');
    process.exit(failures ? 1 : 0);
})();

