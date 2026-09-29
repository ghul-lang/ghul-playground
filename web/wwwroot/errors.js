// Counting the failures the server can never see: a runtime that will not
// load, a script error, a promise rejected with nobody to handle it, a worker
// that dies. Each is counted as its class alone - never the message, the stack
// or the URL, which can carry what a reader typed - and at most once per page
// load, since one fault usually throws more than once.
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

function found(kind) {
    if (!sink || !ERROR_CLASSES.includes(kind) || seen.has(kind)) return;

    seen.add(kind);
    sink(kind);
}

window.addEventListener('error', () => found('script'));
window.addEventListener('unhandledrejection', () => found('unhandled-rejection'));

// A worker that throws or fails to load reports it on its own object, never on
// the window, so the constructor is the only place it can be heard from.
if (window.Worker) {
    const Native = window.Worker;

    window.Worker = class extends Native {
        constructor(...args) {
            super(...args);

            this.addEventListener('error', () => found('worker'));
        }
    };
}

// Counts each class once, as `{family}/{class}`, through events.js's
// countEvent.
export function countErrors(family, countEvent) {
    sink = kind => countEvent(`${family}/${kind}`, family);
}

// For a frame that counts nothing itself: each class is handed to `send`, for
// the page holding the frame to count.
export function forwardErrors(send) {
    sink = send;
}

// A failure found by the page's own code rather than by a listener.
export function reportError(kind) {
    found(kind);
}
