// The REPL page: a transcript of cells, an input at the bottom, and the
// session behind it running in a cell host frame.
//
// The page holds no session logic of its own. What to send for a submission,
// what the reply means and how a value is shown are all decided by
// Playground.REPL_SESSION in the frame, on the same session core the terminal
// REPL uses. The page moves text between that, the compile service and the
// screen.

// First, so that the runtime starts its workers from the constructor this
// module wraps; see errors.js.
import { countErrors } from './errors.js'
import { GHUL_LANGUAGE, GHUL_CONFIGURATION } from './ghul-language.js'
import { defineThemes, themeName } from './theme.js'
import { getToken } from './token.js'
import { CellRuntime } from './cell-runtime.js'
import { GhulLanguageClient } from './lsp.js'
import { CELL_SERVICE, ANALYSE_REPL_SERVICE, replAvailability } from './repl-route.js'
import { setUpFullscreen, setUpHelp } from './chrome.js'
import { CellOutput, showValue } from './cell-output.js'
import { countEvent, countBand, countTimeOnPage } from './events.js'

const count = (family, detail) => countEvent(detail ? `${family}/${detail}` : family, family);

countErrors('repl-error');

// Once per page load, so a session's other events have a denominator.
count('repl-open');

// As on the playground page: how long the reader had it in front of them.
countTimeOnPage('repl-time');

// How many cells this session has taken, reported when the session ends rather
// than per cell: the interesting number is how far a session gets, and a count
// per cell would say the same thing once for every step on the way.
let cellsThisSession = 0;

function countSessionLength() {
    if (!cellsThisSession) return;

    count('repl-cells-in-session', countBand(cellsThisSession));

    cellsThisSession = 0;
}

// A tab being hidden is the only end a session usually gets, and pagehide is
// the event that still fires when it is hidden by being closed.
addEventListener('pagehide', countSessionLength);

// Once per session each: that a reader reached for display at all, and that a
// picture appeared, are facts about the session rather than about the cell.
let displayCounted = false;
let pictureCounted = false;

function countDisplay(hasPicture) {
    if (!displayCounted) {
        displayCounted = true;
        count('repl-action', 'display-used');
    }

    if (hasPicture && !pictureCounted) {
        pictureCounted = true;
        count('repl-action', 'picture-shown');
    }
}

const transcript = document.getElementById('transcript');
const inputRow = document.getElementById('input-row');
const prompt = document.getElementById('prompt');
const hint = document.getElementById('hint');
const status = document.getElementById('status');
const compilerIndicator = document.getElementById('compiler');
const analyserIndicator = document.getElementById('analyser');
const runButton = document.getElementById('run');
const runLabel = document.getElementById('run-label');
const resetButton = document.getElementById('reset');

const darkMode = matchMedia('(prefers-color-scheme: dark)');

setUpFullscreen(document.getElementById('fullscreen'),
    () => count('repl-action', 'fullscreen'));

const help = setUpHelp(
    document.getElementById('help'),
    document.getElementById('help-toggle'),
    document.getElementById('help-close'),
    () => count('repl-action', 'help'));

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && help.open) help.close();
});

// An indicator's state, and the tooltip that says what it means.
function indicate(indicator, state, title) {
    indicator.dataset.state = state;
    indicator.title = title;
}

const SERVING = 'The compile service is serving sessions';

// A `?repl` on the URL, which links from before sessions were on by default
// carry, changes nothing.
const { limits, off } = await replAvailability();

if (limits) {
    indicate(compilerIndicator, 'ready', SERVING);
    document.getElementById('help-max-cells').textContent = String(limits.maxCells);
} else if (off) {
    indicate(compilerIndicator, 'off', 'Interactive sessions are switched off on this server');
} else {
    indicate(compilerIndicator, 'failed', 'The compile service could not be reached');
}

