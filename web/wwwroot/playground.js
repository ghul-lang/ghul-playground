// The playground itself: an editor wired to the analyse service, plus compile
// and run. No chrome and no layout opinions, so the standalone page and the
// embedded one can present it differently without duplicating any of this.

import { reportError } from './errors.js'
import { dotnet } from './_framework/dotnet.js'
import { GHUL_LANGUAGE, GHUL_CONFIGURATION } from './ghul-language.js'
import { GhulLanguageClient } from './lsp.js'
import { getToken, setToken, askForToken } from './token.js'
import { defineThemes, themeName } from './theme.js'
import { LiveOutput } from './live-output.js'
import {
    OUTPUT_WRITTEN, OUTPUT_TRUNCATED, INPUT_TURN, INPUT_READY, INPUT_LENGTH, INPUT_CAPACITY,
    channelViews, readOutput
} from './channel.js'

// Deployed, both services sit behind the same reverse proxy that serves this
// page, beside its files, so same-origin paths avoid CORS entirely and follow
// the page wherever it is served from. The .NET dev server does not proxy, so a
// page served from it talks to them directly.
const LOCAL = location.port === '5080';

const beside = path => new URL(path, document.baseURI).href;

const COMPILE_SERVICE = LOCAL ? 'http://127.0.0.1:5090/compile' : beside('compile');

const ANALYSE_SERVICE = LOCAL
    ? 'ws://127.0.0.1:5091/analyse'
    : beside('analyse').replace(/^http/, 'ws');

const HEALTH_SERVICE = LOCAL ? 'http://127.0.0.1:5091/health' : beside('health');

// Whether the services want a token at all, asked once. A closed service and an
// unreachable one are different: an unreachable one is reported as not
// requiring a token, because the token dialog is not the right way to tell
// somebody the back end is down.
let health = null;

// Asked once and remembered. An unreachable service answers as though it wants
// no token: the token dialog is not the way to say the back end is down.
function serviceState() {
    health ??= fetch(HEALTH_SERVICE)
        .then(response => response.json())
        .catch(() => ({ tokensRequired: false }));

    return health;
}

// Whether the back end serves interactive sessions, as the analyse service
// reports it: false when it does not say, or cannot be reached.
export const replOffered = () => serviceState().then(state => state.repl === true);

const tokenRequired = () => serviceState().then(state => state.tokensRequired !== false);

// The services cap how large a program they will take. The editor enforces the
// same number so a reader is told before they run rather than after, and reads
// it from the service so the two cannot drift apart. The fallback matters only
// when /health is unreachable, in which case nothing will compile anyway.
let maxSourceBytes = 32 * 1024;

serviceState().then(state => {
    if (Number.isFinite(state.maxSourceBytes)) maxSourceBytes = state.maxSourceBytes;
});

// Long enough not to send a message per character, short enough that
// diagnostics feel live.
const EDIT_DEBOUNCE_MS = 300;

export const DEFAULT_SOURCE = `use IO.Std.write_line;

square(n: int) -> int => n * n;

describe(n: int, label: string) -> string => "{label}: {n}";

entry() is
    write_line("hello from ghūl, compiled on the server");

    for n in [1, 2, 3, 4, 5] do
        write_line(n |> square() |> describe("square"));
    od
si
`;

// Monaco's AMD loader is global and must not be started twice.
let monacoLoaded = null;

function loadMonaco() {
    if (monacoLoaded) return monacoLoaded;

    monacoLoaded = new Promise(resolve => {
        require.config({ paths: { vs: 'vs' } });

        require(['vs/editor/editor.main'], () => {
            monaco.languages.register({ id: 'ghul' });
            monaco.languages.setMonarchTokensProvider('ghul', GHUL_LANGUAGE);
            monaco.languages.setLanguageConfiguration('ghul', GHUL_CONFIGURATION);

            defineThemes();

            resolve();
        });
    });

    return monacoLoaded;
}

// How often the page looks at the control block while a program runs. It is
// reading a counter out of memory, so this is cheap; what it bounds is how far
// behind the output can be and how long after a program asks for input the box
// takes to appear.
const POLL_MS = 50;

// The .NET runtime is several megabytes and is only needed to run a program, so
// it is started on the first run rather than on load. A page that embeds one of
// these per example cannot pay that on every navigation.
let runtime = null;

// The resolved runtime, kept beside the promise so that code which only wants
// the channel - and only when there is one - does not have to await anything.
let loaded = null;

