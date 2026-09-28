// When the page has a reader, rather than a renderer.
//
// A crawler loads the page, renders it, and leaves. It never moves a pointer,
// presses a key or scrolls, which is the one thing that separates it from
// somebody reading: the analyser session and the automatic run are what a
// visitor costs us, and both are worth nothing to a visitor who will never see
// the output.
//
// So the work waits for the page to be looked at and for the reader to do
// something. A reader who does nothing still gets it, after a delay: the run
// is most of what the page is for, and making somebody click to start it would
// be a worse page for everybody to save the cost of a few renders. The delay is
// the compromise, and it is deliberately short - long enough to outlast the
// renders that leave immediately, short enough that the run still feels like
// the page's own.
//
// Automation says so, and is taken at its word: `navigator.webdriver` is set by
// every driver that admits to being one, and a crawler that lies about it is
// what the per-address limits and robots.txt are for.

const DELAY_MS = 2000;

const SIGNALS = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'];

let engaged = false;

const listeners = [];

// Nothing to wait for where there is no page: the module is loaded by tests
// and by tooling that has no document, and both want the work to happen.
const automated =
    typeof navigator != 'undefined' && navigator.webdriver === true;

function settle() {
    if (engaged) return;

    engaged = true;

    for (const signal of SIGNALS) {
        document.removeEventListener(signal, settle, true);
    }

    document.removeEventListener('visibilitychange', onVisibility);

    while (listeners.length) listeners.shift()();
}

let timer = null;

function onVisibility() {
    if (document.hidden) {
        clearTimeout(timer);
        timer = null;
        return;
    }

    startDelay();
}

function startDelay() {
    if (engaged || timer !== null) return;

    timer = setTimeout(settle, DELAY_MS);
}

if (typeof document == 'undefined') {
    engaged = true;
} else if (!automated) {
    for (const signal of SIGNALS) {
        document.addEventListener(signal, settle, true);
    }

    document.addEventListener('visibilitychange', onVisibility);

    // A page opened in a background tab waits: the delay is for a reader who
    // is looking at it and has not touched it yet, not for one who has not
    // arrived.
    if (!document.hidden) startDelay();
}

// Whether the page has a reader, answered now. For a caller that has to decide
// on the spot, such as whether to open a connection it was asked for.
export function hasReader() {
    return engaged;
}

// Resolves when the page has a reader. Never resolves under automation, which
// is what makes the caller's work not happen at all rather than happen late.
export function whenReader() {
    if (engaged) return Promise.resolve();

    return new Promise(resolve => listeners.push(resolve));
}