if (!limits) {
    const unavailable = document.getElementById('unavailable');

    unavailable.textContent = off
        ? 'Interactive sessions are switched off on this server at the moment.'
        : 'The compile service could not be reached. Try again in a moment.';

    unavailable.hidden = false;
    indicate(analyserIndicator, 'dormant', 'No session to analyse');
} else {
    await start();
}

function loadMonaco() {
    return new Promise(resolve => {
        require.config({ paths: { vs: 'vs' } });

        require(['vs/editor/editor.main'], () => {
            monaco.languages.register({ id: 'ghul' });
            monaco.languages.setMonarchTokensProvider('ghul', GHUL_LANGUAGE);
            monaco.languages.setLanguageConfiguration('ghul', GHUL_CONFIGURATION);

            defineThemes();

            resolve();
        });
    });
}

async function start() {
    await loadMonaco();

    const setTheme = () => monaco.editor.setTheme(themeName(darkMode.matches ? 'vs-dark' : 'vs'));

    setTheme();
    darkMode.addEventListener('change', setTheme);

    const container = document.getElementById('input');

    const editor = monaco.editor.create(container, {
        language: 'ghul',
        value: '',
        minimap: { enabled: false },
        lineNumbers: 'off',
        glyphMargin: false,
        folding: false,
        scrollBeyondLastLine: false,
        overviewRulerLanes: 0,
        renderLineHighlight: 'none',
        scrollbar: { vertical: 'hidden', alwaysConsumeMouseWheel: false },
        fontFamily: "'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontLigatures: true,
        wordWrap: 'on',
        automaticLayout: true
    });

    // The input grows with what is typed rather than scrolling inside itself.
    const fit = () => {
        container.style.height = `${Math.max(editor.getContentHeight(), 22)}px`;
        editor.layout();
    };

    editor.onDidContentSizeChange(fit);
    fit();

    // The compiler indicator covers everything between pressing Run and the
    // answer, as the playground's does: starting the runtime the cells run
    // on, compiling, and running. `phase` is where a submission is, and
    // `failure` why the last one did not reach the service.
    let phase = '';
    let starting = false;
    let failure = null;

    const showCompiler = () => {
        if (starting) {
            status.textContent = 'starting the .NET runtime ...';
            indicate(compilerIndicator, 'working', 'Starting the .NET runtime the cells run on');
        } else if (phase) {
            status.textContent = `${phase} ...`;
            indicate(compilerIndicator, 'working', phase === 'running' ? 'Running a cell' : 'Compiling a cell');
        } else {
            status.textContent = 'compiler';
            indicate(compilerIndicator, failure ? 'failed' : 'ready', failure ?? SERVING);
        }

        // Stop is only offered once a cell is running: before then there is
        // nothing to interrupt yet.
        const running = phase === 'running';

        // With nothing typed there is nothing to run.
        runButton.disabled = phase ? !running : !editor.getValue().trim();

        // Nothing to discard before the first cell, except a cell still under way.
        resetButton.disabled = !phase && number === 1;
        runButton.toggleAttribute('data-busy', !!phase && !running);
        runButton.toggleAttribute('data-stop', running);
        runLabel.textContent = running ? 'Stop' : 'Run';
        runButton.title = running
            ? 'Stop the cell. Code running in the browser cannot be interrupted, so the session goes with it'
            : 'Run the cell (Shift+Enter)';
    };

    const onRuntimeState = state => {
        starting = state === 'starting';
        showCompiler();
    };

    let number = 1;
    let busy = false;
    let runtime = new CellRuntime(document.body, { onState: onRuntimeState });

    // Counts sessions, so a reply that arrives after its session was stopped
    // is recognised and dropped rather than handed to the next one.
    let generation = 0;

    const history = [];
    let historyAt = 0;

    // Diagnostics, hover and completion for what is being typed, from an
    // analyser of its own. It analyses the input as the next cell would be
    // compiled - the session's prelude, then the input - against the cells
    // accepted so far, which the analyse service takes from the compile
    // service's cache by key. A session that ends takes its analyser with it,
    // since the next one reuses the cell names.
    let analyser = null;
    let analysis = { source: '', offset: 0 };
    let cells = [];
    let added = 0;
    let analysisTimer = null;

    const ANALYSER_TITLES = {
        ready: 'Errors, hovers and completions as you type',
        connecting: 'Connecting to the analyser',
        dormant: 'The analyser was given back while the page was idle; it reconnects when you type',
        refused: 'Too many editors are open from this address; cells still compile and run',
        disconnected: 'The analyser is not reachable; cells still compile and run. Click to try again'
    };

    function showAnalyser(state) {
        const shown = state === 'refused' ? 'disconnected' : state;

        indicate(analyserIndicator, shown, ANALYSER_TITLES[state] ?? state);
    }

    analyserIndicator.addEventListener('click', () => {
        if (analyserIndicator.dataset.state !== 'ready') analyser?.reconnect();
    });

    function startAnalysis() {
        analyser?.dispose();

        cells = [];
        added = 0;
        analysis = { source: '', offset: 0 };

        const client = new GhulLanguageClient(ANALYSE_REPL_SERVICE, {
            getToken,
            onOutcome: outcome => count('repl-analyser', outcome),
            onStatus: showAnalyser,
            documentText: () => analysis.source,
            lineOffset: () => analysis.offset,
            // A fresh analyser has none of the cells.
            onReady: () => {
                added = 0;
                addCells();
                refreshAnalysis();
            }
        });

        analyser = client;
        client.attach(editor.getModel());
    }

    async function addCells() {
        const client = analyser;

        if (!client.ready || added >= cells.length) return;

        const adding = cells.slice(added);
        added = cells.length;

        await client.request('playground/addCells', { cells: adding });

        if (client === analyser) refreshAnalysis();
    }

    async function refreshAnalysis() {
        if (busy) return;

        const client = analyser;
        const text = editor.getValue();
        const answer = await runtime.call('analysis', text);

        if (client !== analyser || !answer || answer.stopped || answer.error || editor.getValue() !== text) return;

        analysis = { source: answer.source, offset: answer.offset };
        client.changed(analysis.source);
    }

    editor.onDidChangeModelContent(() => {
        clearTimeout(analysisTimer);
        analysisTimer = setTimeout(() => {
            analysisTimer = null;
            refreshAnalysis();
        }, 300);

        if (!phase) showCompiler();
    });

    const isInput = model => model === editor.getModel();

    monaco.languages.registerHoverProvider('ghul', {
        provideHover: (model, position) => isInput(model) ? analyser.hover(position) : null
    });

    monaco.languages.registerCompletionItemProvider('ghul', {
        triggerCharacters: ['.'],
        provideCompletionItems: async (model, position, context) => {
            if (!isInput(model)) return { suggestions: [] };

            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
                startColumn: word.startColumn, endColumn: word.endColumn
            };

            // The input is only analysed after a pause in typing, and typing
            // '.' asks for completion at once: bring the analysis up to date
            // first, or the answer is about the text before the dot.
            if (analysisTimer !== null) {
                clearTimeout(analysisTimer);
                analysisTimer = null;
                await refreshAnalysis();
            }

            const items = await analyser.completion(position, context);

            return { suggestions: items.map(item => ({ ...item, range })) };
        }
    });

    startAnalysis();

    const setPrompt = () => { prompt.textContent = `[${number}]`; };

    const setBusy = (value, text = '') => {
        busy = value;
        phase = value ? text : '';
        editor.updateOptions({ readOnly: value });
        showCompiler();
    };

    showCompiler();

    inputRow.hidden = false;
    hint.hidden = false;
    setPrompt();
    editor.focus();

    const scrollToInput = () => inputRow.scrollIntoView({ block: 'end' });

    function addEntry(label, text) {
        const entry = document.createElement('div');

        entry.className = 'entry';

        const input = document.createElement('div');
        const promptLabel = document.createElement('span');
        const code = document.createElement('code');

        input.className = 'input';
        promptLabel.className = 'prompt';
        promptLabel.textContent = label;
        code.textContent = text;

        monaco.editor.colorize(text, 'ghul', {}).then(html => { code.innerHTML = html; });

        input.append(promptLabel, code);

        const result = document.createElement('div');

        result.className = 'result';
        entry.append(input, result);
        transcript.insertBefore(entry, inputRow);

        return result;
    }

    function line(result, className, text) {
        const div = document.createElement('div');

        div.className = className;
        div.textContent = text;
        result.appendChild(div);
    }

    // Ends the session: its frame and every cell in it go, and the next
    // submission starts a new one at cell 1.
    function resetSession() {
        countSessionLength();

        displayCounted = false;
        pictureCounted = false;

        generation++;
        runtime.dispose();
        runtime = new CellRuntime(document.body, { onState: onRuntimeState });
        number = 1;
        setPrompt();
        startAnalysis();
        showCompiler();
    }

    async function post(cells) {
        const token = getToken();

        const response = await fetch(CELL_SERVICE, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ cells })
        });

        if (response.status === 409) return { broken: true };

        if (response.status === 429 || response.status === 503) {
            failure = 'The compile service was busy for the last cell';
            return { reply: JSON.stringify({ ok: false, error: 'the compile service is busy; run the cell again in a moment' }) };
        }

        const text = await response.text();

        // Every answer the service gives is JSON; anything else came from
        // something in front of it.
        try {
            JSON.parse(text);
            return { reply: text };
        } catch {
            failure = `The compile service answered HTTP ${response.status} for the last cell`;
            return { reply: JSON.stringify({ ok: false, error: `the compile service answered HTTP ${response.status}` }) };
        }
    }

    async function submit(text) {
        if (busy || !text.trim()) return;

        history.push(text);
        historyAt = history.length;

        editor.setValue('');
        failure = null;

        const result = addEntry(`[${number}]`, text);

        // How this cell ended, counted once in the finally below whichever way it
        // leaves. `ok` is the value it keeps if nothing worse happens.
        let outcome = 'ok';

        scrollToInput();
        setBusy(true, 'compiling');

        try {
            const session = generation;

            let prepared = await runtime.call('prepare', text);
            let answer = null;

            // What the cell writes and displays, shown as it happens. The
            // answer carries the whole of it again, so once the answer is in
            // this goes and the answer is shown in its place; a cell that is
            // stopped keeps it.
            const live = new CellOutput(result, { onDisplay: countDisplay });
            let truncatedNote = null;

            const showLive = (chunk, truncated) => {
                live.feed(chunk);

                if (truncated && !truncatedNote) {
                    line(result, 'muted', 'more output than can be shown while the cell runs; all of it is shown when it finishes');
                    truncatedNote = result.lastChild;
                }

                scrollToInput();
            };

            const dropLive = () => {
                live.clear();
                truncatedNote?.remove();
                truncatedNote = null;
            };

            while (prepared && !prepared.stopped && !prepared.error) {
                const posted = await post(prepared.cells);

                if (session !== generation) {
                    prepared = { stopped: true };
                    break;
                }

                if (posted.broken) {
                    outcome = 'compile-error';
                    line(result, 'error', 'an earlier cell no longer compiles here, so the session has been reset; run this cell again');
                    resetSession();
                    return;
                }

                setBusy(true, 'running');

                answer = await runtime.callLive('accept', showLive, posted.reply);

                if (!answer.stopped) dropLive();

                if (answer.accepted) {
                    // Counted here rather than at the end, so a cell that fills the
                    // session is counted into the session it filled.
                    cellsThisSession++;

                    const keys = JSON.parse(posted.reply).keys ?? [];

                    cells = prepared.cells
                        .map((cell, index) => ({ name: cell.name, key: keys[index] }))
                        .filter(cell => typeof cell.key === 'string');

                    addCells();
                }

                if (answer.retry) {
                    prepared = answer.retry;
                    setBusy(true, 'compiling');
                    continue;
                }

                break;
            }

            if (prepared?.error) {
                outcome = 'compile-error';
                line(result, 'error', prepared.error);
                return;
            }

            if (prepared?.stopped || answer?.stopped) {
                outcome = 'stopped';
                line(result, 'muted', 'stopped; the session was reset');
                number = 1;
                return;
            }

            for (const d of answer.diagnostics ?? []) {
                const kind = / warn:| warn$/.test(d) ? 'diagnostic warn' : d.startsWith('ghul:') ? 'note' : 'diagnostic';

                line(result, kind, d);
            }

            if (answer.text) new CellOutput(result).feed(answer.text.replace(/\n$/, ''));
            if (answer.value != null) {
                line(result, 'value', answer.value);

                if (answer.picture) showValue(result.lastChild, answer.value, answer.picture);
            }
            if (answer.error) {
                outcome = 'threw';
                line(result, 'error', answer.error);
            } else if (!answer.accepted) {
                outcome = 'compile-error';
            }

            if (Number.isFinite(answer.next)) number = answer.next;

            if (answer.accepted && number > limits.maxCells) {
                line(result, 'muted', `a session here holds ${limits.maxCells} cells; the next one starts a new session`);
                resetSession();
            }
        } catch (e) {
            outcome = 'error';
            failure = `The last cell did not reach the compile service: ${e.message ?? e}`;
            line(result, 'error', `${e.message ?? e}`);
        } finally {
            count('repl-cell', outcome);

            setPrompt();
            setBusy(false);
            refreshAnalysis();
            scrollToInput();
            editor.focus();
        }
    }

    const isLastLine = () => editor.getPosition().lineNumber === editor.getModel().getLineCount();

    editor.onKeyDown(e => {
        if (e.keyCode === monaco.KeyCode.Enter) {
            const model = editor.getModel();

            if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                submit(model.getValue());
                return;
            }

            // A line holding only a dot ends the cell, as it does in the
            // terminal; the dot is not part of it.
            const lineNumber = editor.getPosition().lineNumber;

            if (isLastLine() && model.getLineContent(lineNumber).trim() === '.') {
                e.preventDefault();
                e.stopPropagation();

                const lines = model.getValue().split('\n');

                submit(lines.slice(0, lineNumber - 1).join('\n'));
            }

            return;
        }

        // Earlier cells, from the first or last line of the input.
        if (e.altKey && (e.keyCode === monaco.KeyCode.UpArrow || e.keyCode === monaco.KeyCode.DownArrow)) {
            e.preventDefault();

            historyAt = e.keyCode === monaco.KeyCode.UpArrow
                ? Math.max(0, historyAt - 1)
                : Math.min(history.length, historyAt + 1);

            editor.setValue(history[historyAt] ?? '');
            editor.setPosition({ lineNumber: editor.getModel().getLineCount(), column: 1e6 });
        }
    });

    // The mouse's Shift+Enter, and Stop while a cell runs.
    runButton.addEventListener('click', () => {
        if (phase !== 'running') {
            submit(editor.getValue());
            return;
        }

        generation++;
        runtime.stop();
        startAnalysis();
    });

    resetButton.addEventListener('click', () => {
        // Asked only when there is something to lose.
        if (number > 1 && !confirm('Start a new session? The cells so far, and what they defined, are discarded.')) return;

        count('repl-action', 'new-session');

        if (busy) runtime.stop();

        resetSession();

        const result = addEntry('', '');

        line(result, 'muted', 'new session');
        scrollToInput();
        editor.focus();
    });
}
