// The standalone playground page. All the behaviour is in playground.js; this
// is the chrome around it.

// First, so that the runtime starts its workers from the constructor this
// module wraps; see errors.js.
import { countErrors } from './errors.js'
import { createPlayground, replOffered } from './playground.js'
import { replPageUrl } from './repl-route.js'
import { setUpFullscreen, setUpHelp } from './chrome.js'
import { requestedProgram, loadProgram, pathBelowBase } from './collections.js'
import { parseArguments, renderArguments } from './arguments.js'
import * as files from './files.js'
import { countEvent, countPageview, band, countTimeOnPage } from './events.js'
import { isAheadOfWiki, loadIndex, suggestions as suggest, taskFor } from './rosetta-index.js'
import { whenReader } from './engagement.js'

// Where this mini-IDE is: its own page, or framed on an example page or a
// Rosetta task page, which the framing page says in the address. Every event
// carries it, since the same action means something different in each.
const HOSTS = ['example-page', 'rosetta-task-page'];
const HOST = HOSTS.find(h => h === new URLSearchParams(location.search).get('host')) ?? 'standalone';

// Every event this page sends names what the reader did, never what they wrote:
// mini-ide-<what>/<host>/<detail>.
const count = (what, detail) => countEvent(`mini-ide-${what}/${HOST}${detail ? `/${detail}` : ''}`, `mini-ide-${what}`);

countErrors(`mini-ide-error/${HOST}`, countEvent);

const runButton = document.getElementById('run');
const argumentsRow = document.getElementById('arguments-row');
const argumentsInput = document.getElementById('arguments');
const runLabel = document.getElementById('run-label');
const inputRow = document.getElementById('input-row');
const stdin = document.getElementById('stdin');
const status = document.getElementById('status');
const compiler = document.getElementById('compiler');
const analyser = document.getElementById('analyser');
const analyserText = document.getElementById('analyser-text');
const diagnosticsPane = document.getElementById('diagnostics');
const outputPane = document.getElementById('output');

// The note a stop leaves for the reload it makes, so the page comes back with
// the program not running rather than running again.
const STOPPED_KEY = 'ghul-playground-stopped';
const problemCount = document.getElementById('problem-count');

const STATUS_TEXT = {
    compiling: () => 'compiling ...',
    'starting runtime': () => 'starting the .NET runtime ...',
    running: () => 'running ...',
    failed: () => 'compilation failed',
    busy: () => 'the service is busy, try again',
    error: () => 'failed',
    done: () => 'compiler',
    ready: () => 'compiler'
};

const BUSY = new Set(['compiling', 'running', 'starting runtime']);

// What the run cost, beside its output rather than in the header. Somebody who
// pressed run is already looking at the pane below, while the header is for
// what the services are doing now rather than for what they did a moment ago.
const runCost = document.getElementById('run-cost');

function reportCost(detail) {
    runCost.textContent = detail
        ? `compiled in ${detail.compiled} ms \u00b7 ran in ${detail.ran} ms`
        : '';
}

// What the compiler dot's colour means, for the tooltip. `failed` is about the
// last run - a compile error or a busy service - not about the service dying.
const COMPILER_TITLE = {
    ready: 'The compile service is ready',
    working: 'Compiling or running',
    failed: 'The last run did not complete: see the problems pane'
};

// What the dot means, and what the tooltip says it means. `dormant` is not a
// failure: the session was reaped for idleness and the next edit brings it
// back, so it must not look like the analyser has died.
const ANALYSER_STATE = {
    ready: ['analyser', 'The analyser is connected: errors, hovers and completions are live'],
    connecting: ['connecting', 'Connecting to the analyser ...'],
    dormant: ['analyser idle', 'The analyser session was released after a pause, while the page was out of sight, or for another editor open from the same network address. Editing reconnects it, or click to reconnect now'],
    refused: ['analyser limit reached', 'The analyser allows a few editors at a time from one network address, and that many are already open. This one still compiles and runs; errors as you type and hovers come back by themselves once another editor is closed'],
    disconnected: ['no analyser', 'The analyser is not reachable. Reconnecting automatically; click to try now']
};

// --- the pane below the editor -------------------------------------------

const pane = document.getElementById('pane');
const paneToggle = document.getElementById('pane-toggle');

// The height to come back to. The pane's own height is cleared while
// collapsed, so without this an expand would forget a drag made before it.
let paneHeight = '';

function setPaneCollapsed(collapsed) {
    if (collapsed === (pane.dataset.collapsed !== undefined)) return;

    if (collapsed) {
        paneHeight = pane.style.height;
        pane.style.height = '';
        pane.dataset.collapsed = '';
    } else {
        delete pane.dataset.collapsed;
        pane.style.height = paneHeight;
    }

    const label = collapsed ? 'Expand the pane' : 'Collapse the pane';

    paneToggle.setAttribute('aria-expanded', String(!collapsed));
    paneToggle.setAttribute('aria-label', label);
    paneToggle.title = label;
}

paneToggle.addEventListener('click', () => setPaneCollapsed(pane.dataset.collapsed === undefined));

const tabs = [
    { button: document.getElementById('tab-problems'), panel: diagnosticsPane },
    { button: document.getElementById('tab-output'), panel: outputPane }
];

// Every caller is putting something in front of the reader, so a collapsed
// pane is opened rather than switched behind their back.
function showTab(panel) {
    setPaneCollapsed(false);

    for (const tab of tabs) {
        const selected = tab.panel === panel;
        tab.button.setAttribute('aria-selected', String(selected));
        tab.panel.hidden = !selected;
    }

    showTaskLabels();
}

// The page as a panel inside another: ghul.dev frames it on a task's own page,
// where that page already says which task this is and offers the others. The
// links that would say the same thing again, and the help that describes the
// playground as a site, are left out; the playground itself is unchanged.
const panel = new URLSearchParams(location.search).has('panel');

