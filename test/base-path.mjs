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
        querySelector: () => ({ setAttribute: (name, value) => { if (name === 'href') base = value; } })
    };

    new Function('location', 'document', script)({ pathname }, document);

    return base;
}

// The base written in the page, before any script runs, is ghul.dev's, and it
// comes ahead of everything that resolves against it: the browser's preload
// scanner reads ahead of the script and fetches those files from wherever the
// written base says.
const head = html.slice(0, html.indexOf('</head>'));
const written = /<base href="([^"]*)">/.exec(head);

check('the page writes the base ghul.dev serves it from', written?.[1], '/playground/');
check('ahead of the first file it names',
    written !== null && written.index < head.search(/(?:href|src)="(?!\/|https?:)/), true);

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

// A task whose slug has a letter outside ASCII: the browser hands the path
// over percent-encoded, and the corpus's directory name is what the source,
// the task.json and the ghul.dev page links are built from.
const erdos = requestedProgram('/rosetta-code/erd%C5%91s-woods-numbers');

check('a percent-encoded slug names the task', erdos.name, 'rosetta-code/erdős-woods-numbers');
check("a percent-encoded slug reads the task's source", erdos.source,
    'https://raw.githubusercontent.com/ghul-lang/ghul-rosetta-code/main/tasks/erdős-woods-numbers/erdős-woods-numbers.ghul');
check("a percent-encoded slug reads the task's task.json", erdos.about,
    'https://raw.githubusercontent.com/ghul-lang/ghul-rosetta-code/main/tasks/erdős-woods-numbers/task.json');
check("a percent-encoded slug links to the task's page", erdos.page, 'https://ghul.dev/rosetta/erdős-woods-numbers');

// A name a suggestion carries has already been decoded, and reads as itself.
check('a decoded slug reads the same task',
    requestedProgram('/rosetta-code/erdős-woods-numbers').source, erdos.source);

// So does the same name spelled with a combining mark, as another writer of
// the address could have handed it over.
check('a combining-mark spelling reads the same task',
    requestedProgram('/rosetta-code/erdo%CC%8Bs-woods-numbers').source, erdos.source);

// A % that opens no escape is refused where the output is shown, not thrown
// while the page loads.
check('a stray % is refused, not thrown',
    requestedProgram('/rosetta-code/100%').error, 'rosetta-code/100% is not the name of a program');

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
