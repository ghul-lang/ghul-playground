// Counting what a reader does, for the pages that do any counting at all.
//
// One event is one path, because the counter has no properties: everything an
// event says has to be in its path, and the first segment is the family the
// report groups on. Paths stay low-cardinality on purpose - a family and a
// small closed set of outcomes - and nothing a reader typed, no source text and
// no message from the compiler ever reaches one.
//
// Counting is never allowed to matter. Every call is safe when the counter is
// absent, when the reader has opted out, when storage throws, and when it is
// called before count.js has loaded.

// The counter is loaded with `async`, so the first events of a page load land
// before it exists. They wait here rather than going uncounted, which is what
// the run-on-arrival event needed when it was the only one.
const queued = [];

let listening = false;

// Three ways to not be counted. Two are the reader's rather than ours.
//
// `skipgc` is GoatCounter's own opt-out, set by visiting #toggle-goatcounter,
// and count.js honours it by itself - this is only so that nothing is queued
// for a counter that will discard it.
//
// `?notrack` on the URL is for the end-to-end tests, which drive a real browser
// against the real site and would otherwise count themselves. It is a page-load
// decision, so it is read once.
//
// An automated browser is not a reader: `navigator.webdriver` is set in a
// browser that is being driven rather than used, and never in one a person is
// sitting at, so what it does is not counted at all. A driver that clears the
// flag gets around this, as it gets around every such check; this only keeps
// the default headless browsers out of the figures.
const suppressed = (() => {
    if (typeof navigator !== 'undefined' && navigator.webdriver) return true;

    try {
        if (new URLSearchParams(location.search).has('notrack')) return true;
    } catch {
        // No location to read, which only happens somewhere this is not wanted.
        return true;
    }

    try {
        return localStorage.getItem('skipgc') === 't';
    } catch {
        // Storage can throw rather than answer, in a private window or with
        // site data blocked. Not being able to read the opt-out is not consent
        // to count, so it is read as opted out.
        return true;
    }
})();

function send(event) {
    try {
        window.goatcounter.count(event);
    } catch {
        // A counter that fails is not a reason for the page to.
    }
}

// GoatCounter counts a page's own view only once the page has been visible, so
// a page rendered where nobody sees it, as a crawler renders one, counts
// nothing. Everything this page counts follows the same rule: it waits until
// the page has first been visible, and is dropped if it never is.
let seen = typeof document === 'undefined' || !('visibilityState' in document) || document.visibilityState === 'visible';
const unseen = [];

if (!seen) {
    const shown = () => {
        if (document.visibilityState !== 'visible') return;

        document.removeEventListener('visibilitychange', shown);
        seen = true;

        while (unseen.length) record(unseen.shift());
    };

    document.addEventListener('visibilitychange', shown);
}

// One thing to count, sent now or once the counter has loaded.
function record(entry) {
    if (suppressed) return;

    if (!seen) {
        unseen.push(entry);
        return;
    }

    if (window.goatcounter?.count) {
        send(entry);
        return;
    }

    const script = document.getElementById('goatcounter');

    // A page that does not load the counter at all is a page that counts
    // nothing, so what it is given is dropped rather than queued. Queueing it
    // would wait for a load event that can never arrive, which is how a page
    // with no counter came to look as though it were sending events.
    if (!script) return;

    queued.push(entry);

    if (listening) return;

    listening = true;

    // The script is in the page's own markup, so if it is already loaded the
    // load event has been and gone - hence sending straight away above, and
    // waiting only when the function is genuinely not there yet.
    script.addEventListener('load', () => {
        while (queued.length) send(queued.shift());
    }, { once: true });
}

// Count one event. `path` is the whole of what is recorded; `title` is what the
// dashboard shows beside it and is free text.
export function countEvent(path, title) {
    record({ path, title, event: true });
}

// Count a pageview for a path the reader reached without loading a page: the
// playground opens another program where it stands, so the only record that
// they saw it is this one. A path that a page load would also have counted, so
// a journey through several programs reads as the pages it would have been.
export function countPageview(path) {
    record({ path });
}

// Something to count as the page is going away, which the counter's own script
// cannot carry: it sends an image request, and a browser tearing a page down
// abandons those. sendBeacon is the one request a browser promises to finish,
// and GoatCounter accepts a POST to its count endpoint for exactly this.
// A page that was never visible counts nothing, as for record; what it would
// have sent is dropped rather than held, since the page is going away.
function beacon(path, title) {
    if (suppressed || !seen || !navigator.sendBeacon) return;

    const endpoint = document.getElementById('goatcounter')?.dataset.goatcounter;

    if (!endpoint) return;

    try {
        const url = new URL(endpoint, location.href);

        url.searchParams.set('p', path);
        url.searchParams.set('e', 'true');

        if (title) url.searchParams.set('t', title);

        navigator.sendBeacon(url.toString());
    } catch {
        // A page on its way out is not a place to report anything.
    }
}

// How long the reader had the page in front of them, in bands, counted once.
//
// Time the page spent hidden does not count: a tab left open behind others for
// an hour says nothing about whether anyone read it. What that costs is a
// reader who leaves and comes back - the count is taken the first time the page
// goes away, so their second visit to it is not added. A band is coarse enough
// that this matters less than sending several would.
export function countTimeOnPage(family) {
    if (suppressed) return;

    let visibleSince = document.visibilityState === 'visible' ? performance.now() : null;
    let visible = 0;
    let counted = false;

    const stopped = () => {
        if (visibleSince !== null) {
            visible += performance.now() - visibleSince;
            visibleSince = null;
        }
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            visibleSince ??= performance.now();
            return;
        }

        stopped();
        send();
    });

    // Both, because neither fires everywhere: a tab being closed may only ever
    // report pagehide, and a phone switching away may only ever report the
    // other. The count happens once whichever arrives first.
    window.addEventListener('pagehide', () => { stopped(); send(); });

    function send() {
        if (counted) return;

        counted = true;

        beacon(`${family}/${timeBand(visible)}`, family);
    }
}

// The bands themselves. Coarse on purpose: a path is a name, and the question
// is whether somebody read the page rather than how many seconds they took.
export function timeBand(ms) {
    if (ms < 10000) return 'under-10s';
    if (ms < 30000) return '10-30s';
    if (ms < 120000) return '30s-2m';
    if (ms < 600000) return '2-10m';
    return 'over-10m';
}

// Which band a duration falls in. A bucket rather than the number, because a
// path is a name and thousands of distinct millisecond values would be a
// histogram nobody can read and a cardinality nobody wants.
export function band(ms) {
    if (ms < 1000) return 'under-1s';
    if (ms < 3000) return '1-3s';
    if (ms < 10000) return '3-10s';
    return 'over-10s';
}

// The same idea for a count of things done in one session.
export function countBand(n) {
    if (n <= 1) return '1';
    if (n <= 5) return '2-5';
    if (n <= 20) return '6-20';
    return 'over-20';
}