if (panel) document.documentElement.dataset.panel = '';

// Filled in once the program is known, and emptied when the buffer stops
// being that program.
const taskIdentity = document.getElementById('task-identity');
const moreToRun = document.getElementById('more-to-run');
const suggestions = document.getElementById('suggestions');
const moreLinks = document.getElementById('more-links');

// The identity labels the pane whichever tab is showing, since it says what the
// program is rather than anything about its output. The suggestions are for a
// reader looking at what their program did, so they follow the output tab.
function showTaskLabels() {
    taskIdentity.hidden = !taskIdentity.hasChildNodes();
    moreToRun.hidden = outputPane.hidden || !suggestions.hasChildNodes();
}

for (const tab of tabs) {
    tab.button.addEventListener('click', () => showTab(tab.panel));
}

const splitter = document.getElementById('splitter');

splitter.addEventListener('pointerdown', event => {
    splitter.setPointerCapture(event.pointerId);
    setPaneCollapsed(false);
    splitter.dataset.dragging = '';

    const move = e => {
        // Bounded so neither the editor nor the pane can be dragged away
        // entirely, which is easy to do by accident and hard to undo.
        const height = Math.min(Math.max(window.innerHeight - e.clientY, 36), window.innerHeight - 160);
        pane.style.height = `${height}px`;
    };

    const up = () => {
        delete splitter.dataset.dragging;
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
    };

    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
});

// --- the images this program drew ----------------------------------------

const imagesPane = document.getElementById('images');
const imagesGrid = document.getElementById('images-grid');
const imagesTitle = document.getElementById('images-title');
const imagesToggle = document.getElementById('images-toggle');
const imagesCount = document.getElementById('images-count');
const imagesSizes = [...document.querySelectorAll('#images-sizes button')];

const DOWNLOAD_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M7.2 1h1.6v6.3l2.3-2.3 1.1 1.1L8 10.4 3.8 6.1l1.1-1.1 2.3 2.3V1zM2 12h12v1.6H2z" /></svg>';

// The pictures on the page, by name, in the order shown. A program that
// animates shows the same names again and again, and those are updated where
// they are rather than laid out afresh, so the pane neither flickers nor moves.
let shownImages = [];

function showImages(list) {
    if (list.length && list.length === shownImages.length
        && list.every((image, at) => image.name === shownImages[at].name)) {
        list.forEach((image, at) => {
            const shown = shownImages[at];

            if (shown.url !== image.url) {
                shown.url = image.url;
                shown.img.src = image.url;
            }
        });

        return;
    }

    shownImages = [];

    imagesToggle.hidden = list.length === 0;
    imagesCount.textContent = list.length > 1 ? String(list.length) : '';

    if (!list.length) {
        imagesPane.hidden = true;
        imagesGrid.replaceChildren();
        return;
    }

    imagesTitle.textContent = list.length === 1 ? 'Image' : `${list.length} images`;

    // Roughly square: with four drawings, two rows of two uses a window far
    // better than one row of four does. The floor keeps a tile worth looking
    // at once there are enough of them for that to bite.
    const across = Math.ceil(Math.sqrt(list.length));

    imagesGrid.style.setProperty('--tile', `${Math.max(18, 60 / across)}rem`);

    // How tall one drawing may be, so that laying them out across also lays
    // them out down: one gets the pane, four get a quarter of it each.
    imagesGrid.style.setProperty('--shelf', `${Math.max(24, 68 / across)}vh`);

    imagesGrid.replaceChildren(...list.map(image => {
        const figure = document.createElement('figure');

        const frame = document.createElement('div');
        frame.className = 'frame';

        const img = document.createElement('img');
        img.src = image.url;
        img.alt = image.name;

        const shown = { name: image.name, url: image.url, img };

        shownImages.push(shown);

        // The shelf above bounds the height, and the layout needs the width
        // that height implies. Only the decoded image knows its proportions,
        // so the figure is told once it has them.
        img.addEventListener('load', () =>
            figure.style.setProperty('--aspect', img.naturalWidth / img.naturalHeight));

        frame.append(img);

        const caption = document.createElement('figcaption');

        const name = document.createElement('span');
        name.textContent = image.name;

        // The picture exists only in this page - the program wrote it to a
        // filesystem that is the browser's memory - so without this there is
        // no way to get one out.
        const download = document.createElement('button');
        download.innerHTML = DOWNLOAD_ICON;
        download.title = `Save ${image.name}`;
        download.setAttribute('aria-label', `Save ${image.name}`);
        download.addEventListener('click', () => {
            count('action', 'save-image');

            files.saveImage(shown.url, image.name);
        });

        caption.append(name, download);
        figure.append(frame, caption);

        return figure;
    }));

    imagesPane.hidden = false;
}

imagesToggle.addEventListener('click', () => { imagesPane.hidden = !imagesPane.hidden; });
document.getElementById('images-close').addEventListener('click', () => { imagesPane.hidden = true; });

// Three sizes. Fit is the useful default; actual size is the one a reader asks
// for when a detail matters; small leaves the code showing around the picture,
// which is where a panel starts so that a reader who arrived for the picture
// can see there is a program behind it.
function showImagesAt(size) {
    imagesPane.dataset.size = size;

    for (const button of imagesSizes) {
        button.setAttribute('aria-pressed', String(button.dataset.size === size));
    }
}

showImagesAt(panel ? 'small' : 'fit');

for (const button of imagesSizes) {
    button.addEventListener('click', () => showImagesAt(button.dataset.size));
}

// The pictures are all there is to look at, so a click on the space around
// them - not on a picture, its caption or the bar - is a click to be done
// with them, as Escape is.
imagesGrid.addEventListener('click', event => {
    if (event.target.closest('figure')) return;

    imagesPane.hidden = true;
});

