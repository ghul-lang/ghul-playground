// Which analyser events a sequence of session changes produces.
//
//   node test/analyser-outcomes.mjs

import { AnalyserOutcomes } from '../web/wwwroot/analyser-outcomes.js';

let failures = 0;

function check(what, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `  got ${JSON.stringify(actual)}`}`);
}

function run(steps) {
    const reported = [];
    const outcomes = new AnalyserOutcomes(event => reported.push(event));

    for (const step of steps) {
        if (step === 'ready') outcomes.ready();
        else outcomes.failed(step);
    }

    return reported;
}

check('a first ready session is connected', run(['ready']), ['connected']);

check('ready again after idleness is not counted', run(['ready', 'ready']), ['connected']);

check('repeated refusals are one refusal', run(['refused', 'refused', 'refused']), ['refused']);

check('a refusal then a session is refused then connected', run(['refused', 'refused', 'ready']), ['refused', 'connected']);

check('a dropped session that comes back is reconnected', run(['ready', 'dropped', 'unavailable', 'unavailable', 'ready']), ['connected', 'dropped', 'unavailable', 'reconnected']);

check('a second episode is counted again', run(['ready', 'dropped', 'ready', 'dropped', 'ready']), ['connected', 'dropped', 'reconnected', 'dropped', 'reconnected']);

check('a service never reached is unavailable once', run(['unavailable', 'unavailable']), ['unavailable']);

process.exit(failures ? 1 : 0);
