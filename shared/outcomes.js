// One line per request, saying how it ended, for reading back what readers
// met: refusals, failures, timeouts and how long work took.
//
// The line is `outcome ` then a JSON object, so it can be picked out of the
// rest of a service's log. Only the fields named below are ever written, so a
// caller cannot put source text, a message from the compiler or a client
// address into one by passing it along.

const FIELDS = [
    'service',      // compile or analyse
    'kind',         // program or cell; editor or repl
    'event',        // what happened: request, refused, started, ended
    'result',       // how it ended, from a small closed set
    'status',       // the HTTP status or WebSocket close code answered
    'diagnostics',  // how many errors the compiler reported
    'target',       // dotnet or wasm, for a compile
    'ms',           // how long the work took
    'warm',         // whether a session was given an analyser already running
    'seconds',      // how long a session lasted
    'cpu'           // CPU seconds a session's analyser spent
];

function recordOutcome(fields, write = line => process.stdout.write(line)) {
    const kept = { at: new Date().toISOString() };

    for (const name of FIELDS) {
        if (fields[name] !== undefined) kept[name] = fields[name];
    }

    try {
        write(`outcome ${JSON.stringify(kept)}\n`);
    } catch {
        // Recording an outcome is never a reason for a request to fail.
    }
}

module.exports = { recordOutcome, FIELDS };