// Framed on a page, the keyboard is the page's until the reader clicks into
// this document, so the page passes Escape on.
if (panel) {
    window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.data?.ghul !== 'escape') return;

        dismissTopmost();
    });
}

// --- full screen ----------------------------------------------------------

setUpFullscreen(document.getElementById('fullscreen'),
    () => count('action', 'fullscreen'));

// --- the about panel ------------------------------------------------------

const help = setUpHelp(
    document.getElementById('help'),
    document.getElementById('help-toggle'),
    document.getElementById('help-close'),
    () => count('action', 'help'));

// Innermost first: the about panel sits over the images, which sit over the
// editor, and Escape should dismiss one layer rather than all of them.
function dismissTopmost() {
    if (help.open) help.close();
    else if (!imagesPane.hidden) imagesPane.hidden = true;
}

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') dismissTopmost();
});

// --- the editor -----------------------------------------------------------

const darkMode = window.matchMedia('(prefers-color-scheme: dark)');

// The system setting, unless the page framing this one has said which theme
// it is showing - it has a switch of its own, and a panel that ignored it
// would sit dark in a light page.
const isDark = () => document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : darkMode.matches;

// The editor's content survives the tab: saved on edit, restored on load.
// Storage can be unavailable (private windows, blocked site data), in which
// case the page behaves as it always did and starts from the default source.
const STORAGE_KEY = 'ghul-playground-source';

const savedSource = (() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
})();

// A program named by the page's path, such as .../rosetta-code/100-doors, takes
// the place of the saved source. Loading it again on reload is what the link
// promises, so edits to it are not restored over it.
// Both change when a suggestion is taken: the page opens another task where it
// stands rather than loading itself again, so what the buffer is has to be able
// to move with it.
let requested = requestedProgram(pathBelowBase());

let program = requested
    ? await loadProgram(requested).catch(e => ({ error: e.message }))
    : null;

if (program?.source) document.title = `${requested.name} - ghūl playground`;

// Two questions about the buffer, kept together because they answer as a pair:
// which file it is, once it has been opened or saved as one, and which program
// it came from, when the page was asked for one by path.
//
// The path is provenance rather than identity. It stays true while the buffer
// is that program edited - following the link still loads the program, which is
// what a reader who is sent one expects - and stops naming it the moment the
// buffer becomes something else. Same rule as Save As in an editor: once the
// document is saved somewhere else, the path it was opened from is no longer
// what it is.
let currentName = null;
let provenance = requested;

// Where the buffer came from, once per page load, as the collection it was
// named from or as the reason there was no name: a program restored from the
// last visit, or the one the page ships with. The collection rather than the
// program, because the program is already the run event's business and a path
// per task would say the same thing twice.
count('open', requested ? requested.name.split('/')[0]
    : savedSource ? 'restored'
    : 'default');

