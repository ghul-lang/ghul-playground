// Programs the playground opens by path rather than from the example menu.
//
// A path is /<collection>/<id>, and each collection says which ids it accepts
// and where the source for one lives. Keeping every collection under a prefix
// of its own is what lets another set of programs be added later without its
// ids colliding with these.
//
// Sources are fetched from the browser, so each location has to answer
// cross-origin requests. raw.githubusercontent.com does, and unlike the
// GitHub API it is not held to 60 requests an hour.

import { argumentsFromFile } from './arguments.js'

export const ROSETTA_CODE_ROOT = 'https://raw.githubusercontent.com/ghul-lang/ghul-rosetta-code/main/';
const ROSETTA_CODE = `${ROSETTA_CODE_ROOT}tasks`;

// Where ghul.dev describes a task, alongside the other solutions.
const ROSETTA_EXPLORER = 'https://ghul.dev/rosetta';

const GHUL_EXAMPLES_ROOT = 'https://raw.githubusercontent.com/ghul-lang/ghul-examples/main/';
const GHUL_EXAMPLES = `${GHUL_EXAMPLES_ROOT}examples`;

// Where ghul.dev shows the examples, one program to a page.
const GHUL_EXAMPLES_PAGES = 'https://ghul.dev/examples';

const COLLECTIONS = {
    // A task is tasks/<slug>/<slug>.ghul, or, for a task solved more than one
    // way, tasks/<slug>/<NN-part>/<NN-part>.ghul. A solution the playground
    // cannot run carries a playground-unsupported file giving the reason, and
    // one that reads files names them in playground-files, one path per line
    // relative to the task's directory. One that takes command-line arguments
    // names them in run.args, one argument per line, which is the file the test
    // runner uses. The task's own directory holds task.json, whose task field
    // is the task's name on the wiki.
    'rosetta-code': {
        pattern: /^([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([0-9]{2}(?:-[a-z0-9]+)+))?$/,

        locate: ([slug, part]) => {
            const directory = part ? `${ROSETTA_CODE}/${slug}/${part}` : `${ROSETTA_CODE}/${slug}`;

            return {
                source: `${directory}/${part ?? slug}.ghul`,
                unsupported: `${directory}/playground-unsupported`,
                files: `${directory}/playground-files`,
                arguments: `${directory}/run.args`,
                root: ROSETTA_CODE_ROOT,
                about: `${ROSETTA_CODE}/${slug}/task.json`,
                page: `${ROSETTA_EXPLORER}/${slug}`
            };
        }
    },

    // An example is examples/<topic>/<topic>.ghul, or, for a topic divided into
    // several programs, examples/<topic>/<NN-part>/<NN-part>.ghul. On ghul.dev
    // a topic's first program is on the topic's own page, and each of the
    // others on a page named for the topic and the part.
    'ghul-examples': {
        pattern: /^([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([0-9]{2}(?:-[a-z0-9]+)+))?$/,

        locate: ([topic, part]) => {
            const directory = part
                ? `${GHUL_EXAMPLES}/${topic}/${part}`
                : `${GHUL_EXAMPLES}/${topic}`;
            const page = part && !part.startsWith('01-') ? `${topic}-${part}` : topic;
            const words = name => name.replace(/^[0-9]{2}-/, '').replace(/-/g, ' ');

            return {
                source: `${directory}/${part ?? topic}.ghul`,
                unsupported: `${directory}/playground-unsupported`,
                files: `${directory}/playground-files`,
                arguments: `${directory}/run.args`,
                root: GHUL_EXAMPLES_ROOT,
                // no file names an example's title, so it is made from its directory names
                title: part ? `${words(topic)}: ${words(part)}` : words(topic),
                page: `${GHUL_EXAMPLES_PAGES}/${page}`
            };
        }
    }
};

// The collection names, which index.html's base script also lists.
export const COLLECTION_NAMES = Object.keys(COLLECTIONS);

// The page's path below the directory the playground is served from, with a
// leading `/`: what requestedProgram reads a program's name from.
export function pathBelowBase(pathname = location.pathname, base = new URL(document.baseURI).pathname) {
    return pathname.startsWith(base) ? pathname.slice(base.length - 1) : pathname;
}

// What a page path asks for: null when it names no collection, so the page
// behaves as it always has; otherwise the program's name and where to find it,
// or a message saying why the path does not name one.
export function requestedProgram(pathname) {
    const match = /^\/([a-z0-9-]+)\/(.+?)\/?$/.exec(pathname);
    const collection = match && COLLECTIONS[match[1]];

    if (!collection) return null;

    const name = `${match[1]}/${match[2]}`;
    const id = collection.pattern.exec(match[2]);

    if (!id) return { name, error: `${name} is not the name of a program` };

    return { name, ...collection.locate(id.slice(1)) };
}

// The program's source, the reason it will not run here if it carries one,
// the files it reads, the arguments it is run with, and its title where the
// collection gives one. Throws with a message fit to show the reader.
export async function loadProgram(request, fetchImpl = fetch) {
    if (request.error) throw new Error(request.error);

    // a collection that has no file of a kind names no location for it, and
    // reads as that file being absent
    const get = url => url
        ? fetchImpl(url, { signal: AbortSignal.timeout(10000) })
        : Promise.resolve({ ok: false, status: 404 });

    let source;
    let unsupported;
    let manifest;
    let about;
    let runArgs;

    try {
        [source, unsupported, manifest, about, runArgs] = await Promise.all([
            get(request.source),
            get(request.unsupported),
            get(request.files),
            get(request.about),
            get(request.arguments)
        ]);
    } catch (e) {
        throw new Error(`could not load ${request.name}: ${e.message}`);
    }

    if (source.status === 404) throw new Error(`there is no program called ${request.name}`);
    if (!source.ok) throw new Error(`could not load ${request.name}: ${source.status}`);

    // A file that will not load leaves the program in the editor, with the
    // reason shown where its output would be: the source is still worth
    // reading, and a run would only fail on the missing file.
    let files = [];
    let error;

    if (manifest.ok) {
        const text = await manifest.text();

        try {
            const wanted = dataFilePaths(text, request.files, request.root);

            files = await Promise.all(wanted.map(async ({ name, url }) => {
                const response = await get(url);

                if (!response.ok) throw new Error(`${name}: ${response.status}`);

                return { name, bytes: new Uint8Array(await response.arrayBuffer()) };
            }));
        } catch (e) {
            files = [];
            error = `could not load the files ${request.name} reads: ${e.message}`;
        }
    }

    // Only a label, so a task.json that is missing or unreadable costs the
    // title and nothing else. The timings it may carry are the same file's:
    // how long the task's program waits before its first line of output and
    // how long it runs, measured on the machine that tests the tasks, for the
    // page to scale by the browser's own speed.
    const aboutJson = about.ok ? await about.json().catch(() => null) : null;

    const timing = name => {
        const ms = Number(aboutJson?.[name]);

        return Number.isFinite(ms) && ms > 0 ? ms : null;
    };

    return {
        title: aboutJson && typeof aboutJson.task === 'string'
            ? aboutJson.task
            : request.title ?? null,
        source: await source.text(),
        unsupported: unsupported.ok ? (await unsupported.text()).trim() : null,
        files,
        // The arguments the task is run with, as its own run.args gives them:
        // one a line. A task that takes none has no such file, and gets none.
        arguments: runArgs.ok ? argumentsFromFile(await runArgs.text()) : [],
        firstOutputMs: timing('first_output_ms'),
        runMs: timing('run_ms'),
        ...(error ? { error } : {})
    };
}

// Where each file a manifest names is fetched from, and the name the program
// opens it by. A path is relative to the manifest, so a file shared between
// tasks can live once at the top of the repository; the program sees it under
// its own last segment, beside it in the working directory, which is where a
// task run from its own directory finds it. A path reaching outside the
// collection's repository is refused rather than fetched.
export function dataFilePaths(text, manifestUrl, root) {
    return text.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(path => {
            const url = new URL(path, manifestUrl).toString();

            if (!url.startsWith(root)) throw new Error(`${path} is outside the repository`);

            return { name: url.slice(url.lastIndexOf('/') + 1), url };
        });
}
