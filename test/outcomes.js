// The outcome line: its shape, and that only named fields reach it.
//
//   node test/outcomes.js

const { recordOutcome } = require('../shared/outcomes');

let failures = 0;

function check(what, ok) {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
}

const lines = [];

recordOutcome({
    service: 'compile', kind: 'program', result: 'ok', status: 200, diagnostics: 0, ms: 812,
    source: 'entry() is si', address: '203.0.113.9', message: 'error: something'
}, line => lines.push(line));

check('one line is written', lines.length === 1);
check('it starts with the marker', lines[0].startsWith('outcome {'));
check('it ends with a newline', lines[0].endsWith('\n'));

const record = JSON.parse(lines[0].slice('outcome '.length));

check('named fields are kept', record.service === 'compile' && record.result === 'ok' && record.ms === 812);
check('it is timestamped', typeof record.at === 'string');
check('source text is not written', !('source' in record) && !lines[0].includes('entry()'));
check('an address is not written', !('address' in record) && !lines[0].includes('203.0.113.9'));
check('a compiler message is not written', !('message' in record));

let threw = false;

try {
    recordOutcome({ service: 'analyse' }, () => { throw new Error('closed'); });
} catch {
    threw = true;
}

check('a failed write does not throw', !threw);

process.exit(failures ? 1 : 0);