// Which theme the reader is actually shown. It follows the system preference
// and there is no control for it, so this is the only way to know.
count('theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

// How long the page was actually in front of the reader, counted once as they
// leave. Nothing else can recover it: every other event says something happened
// and none says how long nothing did.
countTimeOnPage(`mini-ide-time/${HOST}`);

function forgetProvenance() {
    if (!provenance) return;

    provenance = null;

    // replaceState rather than pushState: replacing the buffer is not a
    // navigation, and a back button that returned to the program the reader
    // has just thrown away would be a trap rather than a convenience.
    history.replaceState(null, '', document.baseURI);

    document.title = currentName ? `${currentName} - ghūl playground` : 'ghūl playground';

    renderProgram();
}

// Whether the output pane is showing its own tail, and so whether new output
// should be scrolled into view - the way a terminal follows its own output,
// while a reader who has scrolled up to look at something is left where they
// are. It is tracked from the reader's own scrolling rather than measured when
// text arrives, because the input box appearing takes its height off the pane
// and moves the tail out of view without the reader having touched anything;
// measured at that moment the pane reads as scrolled up, and would stay that
// way for the rest of the run.
let followingOutput = true;

outputPane.addEventListener('scroll', () => {
    followingOutput =
        outputPane.scrollTop + outputPane.clientHeight >= outputPane.scrollHeight - 4;
});

const followOutput = () => {
    if (followingOutput) outputPane.scrollTop = outputPane.scrollHeight;
};

// Whether the current run has written anything, set false when a run starts
// and true by the first output that arrives. The pane's no-output verdict is
// decided from it at the run's terminal state, rather than from an empty
// onOutput: an empty one is only ever the run clearing the pane, so reading
// it as a verdict would declare a run output-less while it is still
// compiling.
let runShowedOutput = false;

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinTimer = null;
let runUnderway = false;

// The braille spinner sits where a terminal's cursor would be: after whatever
// the run has written, from the moment the run starts to the moment it ends.
// While there is nothing yet it is the pane's whole content; once there is
// output it follows the last character, so a program that prints a message
// and then works in silence still shows that it is working. The status bar
// beneath says which phase the run is in, so the spinner needs no words of
// its own. Left on its first frame where the reader has asked reduced motion.
const spinner = document.createElement('span');
spinner.className = 'spin';
spinner.setAttribute('aria-hidden', 'true');
spinner.textContent = SPIN_FRAMES[0];

// How much slower this browser runs a program than the machine the tasks'
// recorded timings were measured on: the ratio of a finished run's own time
// to the task's recorded one, kept from the last run long enough to say it.
// The wasm interpreter costs anywhere from twice to fifty times a native run
// depending on how much of the program's time is in its own loops, so one
// measured ratio beats any single assumed number, and eight is what a reader
// gets before anything has been measured.
const SPEED_KEY = 'ghul-playground-speed';
const DEFAULT_SPEED = 8;
const STARTUP_MS = 2500;

const recordedSpeed = () => {
    try {
        const speed = Number(localStorage.getItem(SPEED_KEY));

        return Number.isFinite(speed) && speed >= 1 && speed <= 50 ? speed : DEFAULT_SPEED;
    } catch {
        return DEFAULT_SPEED;
    }
};

const rememberSpeed = (ran_ms, recorded_ms) => {
    if (!recorded_ms || ran_ms < 1000) return;

    try {
        const speed = Math.min(50, Math.max(1, ran_ms / recorded_ms));

        localStorage.setItem(SPEED_KEY, String(speed));
    } catch { /* nothing stored is the status quo */ }
};

// What a wait is expected to cost this reader, in words coarse enough that
// the estimate's assumptions (a recorded timing from one machine, a speed
// ratio from one earlier run) are not lent a precision they do not have.
const waitWords = first_output_ms => {
    const wait = STARTUP_MS + first_output_ms * recordedSpeed();

    if (wait < 90_000) return `up to about ${Math.max(5, Math.round(wait / 5000) * 5)} seconds`;
    if (wait < 300_000) return 'over a minute';

    return 'several minutes';
};

// Said beside the spinner while the program has yet to print anything, for
// the tasks whose recorded wait before a first line reaches half a second:
// a reader told nothing assumes the blank pane is a broken one.
const waitNote = document.createElement('span');
waitNote.className = 'empty note';

const showSpinner = () => {
    if (!runShowedOutput && program?.firstOutputMs) {
        waitNote.textContent =
            ` This program works silently for a while before its first output: `
            + `in a browser that can be ${waitWords(program.firstOutputMs)}.`;

        if (waitNote.parentNode !== outputPane) outputPane.appendChild(waitNote);
    }

    if (outputPane.lastChild !== spinner) outputPane.appendChild(spinner);

    if (spinTimer || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let i = 0;
    spinTimer = setInterval(() => {
        i = (i + 1) % SPIN_FRAMES.length;
        spinner.textContent = SPIN_FRAMES[i];
    }, 80);
};

const hideSpinner = () => {
    if (spinTimer) clearInterval(spinTimer);
    spinTimer = null;
    spinner.remove();
    waitNote.remove();
};

const initialSource = program?.source ?? savedSource;

const playground = await createPlayground({
    container: document.getElementById('editor'),
    theme: isDark() ? 'vs-dark' : 'vs',
    ...(initialSource ? { source: initialSource } : {}),
    files: program?.files ?? [],

    onAnalyserOutcome: outcome => count('analyser', outcome),

    onOutput: text => {
        if (!text) followingOutput = true;

        if (text) {
            countFirstOutput();
            runShowedOutput = true;
            outputPane.textContent = text;
        } else {
            // An empty call is only ever the run clearing the pane: the
            // no-output verdict is decided at the run's terminal state, from
            // whether output ever arrived, and never here.
            outputPane.textContent = '';
        }

        if (runUnderway) showSpinner();
        followOutput();
    },

    // Shown when the program asks and taken away the moment it stops asking,
    // including when the run ends while it is still waiting - a box left
    // behind would take a line nothing is going to read.
    onInput: wanted => {
        inputRow.hidden = !wanted;

        if (!wanted) return;

        // showTab expands the pane as well, so a box in a collapsed one is
        // not asked for and then hidden.
        showTab(outputPane);
        stdin.focus();

        // The row takes its height off the pane, and focusing the box can
        // scroll an ancestor, so the tail has to be brought back after both.
        followOutput();
    },

    onImages: showImages,

    onDiagnostics: list => {
        problemCount.hidden = list.length === 0;
        problemCount.textContent = String(list.length);
        problemCount.dataset.severity = list.some(d => d.severity === 'error') ? 'error' : 'warn';

        if (!list.length) {
            diagnosticsPane.innerHTML = '<span class="empty">No problems.</span>';
            return;
        }

        diagnosticsPane.replaceChildren(...list.map(d => {
            const line = document.createElement('div');
            line.className = d.severity;
            line.textContent = `${d.startLine},${d.startColumn}: ${d.severity}: ${d.message}`;
            return line;
        }));
    },

    onStatus: (state, detail) => {
        status.textContent = (STATUS_TEXT[state] ?? (() => state))(detail);

        compiler.dataset.state =
            BUSY.has(state) ? 'working'
            : state === 'failed' || state === 'error' || state === 'busy' ? 'failed'
            : 'ready';
        compiler.title = COMPILER_TITLE[compiler.dataset.state];

        // Once a program is actually running the button is how it is stopped,
        // so it stays live through that state alone - compiling and starting
        // the runtime have nothing to interrupt yet.
        const running = state === 'running';

        runButton.disabled = BUSY.has(state) && !running;
        runButton.toggleAttribute('data-busy', BUSY.has(state) && !running);
        runButton.toggleAttribute('data-stop', running);

        runLabel.textContent = running ? 'Stop' : 'Run';
        runButton.title = running
            ? 'Stop the program. A program waiting for input is told there is none left; '
              + 'one that is busy can only be stopped by reloading the page'
            : 'Compile and run (Ctrl+Enter)';

        // Follow the run: its output while it runs, its problems when it will
        // not compile. Somebody watching the button should not also have to
        // know which tab to be on.
        if (state === 'running' || state === 'done') showTab(outputPane);
        if (state === 'failed') showTab(diagnosticsPane);

        // Cleared when the next run starts, so it always describes the run
        // whose output is on screen.
        if (state === 'done') reportCost(detail);
        if (BUSY.has(state)) reportCost(null);

        // A finished run whose task carries a recorded time says how fast
        // this browser is, which is what scales the next task's estimate.
        if (state === 'done') rememberSpeed(detail?.ran, program?.runMs);

        // The spinner follows the run itself: shown from the first busy state
        // to the terminal one, so it rides after output that has already been
        // written and is taken away when the run ends. `unauthorized` is not
        // terminal - the run resumes once the reader has answered - but the
        // work is paused rather than under way, and the spinner says which.
        if (BUSY.has(state) && !runUnderway) {
            runUnderway = true;
            showSpinner();
        } else if (!BUSY.has(state) && runUnderway) {
            runUnderway = false;
            hideSpinner();
        }

        // The no-output verdict, decided once the run is over: every terminal
        // state is covered however the run ended - a run that never compiled
        // (`failed`, `busy`, `error`) reaches no final onOutput at all, and a
        // run the reader stopped keeps its own message rather than being
        // declared output-less.
        const terminal = state === 'done' || state === 'failed' || state === 'busy' || state === 'error';

        if (terminal && !runShowedOutput && !inFlight?.stopped) {
            outputPane.innerHTML = '<span class="empty">The program produced no output.</span>';
        }

        // How the run ended, one event per run. A run the reader stopped keeps
        // that as its outcome whatever it goes on to do once its input has been
        // ended. `unauthorized` is not an outcome: it is a prompt, and the run
        // either carries on with a token or ends with the reader's answer, so
        // counting it would mean counting a run that has not finished.
        if (state === 'done') {
            countOutcome(inFlight?.stopped ? 'stopped' : detail?.threw ? 'threw' : 'compiled-ok');
        }

        if (state === 'failed') {
            countOutcome(detail?.timedOut ? 'timeout' : detail?.tooBig ? 'too-big' : 'compile-error');
        }

        if (state === 'busy') countOutcome('busy');
        if (state === 'error') countOutcome('error');
    },

    onAnalyser: state => {
        const [label, tooltip] = ANALYSER_STATE[state] ?? ANALYSER_STATE.disconnected;

        analyser.dataset.state = state;
        analyser.title = tooltip;
        analyserText.textContent = label;
    }
});

// The source as the program gave it, so a swap can tell a reader who has
// changed something from one who has only read it. Reset by every load, and by
// opening a file, because each of those is the buffer becoming a new thing.
let loadedSource = playground.getSource();

// The client already retries on its own, backing off to a minute between
// attempts. This is for the reader who does not want to wait out the backoff,
// and it is why the indicator is a button rather than a label.
analyser.addEventListener('click', () => {
    if (analyser.dataset.state !== 'ready') playground.reconnectAnalyser();
});

// A reader coming back to the tab expects the analyser to be there when they
// click into the editor, not only after their first edit. Waking is a no-op
// unless the session was reaped for idleness, and every trigger here is a
// deliberate act in the editor - focus, click, cursor movement - so an idle
// window generates none of them and can never hold a slot.
playground.editor.onDidFocusEditorText(() => playground.wakeAnalyser());
playground.editor.onDidChangeCursorPosition(() => playground.wakeAnalyser());

// Chrome and editor have to move together, or one of them looks broken.
darkMode.addEventListener('change', () => playground.setTheme(isDark() ? 'vs-dark' : 'vs'));

// The framing page's theme, asked for once this page can hear the answer and
// sent again whenever its switch moves.
if (panel) {
    window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.data?.ghul !== 'theme') return;

        document.documentElement.dataset.theme = event.data.dark ? 'dark' : 'light';
        playground.setTheme(isDark() ? 'vs-dark' : 'vs');
    });

    window.parent.postMessage({ ghul: 'theme?' }, location.origin);
}

