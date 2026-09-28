// The playground page works out the directory it is served from, so the same
// build runs at the root of its own host and under /playground/ on ghul.dev.
// This runs index.html's own base script against the paths it has to handle,
// and checks its list of collections is collections.js's.
//
//   node test/base-path.mjs

import { readFileSync } from 'fs';
import { COLLECTION_NAMES, pathBelowBase, requestedProgram } from '../web/wwwroot/collections.js';

let failures = 0;

const check = (what, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
};

const html = readFileSync(new URL('../web/wwwroot/index.html', import.meta.url), 'utf8');
const script = /<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/.exec(html)?.[1];

check('index.html has a base script', typeof script, 'string');

// The base the script sets for a page served at `pathname`.
function baseFor(pathname) {
    let base = null;

    const document = {
        createElement: () => ({}),
        head: { appendChild: element => { base = element.href; } }
    };

    new Function('location', 'document', script)({ pathname }, document);

    return base;
}

const listed = JSON.parse(/var collections = (\[[^\]]*\])/.exec(script)[1].replaceAll("'", '"'));

check('the base script lists the collections collections.js has', listed, COLLECTION_NAMES);

check('the root of its own host', baseFor('/'), '/');
check('index.html by name', baseFor('/index.html'), '/');
check('a program by path', baseFor('/rosetta-code/100-doors'), '/');
check('a program with a part', baseFor('/rosetta-code/fizzbuzz/02-pipes'), '/');
check('under ghul.dev', baseFor('/playground/'), '/playground/');
check('a program by path under ghul.dev', baseFor('/playground/rosetta-code/100-doors'), '/playground/');
check('a program with a part under ghul.dev', baseFor('/playground/rosetta-code/fizzbuzz/02-pipes'), '/playground/');
check('an example under ghul.dev', baseFor('/playground/ghul-examples/functional/02-map-filter-reduce'), '/playground/');

check('a program path below the root', pathBelowBase('/rosetta-code/100-doors', '/'), '/rosetta-code/100-doors');
check('a program path below /playground/', pathBelowBase('/playground/rosetta-code/100-doors', '/playground/'), '/rosetta-code/100-doors');
check('the base itself', pathBelowBase('/playground/', '/playground/'), '/');

// Where an example's source is read from, and the ghul.dev page it links back to.
const whole = requestedProgram('/ghul-examples/generics');
const first = requestedProgram('/ghul-examples/functional/01-first-class-functions');
const later = requestedProgram('/ghul-examples/functional/02-map-filter-reduce');

check("a whole example's source", whole.source.endsWith('/examples/generics/generics.ghul'), true);
check("a whole example's page", whole.page, 'https://ghul.dev/examples/generics');
check("a topic's first program is on the topic's page", first.page, 'https://ghul.dev/examples/functional');
check("a later program's source", later.source.endsWith('/examples/functional/02-map-filter-reduce/02-map-filter-reduce.ghul'), true);
check("a later program's page", later.page, 'https://ghul.dev/examples/functional-02-map-filter-reduce');
check("a whole example's title", whole.title, 'generics');
check("a later program's title", later.title, 'functional: map filter reduce');
check('a name that is not an example', requestedProgram('/ghul-examples/Not An Example').error, 'ghul-examples/Not An Example is not the name of a program');

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
