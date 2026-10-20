// Counting the failures the server can never see: a runtime that will not
// load, a script error, a promise rejected with nobody to handle it, a worker
// that dies. Each is counted as its class - never the message, the stack or
// the URL, which can carry what a reader typed - and at most once per page
// load, since one fault usually throws more than once.
//
// A class alone says little about where to look, so it is followed by two
// short words that are never the reader's: the name of one of the page's own
// scripts when the failure came from one (`main.js`, `editor.worker.js`, or
// `blob` for the worker a run starts), and the phase the page was in (a status
// word such as `running`). Anything that is not plainly one of those is left
// out rather than recorded.
//
// Import this before anything that loads the runtime: the runtime starts its
// own workers, and the constructor it finds has to be the one below. It counts
// through the function a page hands it, so a frame that only forwards its
// failures never loads the counting at all.

export const ERROR_CLASSES = ['runtime-load', 'script', 'unhandled-rejection', 'worker'];

// Where a class goes once found, set by countErrors or forwardErrors. Until
// then nothing is recorded.
let sink = null;

const seen = new Set();

// What the page was doing, as one of its own status words.
let phase = '';

const WORD = /^[A-Za-z0-9._-]{1,40}$/;

export function setPhase(status) {
    const word = String(status ?? '').replace(/ /g, '-');

    phase = WORD.test(word) ? word.toLowerCase() : '';
}

// The file name of one of this page's own scripts, `blob` for a script made
// in the page, and nothing for anything else: a script from another origin, a
// name that is not a plain file name, or no name at all.
function sourceOf(url) {
    try {
        const parsed = new URL(url, location.href);

        if (parsed.protocol === 'blob:') return parsed.origin === location.origin ? 'blob' : '';
        if (parsed.origin !== location.origin) return '';

        const name = parsed.pathname.split('/').pop();

        return WORD.test(name) ? name : '';
    } catch {
        return '';
    }
}

// Words from a frame are checked again here: the page holding it counts them.
const DETAIL = /^[A-Za-z0-9._-]{1,40}(\/[A-Za-z0-9._-]{1,40})?$/;

function found(kind, source = '', detail = null) {
    if (!sink || !ERROR_CLASSES.includes(kind) || seen.has(kind)) return;

    seen.add(kind);

    let words = detail ?? [source, phase].filter(Boolean).join('/');

    if (words && !DETAIL.test(words)) words = '';

    sink(kind, words);
}

window.addEventListener('error', event => found('script', sourceOf(event.filename)));
window.addEventListener('unhandledrejection', () => found('unhandled-rejection'));

// A worker that throws or fails to load reports it on its own object, never on
// the window, so the constructor is the only place it can be heard from.
if (window.Worker) {
    const Native = window.Worker;

    window.Worker = class extends Native {
        constructor(...args) {
            super(...args);

            const source = sourceOf(String(args[0] ?? ''));

            this.addEventListener('error', () => found('worker', source));
        }
    };
}

// Counts each class once, as `{family}/{class}`, through events.js's
// countEvent.
export function countErrors(family, countEvent) {
    sink = (kind, words) => countEvent(`${family}/${kind}${words ? `/${words}` : ''}`, family);
}

// For a frame that counts nothing itself: each class and its words are handed
// to `send`, for the page holding the frame to count.
export function forwardErrors(send) {
    sink = send;
}

// A failure found by the page's own code rather than by a listener.
export function reportError(kind, detail = null) {
    found(kind, '', detail);
}
