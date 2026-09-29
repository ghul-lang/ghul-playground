// A page that sends events has to load the counter, or the events go nowhere.
//
// This is here because that is exactly what happened: repl.js raised every one
// of its events correctly and repl.html carried no counter, so the REPL was
// invisible for as long as it had been up, and nothing said so. Neither the
// page nor the helper can tell - an event with nowhere to go looks the same as
// a page nobody visited - so the check has to be made against the markup.
//
// It reads the sources rather than a published site, so it needs no browser,
// no services and no build, and it covers pages the browser test never opens.
//
//   node test/counted-pages.mjs

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

const wwwroot = new URL('../web/wwwroot/', import.meta.url);

let failures = 0;

const check = (what, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

const read = name => readFileSync(new URL(name, wwwroot), 'utf8');

// The publish fingerprints a page's own module, so the name in the markup
// carries a placeholder the file on disk does not.
const unfingerprinted = src => src.replace(/#\[\.\{fingerprint\}\]/, '');

// Every module a page reaches, following relative imports from the one its
// markup names. Only relative specifiers are followed: anything else is not a
// file of ours.
function modulesReachedBy(entry) {
    const seen = new Set();
    const queue = [entry];

    while (queue.length) {
        const name = queue.shift();

        if (seen.has(name)) continue;
        seen.add(name);

        let source;

        try {
            source = read(name);
        } catch {
            // A module the markup names and the tree does not have is the
            // build's problem to report, not this check's.
            continue;
        }

        for (const [, specifier] of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]/g)) {
            queue.push(specifier.replace(/^\.\//, ''));
        }
    }

    return seen;
}

// embed.html loads on every example edit on ghul.dev, where the edit is already
// counted by the example's own event with the example's name attached, and the
// view by the page around it. It carries the counter for its own failures,
// which nothing around it can see, and must send no pageview: counting the
// frame as a view would count one act twice and say less about it than the
// event it duplicated.
const NO_PAGEVIEW = ['embed.html'];

const pages = readdirSync(fileURLToPath(wwwroot)).filter(name => name.endsWith('.html')).sort();

check('there are pages to check', pages.length > 0, `${pages.length} found`);

for (const page of pages) {
    const markup = read(page);
    const entry = /<script[^>]*type=['"]module['"][^>]*src=['"]([^'"]+)['"]/.exec(markup)?.[1];

    // A page with no module of its own runs no code of ours and sends nothing.
    if (!entry) continue;

    const sends = modulesReachedBy(unfingerprinted(entry)).has('events.js');
    const counts = /id=['"]goatcounter['"]/.test(markup);

    if (NO_PAGEVIEW.includes(page)) {
        check(`${page} sends no pageview`, /no_onload:\s*true/.test(markup.slice(0, markup.search(/id=['"]goatcounter['"]/))),
            'the counter is not told no_onload before it loads, so the frame counts as a view');
    }

    if (!sends) {
        check(`${page} sends no events`, true);
        continue;
    }

    check(`${page} sends events and loads the counter`, counts,
        'no element with id="goatcounter", so every event it sends goes nowhere');
}

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
