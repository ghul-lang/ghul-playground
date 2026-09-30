// A few plain pages saying what visitors did and what the host is doing, for
// the one person who reads them.
//
// It reads the analytics snapshot, never the live database - the same copy,
// mounted read-only, that the snapshot service writes - and asks Prometheus
// for the host's numbers. It writes nothing anywhere.
//
// Every request needs the password in INSIGHTS_PASSWORD, as HTTP basic
// authentication with any user name. Without one set, nothing is served: a
// missing setting fails closed rather than publishing the visit log.
//
//   INSIGHTS_PASSWORD=... node insights/server.js

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';

import * as report from './report.js';
import * as body from './pages.js';
import { layout, queryFor, GROUPINGS, PAGES, PERIODS } from './render.js';
import { system } from './system.js';

const PORT = Number(process.env.PORT ?? 5094);
const HOST = process.env.HOST ?? '127.0.0.1';
const SNAPSHOT = process.env.SNAPSHOT ?? '/snapshot/analytics.sqlite3';
const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://prometheus:9090';
const PASSWORD = process.env.INSIGHTS_PASSWORD ?? '';

const digest = text => createHash('sha256').update(text).digest();

// Compared as digests, so the comparison takes the same time whatever the
// length of the guess.
const expected = digest(PASSWORD);

export function authorised(header) {
    if (!PASSWORD || !header?.startsWith('Basic ')) return false;

    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);

    return timingSafeEqual(digest(password), expected);
}

const HEADERS = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(response, status, text, extra = {}) {
    response.writeHead(status, { ...HEADERS, ...extra });
    response.end(text);
}

const periodName = days => days === 1 ? '24 hours' : `${days} days`;

async function page(name, days, groups) {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const earlier = new Date(from.getTime() - days * 86400000);

    const context = { period: periodName(days), days: report.daysBetween(from, to), query: queryFor(days, groups) };

    if (name === 'system') {
        context.system = await system(PROMETHEUS, from, to);
    } else {
        if (!existsSync(SNAPSHOT)) throw new Error(`no analytics snapshot at ${SNAPSHOT} yet`);

        const each = report.visitsOf(report.readHits(SNAPSHOT, from, to));

        context.visits = report.groupVisits(each, groups);
        context.explore = report.explored(each);

        if (name === 'overview') {
            context.before = report.groupVisits(report.visitsOf(report.readHits(SNAPSHOT, earlier, from)), groups);
        }
    }

    const title = PAGES.find(([p]) => (p || 'overview') === name)[1];

    let snapshotAge = '';

    try {
        snapshotAge = `, snapshot ${new Date(statSync(SNAPSHOT).mtime).toISOString().slice(11, 16)}`;
    } catch {
        // No snapshot is already said above, where it matters.
    }

    return layout({
        title,
        current: name === 'overview' ? '' : name,
        days,
        groups,
        generated: `${to.toISOString().slice(0, 16).replace('T', ' ')}${snapshotAge}`,
        body: body[name](context),
    });
}

export const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return send(response, 405, 'GET only', { allow: 'GET, HEAD', 'content-type': 'text/plain' });
    }

    if (!PASSWORD) {
        return send(response, 503, 'No INSIGHTS_PASSWORD is set on the host, so nothing is served.',
            { 'content-type': 'text/plain' });
    }

    if (!authorised(request.headers.authorization)) {
        return send(response, 401, 'Password required.', {
            'www-authenticate': 'Basic realm="ghul.dev insights", charset="UTF-8"',
            'content-type': 'text/plain',
        });
    }

    const url = new URL(request.url, 'http://insights');
    const name = url.pathname.replace(/^\/+|\/+$/g, '') || 'overview';

    if (!PAGES.some(([p]) => (p || 'overview') === name)) return send(response, 404, 'Not found.', { 'content-type': 'text/plain' });

    const asked = Number(url.searchParams.get('days'));
    const days = PERIODS.includes(asked) ? asked : 7;
    const groups = Object.fromEntries(GROUPINGS.map(([key]) => [key, url.searchParams.get(key) !== 'each']));

    try {
        send(response, 200, request.method === 'HEAD' ? '' : await page(name, days, groups));
    } catch (e) {
        console.error(`insights: ${name}: ${e.stack ?? e}`);
        send(response, 500, `Could not build this page: ${e.message ?? e}`, { 'content-type': 'text/plain' });
    }
});

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
    server.listen(PORT, HOST, () => {
        console.log(`insights: listening on ${HOST}:${server.address().port}, reading ${SNAPSHOT} and ${PROMETHEUS}`);

        if (!PASSWORD) console.log('insights: no INSIGHTS_PASSWORD set, so every request is refused');
    });
}
