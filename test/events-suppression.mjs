// Whether an automated browser is counted.
//
// `navigator.webdriver` is set in a browser that is being driven rather than
// used, and never in one a person is sitting at. When it is set, events.js
// counts nothing: no event, no pageview, no time on page. The counters'
// pageviews are the markup's business (test/counted-pages.mjs); this is the
// helper's.
//
//   node test/events-suppression.mjs

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
}

// The decision is read once when the module loads, so each browser is a fresh
// import behind its own globals. The query string is what stops the second
// import from being the first module again.
async function load(webdriver) {
    const sent = [];

    // Node defines `navigator` of its own, so the stub replaces it rather
    // than assigning over it.
    Object.defineProperty(globalThis, 'navigator', { value: { webdriver }, configurable: true });
    globalThis.location = { search: '' };
    globalThis.localStorage = { getItem: () => null };
    globalThis.document = {
        visibilityState: 'visible',
        getElementById: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
    };
    globalThis.window = { goatcounter: { count: entry => sent.push(entry) }, addEventListener: () => {} };

    const events = await import(`../web/wwwroot/events.js?webdriver=${webdriver}`);

    events.countEvent('mini-ide-open/test', 'test opened');
    events.countPageview('editor');
    events.countTimeOnPage('mini-ide-time');

    return sent;
}

const automated = await load(true);
check('an automated browser sends no event', automated.length === 0, `${automated.length} sent`);

const reader = await load(false);
check('a reader\'s event is counted', reader.length === 2, `${reader.length} sent`);
check('a reader\'s pageview is counted', reader.some(entry => entry.path === 'editor'));

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
