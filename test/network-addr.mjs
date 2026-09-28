// The kept access logs write a client's network rather than its address, by an
// nginx map in deploy/nginx/playground-limits.conf. This reads that map and
// applies it, first match wins as nginx's regex entries do, to the address
// shapes it has to handle.
//
//   node test/network-addr.mjs

import { readFileSync } from 'fs';

let failures = 0;

const check = (what, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `: got ${actual}, expected ${expected}`}`);
};

const conf = readFileSync(new URL('../deploy/nginx/playground-limits.conf', import.meta.url), 'utf8');
const body = /map \$remote_addr \$network_addr \{([\s\S]*?)\}/.exec(conf)?.[1];

if (!body) {
    console.log('FAIL  no $network_addr map in playground-limits.conf');
    process.exit(1);
}

const entries = body.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => /^(?:"~([^"]*)"|(default))\s+(\S+);$/.exec(line))
    .filter(Boolean)
    .map(([, pattern, fallback, value]) => ({ pattern: fallback ? null : new RegExp(pattern), value }));

const networkOf = address => {
    for (const { pattern, value } of entries) {
        if (!pattern) continue;

        const match = pattern.exec(address);

        if (match) return value.replace(/\$(\d)/g, (_, n) => match[n]);
    }

    return entries.find(entry => !entry.pattern)?.value;
};

check('an IPv4 address keeps its /24', networkOf('203.0.113.42'), '203.0.113.0');
check('a full IPv6 address keeps its /48', networkOf('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::');
check('a shortened IPv6 address with three groups keeps them', networkOf('2001:db8:85a3::1'), '2001:db8:85a3::');
check('one with fewer groups is written as ::', networkOf('2001:db8::1'), '::');
check('the loopback is written as ::', networkOf('::1'), '::');
check('an IPv4-mapped address is written as ::', networkOf('::ffff:203.0.113.42'), '::');
check('an empty address is written as -', networkOf(''), '-');

if (failures) {
    console.log(`${failures} failure(s)`);
    process.exit(1);
}