status.textContent = 'compiler';
compiler.dataset.state = 'ready';
compiler.title = COMPILER_TITLE.ready;
runButton.disabled = false;

// Said where the program's output would appear, since that is where a reader
// who pressed run would look for why nothing happened.
const notice = program?.error
    ?? (program?.unsupported && `This program does not run in the playground: ${program.unsupported}`);

if (notice) {
    outputPane.replaceChildren(Object.assign(document.createElement('span'),
        { className: 'notice', textContent: notice }));
    showTab(outputPane);
}

// A task that names the arguments it is run with shows them, so a reader sees
// what it is being given and can change it. Without this the page would run
// such a task with nothing and show it doing nothing much, which is what it
// did before there was a field.
if (program?.arguments?.length) showArguments(program.arguments);

// Ask up front rather than letting the analyser fail quietly and the first run
// come back rejected - but only where the services actually want a token.
if (await playground.tokenRequired() && !playground.hasToken()) {
    await playground.askForToken();
}

// The task index, which the identity and the suggestions both read. Fetched
// lazily and only once a program has run, so a reader who never runs one never
// pays for it, and a fetch that fails leaves every use of it showing nothing.
let taskIndex = null;

// The index describes Rosetta Code tasks, so only a program opened from that
// collection reads it: another collection's names mean nothing in it.
const isRosettaTask = () => provenance?.name.startsWith('rosetta-code/') ?? false;

async function withTaskIndex() {
    if (taskIndex) return taskIndex;

    taskIndex = await loadIndex();

    if (taskIndex) renderProgram();

    return taskIndex;
}

// How far along the showcase and the equally-related tasks the strip is. Moved
// by every swap, so a reader working through several tasks is offered
// different ones rather than the same three each time.
let turn = 0;

// The task and the part a program's name refers to: <collection>/<slug>, or
// <collection>/<slug>/<NN-part> where a task is solved more than one way. The
// part's id is the index's own spelling of it.
function taskAndPart(name) {
    const [, slug, part] = /^[^/]+\/([^/]+)(?:\/(.+))?$/.exec(name ?? '') ?? [];

    return { slug, id: part ? `${slug}/${part}` : slug };
}

function link(text, href, counted, title = null) {
    const a = Object.assign(document.createElement('a'),
        { textContent: text, href, target: '_blank', rel: 'noopener' });

    if (title) a.title = title;
    if (counted) a.addEventListener('click', () => count('nav', counted));

    return a;
}