function loadRuntime() {
    if (!runtime) {
        runtime = (async () => {
            const api = await dotnet.create();
            const exports = await api.getAssemblyExports(api.getConfig().mainAssemblyName);
            const address = await exports.GhulRunner.OpenChannel();

            const views = channelViews(api.Module, address);

            // The runtime's filesystem, where a program's data files are put
            // for it to open.
            loaded = { exports, views, fs: api.Module.FS };

            return loaded;
        })();

        runtime.catch(() => reportError('runtime-load'));
    }

    return runtime;
}

// An animation shows one name hundreds of times, and at the end of a run each
// of those markers is read again. The file is not changing any more by then.
function cached(readFile) {
    const read = new Map();

    return path => {
        if (!read.has(path)) read.set(path, readFile(path));

        return read.get(path);
    };
}

// Written before every run rather than once, so a program that changes one of
// its inputs is handed the original again next time, as it would be run from
// a fresh checkout. Each goes in the working directory, which is where a bare
// name like unixdict.txt is looked for.
function writeFiles(fs, files) {
    const directory = fs.cwd().replace(/\/$/, '');

    for (const { name, bytes } of files) {
        fs.writeFile(`${directory}/${name}`, bytes);
    }
}

export async function createPlayground({
    container,
    source = DEFAULT_SOURCE,
    theme = 'vs',
    files = [],
    onOutput = () => { },
    onInput = () => { },
    onImages = () => { },
    onDiagnostics = () => { },
    onStatus = () => { },
    onAnalyser = () => { },
    onAnalyserOutcome = () => { }
}) {
    await loadMonaco();

    const editor = monaco.editor.create(container, {
        value: source,
        language: 'ghul',
        theme: themeName(theme),
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        // The frame is sized to its content and so never scrolls internally.
        // Consuming the wheel would therefore only trap it: a reader scrolling
        // the page over an editor would find the page stuck.
        scrollbar: { alwaysConsumeMouseWheel: false },
        // The same face and features ghul.dev sets on a rendered example, so
        // clicking edit does not change how the code looks.
        fontFamily: "'Fira Code', var(--vp-font-family-mono, monospace)",
        fontLigatures: "'calt', 'liga', 'ss07'",
        fontSize: 14,
        tabSize: 4,
        'semanticHighlighting.enabled': true,
        // Off, because ghul.dev renders brackets in the operator colour and the
        // whole point is that a rendered example and an editable one look the
        // same. Monaco's default rainbow is also the loudest thing on screen in
        // a language whose blocks are keyword-delimited, so it is colouring the
        // punctuation that matters least.
        bracketPairColorization: { enabled: false }
    });

    // The option above reaches the editor, but the rainbow is drawn from
    // decorations the *model* provides, and a model's colourization options are
    // fixed when it is created - enabled, by default - with nothing carrying
    // the editor's answer across. So the model has to be told separately, and
    // its field is spelled without the "Pair" the editor option carries.
    editor.getModel().updateOptions({
        bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false }
    });

    // Identifiers coloured by what the compiler resolved them to, rather than
    // by the grammar's guess. Registered once the legend is known, and it only
    // becomes known after the first initialize.
    let semanticProvider = null;

    // The editor asks for tokens and hints when the model changes, but the
    // analyser is only told about the change after a debounce and only answers
    // after analysing it - so those requests are answered against the text as
    // it was a keystroke or two ago, and nothing asks again once the typing
    // stops. Both providers therefore announce when their answers have moved
    // on, and the editor comes back for them. Fired when an analysis lands,
    // which is what changes the answers.
    const analysed = new monaco.Emitter();

    function registerSemanticTokens() {
        if (semanticProvider || !client.semanticTokensLegend) return;

        semanticProvider = monaco.languages.registerDocumentSemanticTokensProvider('ghul', {
            getLegend: () => client.semanticTokensLegend,
            onDidChange: analysed.event,
            provideDocumentSemanticTokens: async (model, lastResultId, cancellation) => {
                const version = model.getVersionId();
                const tokens = await client.semanticTokens();

                // An answer for text the model no longer holds is dropped
                // rather than applied: its positions can fall past the end of
                // a line, which the editor reports as invalid data. The
                // refresh when the analysis lands brings the current answer.
                if (!tokens || cancellation.isCancellationRequested || model.getVersionId() !== version) return null;

                return fitsModel(model, tokens.data) ? tokens : null;
            },
            releaseDocumentSemanticTokens: () => { }
        });
    }

    // Whether every token in the relative five-integer encoding lies within
    // a line of the model.
    function fitsModel(model, data) {
        const lineCount = model.getLineCount();

        let line = 0;
        let start = 0;

        for (let i = 0; i < data.length; i += 5) {
            line += data[i];
            start = data[i] === 0 ? start + data[i + 1] : data[i + 1];

            if (line >= lineCount || start + data[i + 2] > model.getLineLength(line + 1)) return false;
        }

        return true;
    }

    // Which problems the page is shown. The analyser and the compile service
    // are the same compiler, so when the analyser is connected its list is the
    // live one and the compiler's would only duplicate it; without an analyser
    // the compiler's is all there is.
    let analyserReady = false;
    let analyseDiagnostics = [];
    let compileDiagnostics = [];

    const reportDiagnostics = () =>
        onDiagnostics(analyserReady ? analyseDiagnostics : compileDiagnostics);

    const client = new GhulLanguageClient(ANALYSE_SERVICE, {
        getToken,
        onOutcome: onAnalyserOutcome,

        onDiagnostics: list => {
            analyseDiagnostics = list;
            reportDiagnostics();

            // An analysis has landed, so whatever the editor is showing from
            // the last one is now behind the analyser.
            analysed.fire();
        },

        onStatus: state => {
            // A dead analyser leaves its last diagnostics on screen, which
            // would be stale and misleading. `dormant` is not a failure - the
            // session was reaped for idleness and the next edit wakes it - but
            // its diagnostics are just as stale, so they go too.
            if (state !== 'ready') {
                monaco.editor.setModelMarkers(editor.getModel(), 'ghul-analyse', []);
            }

            if (state !== 'ready') analyseDiagnostics = [];

            analyserReady = state === 'ready';
            reportDiagnostics();

            if (state === 'ready') registerSemanticTokens();

            onAnalyser(state);
        }
    });

    client.attach(editor.getModel());

    let debounce = null;
    editor.onDidChangeModelContent(() => {
        clearTimeout(debounce);
        debounce = setTimeout(sendEdit, EDIT_DEBOUNCE_MS);
    });

    function sendEdit() {
        debounce = null;
        client.changed(editor.getValue());
    }

    // A request about the text as it is now has to follow the edit that made
    // it so. Typing '.' asks for completion at once, well inside the debounce,
    // and answered against the text before the dot it offers the names in
    // scope rather than the members.
    function flushEdit() {
        if (debounce === null) return;

        clearTimeout(debounce);
        sendEdit();
    }

    // Both decline when the analyser is not there, so the editor keeps working
    // with nothing but highlighting rather than showing errors.
    monaco.languages.registerHoverProvider('ghul', {
        provideHover: (_model, position) => client.ready ? client.hover(position) : null
    });

    monaco.languages.registerInlayHintsProvider('ghul', {
        onDidChangeInlayHints: analysed.event,
        provideInlayHints: async (_model, range) => {
            if (!client.ready) return { hints: [], dispose: () => { } };

            const hints = await client.inlayHints(range);

            return {
                hints: hints.map(hint => ({
                    position: {
                        lineNumber: hint.position.line + 1,
                        column: hint.position.character + 1
                    },
                    label: typeof hint.label === 'string'
                        ? hint.label
                        : (hint.label ?? []).map(part => part.value).join(''),
                    // A markdown tooltip carries the signature in a fenced
                    // code block, which Monaco renders in the editor's font
                    // and colourizes only when the tooltip is a markdown
                    // string rather than flattened text.
                    tooltip: typeof hint.tooltip === 'object'
                        ? (hint.tooltip.kind === 'markdown'
                            ? { value: hint.tooltip.value }
                            : hint.tooltip.value)
                        : hint.tooltip,
                    paddingLeft: hint.paddingLeft,
                    paddingRight: hint.paddingRight
                })),
                dispose: () => { }
            };
        }
    });

    monaco.languages.registerCompletionItemProvider('ghul', {
        triggerCharacters: ['.'],
        provideCompletionItems: async (_model, position, context) => {
            if (!client.ready) return { suggestions: [] };

            flushEdit();

            return { suggestions: await client.completion(position, context) };
        }
    });

    function showCompileDiagnostics(list) {
        // The analyser owns the squiggles while it is up; showing compile
        // results as well would double every message.
        if (!client.ready) {
            monaco.editor.setModelMarkers(editor.getModel(), 'ghul-compile', list.map(d => ({
                startLineNumber: d.startLine,
                startColumn: d.startColumn,
                endLineNumber: d.endLine,
                endColumn: d.endColumn,
                message: d.message,
                severity: d.severity === 'error' ? monaco.MarkerSeverity.Error
                    : d.severity === 'warn' ? monaco.MarkerSeverity.Warning
                        : monaco.MarkerSeverity.Info
            })));
        }

        compileDiagnostics = list;
        reportDiagnostics();
    }

    // `args` is what the program receives as its command line. It is handed
    // in per run rather than held here, because it is the page's field and the
    // reader can have changed it since the last one.
    async function run(args = []) {
        onOutput('');
        onImages([]);

        // Refused here rather than by the service, so a reader is told what the
        // limit is instead of watching a request fail.
        const size = new TextEncoder().encode(editor.getValue()).length;

        if (size > maxSourceBytes) {
            compileDiagnostics = [{
                startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
                severity: 'error',
                message: `this program is ${Math.ceil(size / 1024)} KB; ` +
                    `the playground compiles up to ${Math.floor(maxSourceBytes / 1024)} KB`
            }];

            reportDiagnostics();
            onStatus('failed', { compiled: 0, tooBig: true });
            return;
        }

        onStatus('compiling');

        const started = performance.now();

        try {
            const token = getToken();

            const response = await fetch(COMPILE_SERVICE, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(token ? { authorization: `Bearer ${token}` } : {})
                },
                body: JSON.stringify({ source: editor.getValue() })
            });

            // A rejected token is worth saying plainly and worth asking about,
            // rather than reporting as an opaque failure.
            if (response.status === 401) {
                onStatus('unauthorized');

                const entered = await askForToken(container.parentElement ?? container, {
                    message: token
                        ? 'That access token was not accepted. Try another?'
                        : 'Running a program needs an access token.'
                });

                if (entered) {
                    client.reconnect();
                    return run();
                }

                return;
            }

            // The service caps how many compiles run at once and the proxy caps
            // how often one address may ask, so being turned away is a normal
            // thing that happens to an innocent reader when somebody else is
            // hammering it. Say so, rather than reporting it as a failure of
            // their program.
            if (response.status === 429 || response.status === 503) {
                onStatus('busy');
                onOutput('The compile service is busy. Try running it again in a moment.');
                return;
            }

            if (!response.ok) {
                throw new Error(`compile service returned HTTP ${response.status}`);
            }

            const result = await response.json();

            showCompileDiagnostics(result.diagnostics ?? []);

            if (!result.ok) {
                onStatus('failed', {
                    compiled: Math.round(performance.now() - started),
                    timedOut: result.timedOut === true
                });

                return;
            }

            const compiled = Math.round(performance.now() - started);

            onStatus('starting runtime');

            const { exports, views, fs } = await loadRuntime();

            writeFiles(fs, files);

            onStatus('running');

            const ran = performance.now();

            // Reset here rather than in the runner. Nothing is running at this
            // instant, so the page and the program cannot disagree about which
            // run a count belongs to - where a reset the runner did would race
            // the first poll, which would read the last run's total and decide
            // it had already shown everything.
            {
                const { control } = views();

                Atomics.store(control, OUTPUT_WRITTEN, 0);
                Atomics.store(control, OUTPUT_TRUNCATED, 0);
                Atomics.store(control, INPUT_TURN, 0);
                Atomics.store(control, INPUT_READY, 0);
            }

            // The runtime's filesystem is on this thread, so a picture can be
            // read the moment its marker is printed. See live-output.js.
            const readFile = path => {
                try {
                    return fs.readFile(path);
                } catch {
                    return null;
                }
            };

            const live = new LiveOutput({ readFile });

            let shown = 0;
            let answered = 0;

            const watch = setInterval(() => {
                const { control, output } = views();

                const written = Atomics.load(control, OUTPUT_WRITTEN);

                if (written > shown) {
                    live.feed(readOutput(output, shown, written));
                    shown = written;
                    onOutput(live.text);
                } else {
                    live.feed();
                }

                if (live.takeChanged()) onImages(live.images);

                // Asked for only when the program is actually waiting, so the
                // box appears because the program wanted a line rather than
                // because somebody guessed it might.
                const turn = Atomics.load(control, INPUT_TURN);

                if (turn !== answered) {
                    answered = turn;
                    waiting = true;
                    onInput(true);
                }
            }, POLL_MS);

            // The host answers with everything the program wrote, which is
            // what the page settles on once the run is over: the live output
            // stops at a cap and lacks what the host adds itself, such as an
            // unhandled exception. It is a promise because with threading
            // enabled the browser's main thread cannot call a synchronous C#
            // method at all.
            let produced;

            try {
                // Each argument is followed by a newline rather than joined
                // by one, so that no arguments and one empty argument are
                // different strings rather than both being empty.
                produced = JSON.parse(await exports.GhulRunner.Run(
                    result.assembly, (args ?? []).map(argument => `${argument}\n`).join('')));
            } finally {
                clearInterval(watch);

                if (waiting) {
                    waiting = false;
                    onInput(false);
                }
            }

            // Read again from the start rather than carried on from the live
            // pass, so what a program that finishes before the first look
            // shows is decided the same way as what one that ran for minutes
            // does. Each file is read in its final state, which is what the
            // live pass last showed.
            const final = new LiveOutput({ readFile: cached(readFile) });

            final.feed(produced.text);
            final.finish();

            let text = final.text;

            if (Atomics.load(views().control, OUTPUT_TRUNCATED) === 1) {
                text += '\n[output stopped here: this program printed more than the playground shows]';
            }

            onOutput(text);
            onImages(final.images);

            // The filesystem lives as long as the tab, so what one run wrote
            // is still there for the next. A program that shows an image it
            // did not write this time would otherwise be shown the last run's
            // picture.
            for (const path of new Set([...live.paths, ...final.paths])) {
                try {
                    fs.unlink(path);
                } catch {
                    // Already gone, or never a file: the next run reads
                    // whatever is there, as it would have anyway.
                }
            }

            // `error` is the runner's: an exception the program did not handle
            // is written into the output rather than thrown out to here, so this
            // is the only thing that distinguishes a program that threw from one
            // that ran to the end.
            onStatus('done', {
                compiled,
                ran: Math.round(performance.now() - ran),
                threw: Boolean(produced.error)
            });
        } catch (e) {
            onOutput(String(e));
            onStatus('error');
        }
    }

    // Whether the program is waiting for a line right now, which decides what
    // stopping it can do.
    let waiting = false;

    // What the page calls when somebody has typed a line. Writing the length
    // before the flag is what makes the handshake safe: the program only ever
    // sees a length that is already there.
    function sendInput(text) {
        const { control, input } = currentViews();

        if (!control) return;

        const length = Math.min(text.length, control[INPUT_CAPACITY]);

        for (let at = 0; at < length; at++) {
            input[at] = text.charCodeAt(at);
        }

        Atomics.store(control, INPUT_LENGTH, length);
        Atomics.store(control, INPUT_READY, 1);

        waiting = false;
    }

    // End of input rather than a line, which is what a program reading until
    // the stream runs out is waiting for.
    function endInput() {
        const { control } = currentViews();

        if (!control) return;

        Atomics.store(control, INPUT_LENGTH, -1);
        Atomics.store(control, INPUT_READY, 1);

        waiting = false;
    }

    // The runtime is only started by the first run, so before then there is no
    // channel to write to - and nothing can be waiting for input either.
    function currentViews() {
        return loaded ? loaded.views() : {};
    }

    // Stopping a program that is waiting for a line is telling it there is no
    // more input, which ends it the way running out of input would and leaves
    // the transcript intact. A program that is not waiting cannot be stopped
    // from here at all: it is managed code on another thread, and nothing in
    // the browser can interrupt that. Answering false says so, and leaves what
    // to do about it to the page.
    function stop() {
        if (!waiting) return false;

        endInput();

        return true;
    }

    return {
        editor,
        run,
        stop,
        sendInput,
        endInput,
        hasToken: () => Boolean(getToken()),
        tokenRequired,
        askForToken: message =>
            askForToken(container.parentElement ?? container, { message })
                .then(entered => { if (entered) client.reconnect(); return entered; }),
        setToken: token => { setToken(token); client.reconnect(); },
        // The client retries on its own, backing off to a minute between
        // attempts. This is for a reader who would rather not wait that out.
        reconnectAnalyser: () => client.reconnect(),
        // A no-op unless the session was reaped for idleness, so callers can
        // wire it to any interaction without ever forcing a reconnect on a
        // healthy or deliberately-backed-off session.
        wakeAnalyser: () => client.wake(),
        setSource: text => editor.setValue(text),
        getSource: () => editor.getValue(),
        // The data files the next run writes into the runtime's working
        // directory. Files an earlier run wrote are left where they are: the
        // filesystem lives as long as the tab, and a program only ever opens
        // the names it was written to open.
        setFiles: next => { files = next ?? []; },
        setTheme: name => monaco.editor.setTheme(themeName(name)),
        contentHeight: () => editor.getContentHeight(),
        dispose: () => { client.dispose(); editor.dispose(); }
    };
}
