// The compile service's shaping of a disassembler listing for the assembly
// view: the temporary directory taken out of names and positions, a source
// line for each listing line, and the size cap. And the same for the WAT the
// compiler prints for a wasm build: the source line each statement's marker
// names, and how many library functions were left out. And for a native
// build: the program's own functions in LLVM IR, and in the assembly ghul-llvm
// writes, each instruction with its source line.
//
//   node test/assembly-view.mjs

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shapeListing, shapeWat, programFunctions, shapeLlvm, shapeAsm } = require('../compile-service/view.js');

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

// What `--wat --wat-lines --wat-program-only` prints for a short program.
const wat = [
    '(module',
    '  (func $entry (type 19) (local $width.0 i32)',
    '    ;; main.ghul:7',
    '    i32.const 3',
    '    local.set $width.0',
    '    ;; main.ghul:8',
    '    local.get $width.0',
    '    call $Library.twice',
    '    return',
    '  )',
    '  (func $helper (type 2)',
    '    ;; /libraries/ghul-runtime/ghul-core/src/x.ghul:40',
    '    i32.const 0',
    '  )',
    '  ;; 3 more functions not shown',
    ')',
    ''
].join('\n');

const shapedWat = shapeWat(wat, 'main.ghul');
const watLines = shapedWat.text.split('\n');

check('WAT keeps one source line per listing line', shapedWat.lines.length === watLines.length);
check('WAT instructions take the line of the marker before them',
    shapedWat.lines[3] === 7 && shapedWat.lines[4] === 7 && shapedWat.lines[6] === 8 && shapedWat.lines[8] === 8, shapedWat.lines);
check('a function header has no source line', shapedWat.lines[1] === null && shapedWat.lines[10] === null, shapedWat.lines);
check('the markers themselves map to no line', shapedWat.lines[2] === null && shapedWat.lines[5] === null, shapedWat.lines);
check('a position in a library file maps to no line', shapedWat.lines[12] === null, shapedWat.lines);
check('the count of functions left out is read', shapedWat.omitted === 3, shapedWat.omitted);
check('a whole module leaves nothing out', shapeWat('(module\n)\n', 'main.ghul').omitted === 0);

const longWat = '(module\n' + Array.from({ length: 20000 }, () => '    i32.const 0 ;; padding to make the listing long').join('\n');
const cutWat = shapeWat(longWat, 'main.ghul');

check('a long WAT listing is cut and says so', cutWat.truncated && cutWat.text.endsWith('KB'), cutWat.text.slice(-60));
check('the cut WAT keeps one source line per listing line', cutWat.lines.length === cutWat.text.split('\n').length);

// An optimised module: `square` is the program's own; `$ghul_entry` holds
// the program's code inlined into it; `helper` is a library's.
const ir = [
    'define internal i32 @square(i32 %n) !dbg !10 {',
    'entry:',
    '  %0 = mul i32 %n, %n, !dbg !20',
    '  ret i32 %0',
    '}',
    '',
    'define i32 @"$ghul_entry"() {',
    '  call void @helper(), !dbg !22',
    '  ret i32 0',
    '}',
    '',
    'define void @helper() !dbg !11 {',
    '  ret void, !dbg !21',
    '}',
    '',
    '!1 = !DIFile(filename: "main.ghul", directory: "/tmp/view")',
    '!2 = !DIFile(filename: "io.ghul", directory: "/lib")',
    '!10 = distinct !DISubprogram(name: "square", scope: !1, file: !1, line: 3)',
    '!11 = distinct !DISubprogram(name: "helper", scope: !2, file: !2, line: 9)',
    '!12 = distinct !DILexicalBlock(scope: !10, file: !1, line: 4)',
    '!20 = !DILocation(line: 3, column: 1, scope: !12)',
    '!21 = !DILocation(line: 9, column: 1, scope: !11)',
    '!22 = !DILocation(line: 9, column: 1, scope: !11, inlinedAt: !20)',
    ''
].join('\n');

check('the program\'s functions are its own and those holding its inlined code',
    JSON.stringify([...programFunctions(ir)]) === JSON.stringify(['square', '$ghul_entry']), [...programFunctions(ir)]);

const programIr = shapeLlvm(ir, true);

check('program-only IR keeps the program\'s functions', programIr.text.includes('@square') && programIr.text.includes('$ghul_entry'), programIr.text);
check('program-only IR leaves a library\'s out, and counts it', !programIr.text.includes('define void @helper') && programIr.omitted === 1, programIr.omitted);
check('the whole IR is shown as written', shapeLlvm(ir).text === ir.trimEnd());
check('no IR line maps to the source', programIr.lines.every(line => line === null));

const asm = [
    '\t.text',
    '\t.file\t"module.ll"',
    '\t.file\t0 "/tmp/view" "main.ghul"',
    '\t.file\t1 "/lib" "io.ghul"',
    '\t.globl\tsquare',
    '\t.type\tsquare,@function',
    'square:',
    '.Lfunc_begin0:',
    '\t.cfi_startproc',
    '\t.loc\t0 3 0',
    '\tmovl\t%edi, %eax',
    '.Ltmp0:',
    '\t.loc\t0 4 5 prologue_end',
    '\timull\t%edi, %eax',
    '.LBB0_1:',
    '\t.loc\t1 9 0',
    '\tretq',
    '.Lfunc_end0:',
    '\t.size\tsquare, .Lfunc_end0-square',
    '\t.cfi_endproc',
    '\t.type\thelper,@function',
    'helper:',
    '\t.loc\t1 9 0',
    '\tretq',
    '\t.size\thelper, .Lfunc_end1-helper',
    '\t.section\t.rodata',
    'square.table:',
    '\t.quad\t0',
    ''
].join('\n');

const kept = shapeAsm(asm, new Set(['square']));
const keptLines = kept.text.split('\n');

check('asm keeps only the functions named, and counts the rest',
    keptLines[0] === 'square:' && !kept.text.includes('helper') && kept.omitted === 1, kept.text);
check('directives and internal labels are dropped, block labels kept',
    !kept.text.includes('.loc') && !kept.text.includes('.cfi') && !kept.text.includes('.Ltmp') && kept.text.includes('.LBB0_1:'), kept.text);
check('instructions take the line of the .loc before them', kept.lines[1] === 3 && kept.lines[2] === 4, kept.lines);
check('a position in a library file maps to no line', kept.lines[4] === null, kept.lines);
check('data is not a function', !kept.text.includes('square.table'), kept.text);

const everything = shapeAsm(asm, null);

check('with no names asm keeps every function', everything.text.includes('helper:') && everything.omitted === 0, everything.text);

process.exit(failures ? 1 : 0);