// A link that opens another program here rather than navigating to it.
function swapLink(name, counted, { text, title = null } = {}) {
    const a = Object.assign(document.createElement('a'),
        { href: new URL(name, document.baseURI).toString() });

    a.append(...text);

    if (title) a.title = title;

    a.addEventListener('click', event => {
        // A modified click is the reader asking for another tab, which the href
        // answers by itself.
        if (event.defaultPrevented || event.metaKey || event.ctrlKey
            || event.shiftKey || event.altKey || event.button !== 0) return;

        event.preventDefault();

        swapTo(name, { counted });
    });

    return a;
}

const muted = text =>
    Object.assign(document.createElement('span'), { className: 'separator', textContent: text });

// Which task the pane is showing, at the end of the tab row: the title, and for
// a task solved more than one way which part it is and the way to the next.
// Rebuilt rather than appended to, because a swap replaces the whole of it.
function renderIdentity() {
    taskIdentity.replaceChildren();

    // Keyed on provenance rather than on what was loaded: once the buffer has
    // been replaced it is no longer that task, and nothing here describes it.
    if (panel || !provenance || !program?.source) return;

    const title = program.title ?? provenance.name;

    taskIdentity.append(provenance.page ? link(title, provenance.page) : title);

    if (!isRosettaTask()) return;

    const { slug, id } = taskAndPart(provenance.name);

    const parts = taskFor(taskIndex, slug)?.parts ?? [];
    const at = parts.findIndex(part => part.id === id);

    // A task solved more than one way carries its own navigation, because the
    // parts are one task shown several ways and a reader who has run one is
    // the reader most likely to want the next.
    if (parts.length > 1 && at >= 0) {
        taskIdentity.append(muted(` · part ${at + 1} of ${parts.length} · `));

        const collection = provenance.name.split('/')[0];
        const heading = part => Object.assign(document.createElement('span'),
            { className: 'heading', textContent: `: ${part.heading ?? 'the part'}` });

        const previous = parts[at - 1];
        const next = parts[at + 1];

        if (previous) {
            taskIdentity.append(swapLink(`${collection}/${previous.id}`,
                { family: 'nav', detail: 'part-previous' },
                { text: ['← previous', heading(previous)] }));
        }

        if (previous && next) taskIdentity.append(muted(' · '));

        if (next) {
            taskIdentity.append(swapLink(`${collection}/${next.id}`,
                { family: 'nav', detail: 'part-next' },
                { text: ['next', heading(next), ' →'] }));
        }
    }

    if (isAheadOfWiki(taskIndex, slug)) {
        taskIdentity.append(muted(' · The solution here is newer than the one on Rosetta Code.'));
    }
}

// Three other tasks, under the output the reader has just watched appear, and
// the two links out beside them. The index arrives after the first run, so this
// is empty until then and the row stays hidden; an index that never arrives
// leaves it hidden for good, which is the same page as before it existed.
function renderMoreToRun() {
    suggestions.replaceChildren();
    moreLinks.replaceChildren();

    if (panel || !taskIndex || !isRosettaTask()) return;

    const { slug } = taskAndPart(provenance.name);
    const collection = provenance.name.split('/')[0];

    suggest(taskIndex, slug, turn).forEach((task, position) => {
        if (position) suggestions.append(muted(' · '));

        // A suggestion opens the task's first part, which is the one a reader
        // should meet first - the later numbers add to it.
        const name = `${collection}/${task.parts?.[0]?.id ?? task.slug}`;

        suggestions.append(swapLink(name,
            { family: 'nav', detail: `more-${task.kind}-${position + 1}` },
            { text: [task.title], title: task.reason ?? undefined }));
    });

    if (!suggestions.hasChildNodes()) return;

    // The count is the index's, so this says "all solutions" until it has
    // arrived rather than showing a number that might be wrong.
    moreLinks.append(
        link(taskIndex ? `all ${taskIndex.tasks.length} solutions` : 'all solutions',
            'https://ghul.dev/rosetta', 'browse-all'),
        muted(' · '),
        link('what is ghūl?', 'https://ghul.dev/', 'what-is-ghul'));
}

// Both surfaces read the same two things - which program this is, and the index
// - so they are rendered together and a swap has one call to make.
function renderProgram() {
    renderIdentity();
    renderMoreToRun();
    showTaskLabels();
}

// Open another program in this tab: the runtime is already warm, so this is a
// swap rather than a page load. The URL still becomes the program's own, and
// pushState rather than replaceState because it genuinely is a navigation -
// Back returns to the task the reader came from.
async function swapTo(name, { counted = null, push = true } = {}) {
    if (playground.getSource() !== loadedSource
        && !confirm('Open another task? The changes you have made here are discarded.')) return;

    const next = requestedProgram(`/${name}`);

    if (!next) return;

    const loaded = await loadProgram(next).catch(e => ({ error: e.message }));

    // Nothing is swapped when the program will not load: the reader keeps what
    // they had, and the reason goes where its output would have been.
    if (!loaded.source) {
        outputPane.replaceChildren(Object.assign(document.createElement('span'),
            { className: 'notice', textContent: loaded.error ?? `could not load ${name}` }));
        showTab(outputPane);
        return;
    }

    if (counted) count(counted.family, counted.detail);

    if (push) history.pushState(null, '', new URL(name, document.baseURI).toString());

    requested = next;
    program = loaded;
    turn += 1;

    document.title = `${next.name} - ghūl playground`;
    provenance = next;

    playground.setFiles(loaded.files);

    // Recorded before the buffer is written, because writing it runs the
    // change handler, which has to be able to tell this from an edit.
    loadedSource = loaded.source;

    playground.setSource(loaded.source);

    renderProgram();

    // A pageview as a page load would have counted, so a reader's journey
    // through several tasks reads as the pages they would have been.
    countPageview(new URL(name, document.baseURI).pathname);

    // The same promise a link makes: the reader asked to see this task run.
    if (!loaded.unsupported) runProgram({ automatic: true });
    else {
        outputPane.replaceChildren(Object.assign(document.createElement('span'),
            { className: 'notice',
              textContent: `This program does not run in the playground: ${loaded.unsupported}` }));
        showTab(outputPane);
    }
}

