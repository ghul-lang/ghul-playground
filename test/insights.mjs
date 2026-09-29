// The insights pages: what they count, and who they answer.
//
// Builds a snapshot with GoatCounter's own schema and a few visits whose
// numbers are known, checks what report.js makes of them, then starts the
// service against that snapshot and a stand-in Prometheus and checks that it
// refuses without the password, refuses a wrong one, and serves every page
// with the right one. A service that fails open is the failure worth a test:
// it looks exactly like one that works.
//
//   node test/insights.mjs

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

import * as report from '../insights/report.js';
import { html, escape } from '../insights/render.js';

let failures = 0;

const check = (what, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

// GoatCounter v2.7.0's own definitions, copied from a running instance rather
// than written from memory: `session` is a blob, `width` is nullable, and a
// query that forgets either is wrong in a way a made-up schema would hide.
const SCHEMA = `
create table hits (hit_id integer primary key autoincrement, site_id integer not null,
  path_id integer not null, ref_id integer not null default 1, session blob default null,
  first_visit integer default 0, browser_id integer not null, system_id integer not null,
  campaign integer default null, width smallint null, location varchar not null default '',
  language varchar, created_at timestamp not null);
create table paths (path_id integer primary key autoincrement, site_id integer not null,
  path varchar not null, title varchar not null default '', event integer default 0);
create table refs (ref_id integer primary key autoincrement, ref varchar not null,
  ref_scheme varchar not null);

insert into paths (path_id, site_id, path, event) values
  (1, 1, '/', 0), (2, 1, '/playground/', 0), (3, 1, 'playground-open/rosetta-code', 1),
  (4, 1, 'playground-run/manual/rosetta-code/x', 1), (5, 1, 'playground-result/compiled-ok', 1),
  (6, 1, '/repl/', 0), (7, 1, 'repl-open', 1), (8, 1, 'repl-cell/ok', 1),
  (9, 1, '/control-flow', 0), (10, 1, 'example-run/a', 1), (11, 1, 'example-result/ok', 1),
  (12, 1, 'playground-result/busy', 1), (13, 1, '/playground.ghul.dev/rosetta-code/x', 0),
  (14, 1, 'playground-time/2-10m', 1), (15, 1, 'repl-error/script', 1),
  (16, 1, 'repl-cell/compile-error', 1), (17, 1, '<script>', 0);
insert into refs (ref_id, ref, ref_scheme) values (1, '', 'o'), (2, 'rosettacode.org', 'h');
insert into hits (site_id, path_id, ref_id, session, first_visit, browser_id, system_id, width, location, created_at) values
  -- A: arrives from Rosetta Code, opens the playground and runs by hand; it works.
  (1, 1, 2, x'0a', 1, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 2, 1, x'0a', 0, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 3, 1, x'0a', 0, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 4, 1, x'0a', 0, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 5, 1, x'0a', 0, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  (1, 14, 1, x'0a', 0, 1, 1, 1280, 'GB', datetime('now', '-1 day')),
  -- B: the REPL; one cell works, one does not compile, and the page throws.
  (1, 6, 1, x'0b', 1, 1, 1, null, 'FR', datetime('now', '-2 day')),
  (1, 7, 1, x'0b', 0, 1, 1, null, 'FR', datetime('now', '-2 day')),
  (1, 8, 1, x'0b', 0, 1, 1, null, 'FR', datetime('now', '-2 day')),
  (1, 16, 1, x'0b', 0, 1, 1, null, 'FR', datetime('now', '-2 day')),
  (1, 15, 1, x'0b', 0, 1, 1, null, 'FR', datetime('now', '-2 day')),
  -- C: a docs page, an example that works, then the playground is busy.
  (1, 9, 1, x'0c', 1, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  (1, 10, 1, x'0c', 0, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  (1, 11, 1, x'0c', 0, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  (1, 2, 1, x'0c', 0, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  (1, 3, 1, x'0c', 0, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  (1, 12, 1, x'0c', 0, 1, 1, 390, 'DE', datetime('now', '-3 day')),
  -- D: one page, from before the move, and nothing else.
  (1, 13, 1, x'0d', 1, 1, 1, 1280, 'US', datetime('now', '-4 day')),
  -- E: a path carrying markup, which a page must never render as markup.
  (1, 17, 1, x'0e', 1, 1, 1, 1280, 'US', datetime('now', '-4 day')),
  -- F: outside a week, so only a longer period counts it.
  (1, 1, 1, x'0f', 1, 1, 1, 1280, 'US', datetime('now', '-10 day'));
`;

const work = mkdtempSync(path.join(tmpdir(), 'ghul-insights-'));
const snapshot = path.join(work, 'analytics.sqlite3');

{
    const db = new DatabaseSync(snapshot);
    db.exec(SCHEMA);
    db.close();
}

const now = new Date(Date.now() + 60000);
const week = new Date(now.getTime() - 7 * 86400000);

// What report.js makes of them.
const visits = report.visitsOf(report.readHits(snapshot, week, now));
const byId = Object.fromEntries(visits.map(v => [v.id, v]));

check('reads the week\'s visits and not the older one', visits.length === 5, `${visits.length}`);
check('a visit is its pages in order', byId['0a']?.pages.join(' ') === '/ /playground/', byId['0a']?.pages.join(' '));
check('an old playground host path is read as today\'s', byId['0d']?.pages[0] === '/playground/rosetta-code/x', byId['0d']?.pages[0]);
check('a referrer is kept from the first hit', byId['0a']?.ref === 'rosettacode.org');
check('time in sight is read as time, not as an event',
    byId['0a']?.time[0]?.band === '2-10m' && !byId['0a'].events.some(e => e.family === 'playground-time'));

const summary = report.summary(visits);
check('counts the visits that saw a page', summary.visits === 5, `${summary.visits}`);
check('counts a one-page visit with nothing else as leaving', summary.bounced === 2, `${summary.bounced}`);
check('counts the visits that hit trouble, not a reader\'s own compile error', summary.troubled === 2, `${summary.troubled}`);

const kinds = Object.fromEntries(report.problems(visits, report.daysBetween(week, now)).map(p => [p.key, p.kind]));
check('a page error is a fault', kinds['repl-error/script'] === 'fault');
check('a busy service is trouble', kinds['playground-result/busy'] === 'trouble');
check('a cell that does not compile is the reader\'s program', kinds['repl-cell/compile-error'] === 'program');
check('a clean result is no problem', !('playground-result/compiled-ok' in kinds));

const [site, playground, repl, examples] = report.funnels(visits);
const counts = f => f.steps.map(s => s.count).join(',');
check('the whole-site funnel', counts(site) === '5,3,1,3,1,1,1', counts(site));
check('the playground funnel', counts(playground) === '2,1,1,1', counts(playground));
check('the REPL funnel', counts(repl) === '1,1,1', counts(repl));
check('the examples funnel', counts(examples) === '1,1,1,1', counts(examples));

const landing = report.pages(visits).find(p => p.path === '/');
check('a page counts entries and exits', landing?.entries === 1 && landing?.exits === 0, JSON.stringify(landing));

check('markup in a value is escaped', String(html`<td>${'<script>'}</td>`) === '<td>&lt;script&gt;</td>');
check('and so is a quote in an attribute', escape('"x\'') === '&quot;x&#39;');

// A Prometheus that answers every query with one short series.
const prometheus = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    const range = url.pathname.endsWith('query_range');
    const metric = url.searchParams.get('query').includes('container') ? { container: 'compile' } : {};
    const t = Math.floor(Date.now() / 1000);

    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
        status: 'success',
        data: {
            resultType: range ? 'matrix' : 'vector',
            result: [range ? { metric, values: [[t - 60, '1'], [t, '2']] } : { metric, value: [t, '3'] }],
        },
    }));
});

