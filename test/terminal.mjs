// The output panel's terminal on its own, and against the Rosetta Code tools'
// terminal on the output of the Rosetta Code tasks that draw with escape
// sequences.
//
//   node test/terminal.mjs
//
// test/terminal/<task>.out is the task's run.expected from
// ghul-rosetta-code, and <task>.json the screen that repository's
// Rosetta.TERMINAL is left showing after playing it at the size in
// sizes.json. The two terminals implement the same sequences the same way, so
// they must leave the same screen.

import { readFileSync } from 'node:fs';
import { Terminal } from '../web/wwwroot/terminal.js';
import { LiveOutput } from '../web/wwwroot/live-output.js';

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

function played(text, options = {}, piece = text.length || 1) {
    const terminal = new Terminal(options);

    for (let at = 0; at < text.length; at += piece) terminal.feed(text.slice(at, at + piece));

    terminal.finish();

    return terminal;
}

const fixtures = new URL('./terminal/', import.meta.url);
const sizes = JSON.parse(readFileSync(new URL('sizes.json', fixtures), 'utf8'));

for (const [task, size] of Object.entries(sizes)) {
    const output = readFileSync(new URL(`${task}.out`, fixtures), 'utf8');
    const expected = JSON.parse(readFileSync(new URL(`${task}.json`, fixtures), 'utf8'));
    const whole = JSON.stringify(played(output, size).screen);

    check(`${task}: the screen Rosetta.TERMINAL leaves`, whole === JSON.stringify(expected));

    // However the output is cut into pieces, sequences split across two
    // pieces included, it leaves the same screen.
    for (const piece of [1, 2, 3, 7]) {
        check(`${task}: the same screen fed ${piece} character(s) at a time`,
            JSON.stringify(played(output, size, piece).screen) === whole);
    }
}

{
    const terminal = played('\x1b[31mred\x1b[0m plain\n');
    const [line] = terminal.lines;

    check('a color applies to the text after it, and a reset ends it',
        line.length === 2 && line[0].text === 'red' && line[0].foreground === 1
        && line[1].text === ' plain' && line[1].foreground === -1,
        JSON.stringify(line));
}

check('an unknown sequence is dropped, not shown',
    played('a\x1b[5zb\n').text === 'ab\n', JSON.stringify(played('a\x1b[5zb\n').text));

check('a sequence the output ends part way through is dropped',
    played('done\x1b[3').text === 'done\n', JSON.stringify(played('done\x1b[3').text));

check('a lone ESC at the end is dropped',
    played('done\x1b').text === 'done\n');

check('home and clear redraw in place',
    played('first\n\x1b[2J\x1b[Hsecond').text === 'second\n',
    JSON.stringify(played('first\n\x1b[2J\x1b[Hsecond').text));

check('leaving the alternate screen brings back what was there',
    played('kept\n\x1b[?1049hhidden\x1b[?1049l').text === 'kept\n',
    JSON.stringify(played('kept\n\x1b[?1049hhidden\x1b[?1049l').text));

{
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const terminal = played(`\x1b[1m${lines}\n`);

    check('lines scrolled off the screen are kept above it',
        terminal.lines.length === 30 && terminal.lines[0][0].text === 'line 0' && terminal.lines[29][0].text === 'line 29');
}

{
    const live = new LiveOutput({ readFile: () => null });

    live.feed('plain\r\nline\n');

    check('output with no escape sequence has no screen', live.screen === null);
    check('and its text is as before', live.text === 'plain\nline\n', JSON.stringify(live.text));
}

{
    const live = new LiveOutput({ readFile: () => null });

    live.feed('before\n');
    live.feed('\x1b[1mbold');
    live.feed('\x1b[0m after\n');

    const screen = live.screen;

    check('the first escape sequence switches to a screen, keeping what came before',
        screen !== null && screen.length === 2 && screen[0][0].text === 'before'
        && screen[1][0].text === 'bold' && screen[1][0].bold && screen[1][1].text === ' after',
        JSON.stringify(screen));

    check('and the text is the screen as plain text', live.text === 'before\nbold after\n', JSON.stringify(live.text));
}

if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
}

console.log('\nall passed');
