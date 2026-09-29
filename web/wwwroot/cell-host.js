// The runtime side of an interactive session, in the cell host frame.
//
// The parent page posts `{id, op, args}` and gets `{id, result}` back, with
// `result` parsed from the runner's JSON:
//
// - `run`, args `[assembly, submission]`: runs one cell's assembly, base64 as
//   the compile service returned it. Playground.RUNNER.run_cell's answer, with
//   its output posted as it appears, as for `accept` below.
// - `prepare`, args `[text]`: what to post to the compile service for a
//   submission. Playground.REPL_SESSION.prepare's answer.
// - `accept`, args `[reply]`: the compile service's reply, as text; runs the
//   cell if it compiled. Playground.REPL_SESSION.accept's answer. While the
//   cell runs, what it writes is posted as it appears, as `{id, live: text}`,
//   followed by `{id, live: '', truncated: true}` if it writes more than the
//   channel holds. The answer's own text is the whole of it either way.
// - `analysis`, args `[text]`: what to analyse for the input being typed.
//   Playground.REPL_SESSION.analysis's answer.
//
// Everything run here goes into the one session this frame's runtime holds.
// Only a parent of the same origin is answered. The frame is written as
// srcdoc, where `location` is about:srcdoc, so the origin is `self.origin`.

// First, for the same reason as on the pages; see errors.js.
import { forwardErrors, reportError } from './errors.js'
import { dotnet } from './_framework/dotnet.js'
import { OUTPUT_WRITTEN, OUTPUT_TRUNCATED, channelViews, readOutput } from './channel.js'

let exports = null;

async function runtime() {
    if (!exports) {
        exports = (async () => {
            const api = await dotnet.create();
            const assembly = await api.getAssemblyExports(api.getConfig().mainAssemblyName);
            const address = await assembly.GhulRunner.OpenChannel();

            return { runner: assembly.GhulRunner, views: channelViews(api.Module, address) };
        })();

        exports.catch(() => reportError('runtime-load'));
    }

    return exports;
}

// How often a running cell's output is looked for. Reading a counter out of
// memory is cheap; what this bounds is how far behind the page can be.
const POLL_MS = 50;

// Posts what a cell writes while `work` runs. The count is reset here rather
// than in the runner: nothing is running at this instant, so the frame and the
// cell cannot disagree about which cell a count belongs to.
async function streamed(id, views, work) {
    const { control } = views();

    Atomics.store(control, OUTPUT_WRITTEN, 0);
    Atomics.store(control, OUTPUT_TRUNCATED, 0);

    let shown = 0;
    let truncated = false;

    const look = () => {
        const { control, output } = views();
        const written = Atomics.load(control, OUTPUT_WRITTEN);

        if (written > shown) {
            window.parent.postMessage({ id, live: readOutput(output, shown, written) }, self.origin);
            shown = written;
        }

        if (!truncated && Atomics.load(control, OUTPUT_TRUNCATED) !== 0) {
            truncated = true;
            window.parent.postMessage({ id, live: '', truncated: true }, self.origin);
        }
    };

    const watch = setInterval(look, POLL_MS);

    try {
        return await work();
    } finally {
        clearInterval(watch);
    }
}

const OPS = {
    run: ({ runner, views }, id, [assembly, submission]) => streamed(id, views, () => runner.RunCell(assembly, submission)),
    prepare: ({ runner }, _id, [text]) => runner.ReplPrepare(text),
    accept: ({ runner, views }, id, [reply]) => streamed(id, views, () => runner.ReplAccept(reply)),
    analysis: ({ runner }, _id, [text]) => runner.ReplAnalysis(text)
};

// Calls are answered one after another, in the order they arrive, since each
// can depend on the one before it.
let queue = Promise.resolve();

window.addEventListener('message', event => {
    if (event.origin !== self.origin || event.source !== window.parent) return;

    const { id, op, args } = event.data ?? {};

    if (typeof id !== 'number' || !Object.hasOwn(OPS, op) || !Array.isArray(args)) return;
    if (!args.every(a => typeof a === 'string')) return;

    queue = queue.then(async () => {
        let result;

        try {
            result = JSON.parse(await OPS[op](await runtime(), id, args));
        } catch (e) {
            result = { text: '', error: `host error: ${e}` };
        }

        window.parent.postMessage({ id, result }, self.origin);
    });
});

// The frame counts nothing itself; the page holding it counts what went wrong
// here as its own.
forwardErrors(kind => window.parent.postMessage({ error: kind }, self.origin));

window.parent.postMessage({ ready: true }, self.origin);