await new Promise(resolve => prometheus.listen(0, '127.0.0.1', resolve));

const start = (env) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(import.meta.dirname, '../insights/server.js')], {
        env: { ...process.env, PORT: '0', ...env },
        stdio: ['ignore', 'pipe', 'inherit'],
    });

    // PORT=0 has the system choose, and the service says which it got.
    return new Promise((resolve, reject) => {
        let out = '';

        child.stdout.on('data', d => {
            out += d;
            const port = /listening on [^:]+:(\d+)/.exec(out)?.[1];
            if (port) resolve({ child, base: `http://127.0.0.1:${port}` });
        });

        child.on('exit', code => reject(new Error(`the service exited with ${code}: ${out}`)));
    });
};

const get = (url, password) => fetch(url, password === undefined ? {} : {
    headers: { authorization: `Basic ${Buffer.from(`any:${password}`).toString('base64')}` },
});

const env = {
    SNAPSHOT: snapshot,
    PROMETHEUS_URL: `http://127.0.0.1:${prometheus.address().port}`,
};

const services = [];

try {
    const closed = await start({ ...env, INSIGHTS_PASSWORD: '' });
    services.push(closed.child);

    const refused = await get(`${closed.base}/`, '');
    check('with no password set, nothing is served', refused.status === 503, `${refused.status}`);

    const open = await start({ ...env, INSIGHTS_PASSWORD: 'right-password' });
    services.push(open.child);

    const none = await get(`${open.base}/`);
    check('no password is refused and asked for',
        none.status === 401 && /^Basic /.test(none.headers.get('www-authenticate') ?? ''), `${none.status}`);

    const wrong = await get(`${open.base}/`, 'wrong-password');
    check('a wrong password is refused', wrong.status === 401, `${wrong.status}`);

    for (const page of ['', 'pages', 'journeys', 'problems', 'visits', 'system']) {
        for (const days of [1, 7, 90]) {
            const response = await get(`${open.base}/${page}?days=${days}`, 'right-password');
            const text = await response.text();

            check(`/${page}?days=${days} is served with the password`, response.status === 200, `${response.status}: ${text.slice(0, 200)}`);

            if (days === 7) {
                check(`/${page} is marked not to be indexed or cached`,
                    response.headers.get('x-robots-tag')?.includes('noindex') && response.headers.get('cache-control') === 'no-store');
                check(`/${page} carries no raw markup from a path`, !text.includes('<script>'));
            }
        }
    }

    const missing = await get(`${open.base}/nothing-here`, 'right-password');
    check('an unknown page is not found', missing.status === 404, `${missing.status}`);

    const text = await (await get(`${open.base}/problems?days=7`, 'right-password')).text();
    check('the problems page names the busy service', text.includes('playground-result/busy'));

    const systemPage = await (await get(`${open.base}/system?days=1`, 'right-password')).text();
    check('the system page draws what Prometheus answered', systemPage.includes('Processor in use') && systemPage.includes('compile'));
} catch (e) {
    check('the service ran', false, e.message);
} finally {
    for (const child of services) child.kill();
    prometheus.close();
    rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
