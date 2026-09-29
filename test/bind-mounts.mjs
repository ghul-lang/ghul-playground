// No service may mount a single file from this repository into a container.
//
// A bind mount of a *file* pins the inode it was started with. git does not
// edit a file in place - it writes a new one and renames it over the old - so a
// container started before a change goes on seeing the file it started with,
// for as long as it runs, however many times the repository changes. Nothing
// reports it: the deploy succeeds, the host has the new file, the container has
// the old one.
//
// It cost a fix that deployed and did nothing, and the only reason it was
// noticed is that somebody looked at the host afterwards. A directory mount
// does not have the problem, and a file carried in the image is better still,
// because changing it replaces the container.
//
//   node test/bind-mounts.mjs

import { readFileSync, statSync } from 'fs';
import path from 'path';

const root = path.join(import.meta.dirname, '..');

let failures = 0;

const check = (what, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');

// Every mount whose source is a path in this repository, which is what `./`
// marks; a named volume has no slash and is not this hazard.
const mounts = [...compose.matchAll(/^\s+- (\.\/[^:\s]+):/gm)].map(m => m[1]);

// None at all is the best outcome, so this checks instead that the volume lists
// are being read: a pattern that had stopped matching anything would otherwise
// pass for ever.
const volumes = [...compose.matchAll(/^\s+- ([^\s:]+):\//gm)];

check('the volume lists are being read', volumes.length > 0, `${volumes.length} found`);

for (const mount of mounts) {
    let kind;

    try {
        kind = statSync(path.join(root, mount)).isDirectory() ? 'directory' : 'file';
    } catch {
        kind = 'missing';
    }

    check(`${mount} is a directory`, kind === 'directory',
        kind === 'file'
            ? 'a single file: mount its directory instead, or copy it into the image'
            : 'nothing is there');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