// Back and Forward move between the programs the reader has opened here, which
// is what pushState promised. The entry is already in history, so this re-opens
// without pushing another.
window.addEventListener('popstate', () => {
    const wanted = requestedProgram(pathBelowBase());

    if (wanted && wanted.name !== requested?.name) swapTo(wanted.name, { push: false });
});

renderProgram();

const isRunning = () => runButton.hasAttribute('data-stop');

// Counted as an event, so the stats can say how often a program is run and
// whether the reader asked for it or arrived at a link that ran it for them.
// The counter loads asynchronously and may not be there yet for a run on
// arrival, so that one waits for it rather than going uncounted.
// The run in flight: when it started, whether the reader stopped it, and
// whether its outcome has been counted. One outcome event per run, so a run the
// reader stopped is counted as stopped rather than as whatever it went on to do
// once its input was ended.
let inFlight = null;

// The wait a reader actually experiences the first time, which is the one that
// includes fetching and starting the runtime. Once per page load: every later
// run has it in the browser's cache and would flatter the number.
let firstOutputCounted = false;

function countFirstOutput() {
    // The first output is also when the suggestions become relevant, so it is
    // where the index is asked for: after a run rather than before one.
    if (isRosettaTask()) withTaskIndex();

    if (firstOutputCounted || !inFlight) return;

    firstOutputCounted = true;

    count('first-output', band(performance.now() - inFlight.at));
}

function countOutcome(outcome) {
    if (!inFlight || inFlight.counted) return;

    inFlight.counted = true;

    count('result', outcome);
}

// The command line the program is run with. Read from the field on every run
// rather than held, because the reader can have changed it since the last one,
// and never recorded anywhere: what somebody types is theirs.
const programArguments = () =>
    argumentsRow.hidden ? [] : parseArguments(argumentsInput.value);

// Shown for a task that carries arguments of its own, and otherwise only when
// the reader asks. A program that takes none looks exactly as it did.
function showArguments(args = null) {
    if (args) argumentsInput.value = renderArguments(args);

    argumentsRow.hidden = false;
}

// That the field was used at all, once per page load. What is in it is never
// recorded: an argument is something a reader typed, which no event carries.
let argumentsCounted = false;

function countArguments() {
    if (argumentsCounted) return;

    argumentsCounted = true;

    count('action', 'arguments');
}

// Enter in the field runs the program, which is what a reader who has just
// changed an argument means by it. Without this the form would reload the page.
argumentsRow.addEventListener('submit', event => {
    event.preventDefault();

    if (!isRunning()) runProgram();
});

argumentsInput.addEventListener('input', countArguments);

function runProgram({ automatic = false } = {}) {
    inFlight = { at: performance.now(), stopped: false, counted: false };
    runShowedOutput = false;

    count('run', `${automatic ? 'automatic' : 'manual'}/${provenance?.name ?? 'editor'}`);

    playground.run(programArguments());
}

runButton.addEventListener('click', () => {
    if (!isRunning()) {
        runProgram();
        return;
    }

    // Ending the input is enough for a program that is waiting for a line, and
    // leaves its transcript on screen. Nothing else can interrupt managed code
    // on another thread, so for a program that is busy the only way to stop it
    // is to take the runtime away, which means reloading - and the page comes
    // back with nothing running, which is the state that was asked for. The
    // editor's content is saved as it is typed, so that much survives.
    if (inFlight) inFlight.stopped = true;

    if (playground.stop()) return;

    // Counted here because the reload means no status will ever arrive to
    // count it from. The request races the reload and can be lost, which is
    // the better failure: a count that sometimes goes missing rather than a
    // run that is always uncounted.
    countOutcome('stopped');

    // The page comes back to the same address, and a program named by the
    // address runs on arrival - which would start again what was just stopped.
    // The reload is told apart from an arrival by a note left for it.
    try { sessionStorage.setItem(STOPPED_KEY, '1'); } catch {}

    location.reload();
});

// Enter sends the line. The box is cleared rather than left holding it,
// because what was typed reappears in the output a moment later - the program
// echoes it there, where it belongs in the transcript.
inputRow.addEventListener('submit', event => {
    event.preventDefault();

    const line = stdin.value;

    stdin.value = '';
    inputRow.hidden = true;

    playground.sendInput(line);
});

// A program reading until its input runs out is waiting for this rather than
// for another line, and nothing else on the page can say it.
stdin.addEventListener('keydown', event => {
    if (event.key !== 'd' || !event.ctrlKey) return;

    event.preventDefault();

    stdin.value = '';
    inputRow.hidden = true;

    playground.endInput();
});

playground.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { if (!isRunning()) runProgram(); });

// A link to a program is a request to see it run, so it runs on arrival -
// unless it cannot run here, which the notice above already says, or a token
// is wanted and the reader has not given one, or this is the reload that
// stopping it made, which is a request to see it not run.
const stoppedBefore = (() => {
    try {
        const stopped = sessionStorage.getItem(STOPPED_KEY) !== null;

        sessionStorage.removeItem(STOPPED_KEY);

        return stopped;
    } catch {
        return false;
    }
})();

