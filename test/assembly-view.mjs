// The compile service's shaping of a disassembler listing for the assembly
// view: the temporary directory taken out of names and positions, a source
// line for each listing line, and the size cap.
//
//   node test/assembly-view.mjs

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shapeListing } = require('../compile-service/view.js');

let failures = 0;

function check(name, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
    if (!ok) failures++;
}

const marker = 'ghul-playground-view-Ab3dEf';
const listing = [
    '.class private auto ansi beforefieldinit __tmp__ghul_playground_view_Ab3dEf__main.$frame_0',
    '{',
    '\t.method public hidebysig static void entry () cil managed',
    '\t{',
    '\t\t// sequence point: (line 3, col 1) to (line 3, col 52) in /tmp/ghul-playground-view-Ab3dEf/main.ghul',
    '\t\tIL_0000: ldc.i4.0',
    '\t\tIL_0001: call void __tmp__ghul_playground_view_Ab3dEf__main.$globals::f()',
    '\t\t// sequence point: (line 5, col 1) to (line 7, col 3) in /tmp/ghul-playground-view-Ab3dEf/main.ghul',
    '\t\tIL_0006: ret',
    '\t} // end of method $globals::entry',
    '}',
    ''
].join('\n');

const shaped = shapeListing(listing, marker);
const lines = shaped.text.split('\n');

check('the directory is taken out of type names', !shaped.text.includes('Ab3dEf') && lines[0].endsWith(' main.$frame_0'), lines[0]);
check('a position on one line reads as that line', lines[4] === '\t\t// line 3, columns 1-52', lines[4]);
check('a position over several lines reads as the range', lines[7] === '\t\t// lines 5-7', lines[7]);
check('one source line per listing line', shaped.lines.length === lines.length);
check('lines outside a method have no source line', shaped.lines[0] === null && shaped.lines[2] === null);
check('IL takes the line of the position before it', shaped.lines[5] === 3 && shaped.lines[6] === 3 && shaped.lines[8] === 5, shaped.lines);
check('the end of a method ends the position', shaped.lines[10] === null, shaped.lines);
check('a short listing is not truncated', shaped.truncated === false);

const long = Array.from({ length: 20000 }, (_, i) => `\t\tIL_${i}: nop // padding to make the listing long`).join('\n');
const cut = shapeListing(long, marker);

check('a long listing is cut and says so', cut.truncated && cut.text.endsWith('KB'), cut.text.slice(-60));
check('a cut listing stays under the cap', Buffer.byteLength(cut.text) <= 256 * 1024 + 100);
check('the cut keeps one source line per listing line', cut.lines.length === cut.text.split('\n').length);

process.exit(failures ? 1 : 0);