if (stoppedBefore) {
    outputPane.replaceChildren(Object.assign(document.createElement('span'),
        { className: 'empty', textContent: 'Stopped. Run the program to start it again.' }));
    showTab(outputPane);
} else if (program?.source && !notice && (playground.hasToken() || !(await playground.tokenRequired()))) {
    // Waited for rather than started here: the run is what a visitor costs,
    // and a page rendered by a crawler that never touches it should cost
    // nothing beyond the page itself. A reader gets it as soon as they do
    // anything, and shortly after arriving if they do not.
    whenReader().then(() => runProgram({ automatic: true }));
}

// --- saving and copying ----------------------------------------------------

let saveDebounce = null;
let sourceLength = playground.getSource().length;

playground.editor.onDidChangeModelContent(event => {
    const source = playground.getSource();

    // One edit spanning the whole buffer is a paste over it or a select-all
    // delete, and either way what is there now did not come from the program
    // the page loaded. Deleting it in pieces reaches the same place, hence the
    // second test. Opening a file needs no case of its own: replacing the
    // source is exactly the edit this describes.
    //
    // Undoing such an edit does not bring the path back. Following the link
    // again does, and tracking it through the undo stack would cost more than
    // it is worth.
    const replaced = !event.isEolChange
        && event.changes.length === 1
        && event.changes[0].rangeOffset === 0
        && event.changes[0].rangeLength >= sourceLength;

    sourceLength = source.length;

    // Replacing the whole buffer with the program that was just loaded is how a
    // swap delivers it, not a reader throwing the program away - and giving up
    // the path here would undo the provenance the swap has just set.
    if (source !== loadedSource && (replaced || !source.trim())) forgetProvenance();

    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, source); } catch { }
    }, 500);
});

const copyButton = document.getElementById('copy');

copyButton.addEventListener('click', () => {
    count('action', 'copy');

    navigator.clipboard?.writeText(playground.getSource()).then(() => {
        copyButton.dataset.copied = '';
        setTimeout(() => delete copyButton.dataset.copied, 1500);
    });
});

// --- the file menu ---------------------------------------------------------

const fileToggle = document.getElementById('file-toggle');
const fileMenu = document.getElementById('file-menu');
const fileNote = document.getElementById('file-note');
const saveItem = document.getElementById('file-save');
const saveLabel = document.getElementById('file-save-label');

function closeMenu() {
    fileMenu.hidden = true;
    fileToggle.setAttribute('aria-expanded', 'false');
}

// What Save would do is not fixed: it writes back to a file once one has been
// opened, and before that it has to ask. The menu is told each time it opens
// rather than kept in step, so it is right after a reload as well.
async function openMenu() {
    fileMenu.hidden = false;
    fileToggle.setAttribute('aria-expanded', 'true');

    if (!files.canWriteFiles) {
        saveLabel.textContent = 'Save a copy';
        fileNote.textContent =
            'This browser cannot write back to a file it opened, so saving downloads a copy.';
        return;
    }

    const target = await files.savesTo();

    saveLabel.textContent = target ? `Save to ${target}` : 'Save';
    fileNote.textContent = '';
}

fileToggle.addEventListener('click', () => {
    if (fileMenu.hidden) openMenu(); else closeMenu();
});

// Anywhere outside it, including the editor, which does not bubble a click the
// way an ordinary element does.
document.addEventListener('pointerdown', event => {
    if (!fileMenu.hidden && !event.target.closest('.menu')) closeMenu();
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !fileMenu.hidden) closeMenu();
});

// The same acknowledgement the copy button gives: the act is over in a moment
// and there is nothing to keep saying about it. The document title carries the
// lasting half, which is which file this now is.
let acknowledgement = null;

function acknowledge(name) {
    currentName = name;
    document.title = `${name} - ghūl playground`;

    fileToggle.dataset.done = '';
    clearTimeout(acknowledgement);
    acknowledgement = setTimeout(() => delete fileToggle.dataset.done, 1500);
}

async function openFile() {
    closeMenu();

    const file = await files.open();

    if (!file) return;

    playground.setSource(file.text);
    acknowledge(file.name);
}

async function saveFile() {
    closeMenu();

    const name = await files.save(playground.getSource());

    if (name) {
        acknowledge(name);
        return;
    }

    // Nothing to write back to, so Save means Save as the first time.
    await saveFileAs();
}

async function saveFileAs() {
    closeMenu();

    const offered = files.defaultName({ current: currentName, requested: provenance });
    const name = await files.saveAs(playground.getSource(), offered);

    if (!name) return;

    // Keeping the name it was offered says this is still that program, so the
    // path stays. Choosing another one says it is theirs now.
    if (name !== offered) forgetProvenance();

    acknowledge(name);
}

// Counted at the click rather than on success: a reader who asked and was then
// stopped by the browser's own dialogue still asked, and whether the two differ
// is worth being able to see.
document.getElementById('file-open').addEventListener('click', () => {
    count('action', 'open-file');
    openFile();
});

saveItem.addEventListener('click', () => {
    count('action', 'save-file');
    saveFile();
});

document.getElementById('file-save-as').addEventListener('click', () => {
    count('action', 'save-file-as');
    saveFileAs();
});

document.getElementById('file-arguments').addEventListener('click', () => {
    closeMenu();
    countArguments();
    showArguments();
    argumentsInput.focus();
});

// Taken off the browser, which would otherwise save or open the page. Monaco
// binds neither chord, so an event from inside the editor reaches here too and
// a second registration with the editor would run these twice.
document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

    const key = event.key.toLowerCase();

    if (key !== 's' && key !== 'o') return;

    event.preventDefault();

    if (key === 's') saveFile(); else openFile();
});

// The help mentions the REPL only when the back end serves sessions.
replOffered().then(offered => {
    if (!offered) return;

    document.getElementById('help-repl-link').href = replPageUrl();
    document.getElementById('help-repl').hidden = false;
});
