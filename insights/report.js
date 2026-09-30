// What the visitor pages say, worked out from the analytics snapshot.
//
// The period's hits are read once, as rows, and everything else is worked out
// here rather than in SQL. The site's volume makes that cheap - a busy quarter
// is tens of thousands of rows - and it means each question below is a few
// lines that can be read and tested, rather than one query per panel with the
// path clean-up pasted into every one of them.
//
// Nothing here adds to what GoatCounter stores. A visit is its `session`,
// which is random and lives for one visit, so a visit can be followed from page
// to page but two visits can never be joined.

import { DatabaseSync } from 'node:sqlite';

// The families whose events say how long a page was in sight rather than what
// the reader did, sent once as the page goes away, in these bands.
export const TIME_FAMILIES = ['site-time', 'examples-time', 'rosetta-time', 'playground-time', 'repl-time'];
export const TIME_BANDS = ['under-10s', '10-30s', '30s-2m', '2-10m', 'over-10m'];

// Outcomes that mean the site let the reader down, as against the reader's own
// program not compiling or throwing, which is what a playground is for. Anything
// in a family ending `-error` is also one: those are the page's own faults.
const TROUBLE = {
    'playground-result': ['busy', 'error', 'timeout', 'too-big'],
    'repl-cell': ['error'],
    'playground-analyser': ['refused', 'unavailable', 'dropped'],
    'repl-analyser': ['refused', 'unavailable', 'dropped'],
    'playground-first-output': ['over-10s'],
};

// A reader's program that did not work. Worth seeing - a lot of these on one
// example says the example is hard - but not a fault of the site's.
const PROGRAM_FAILED = {
    'playground-result': ['compile-error', 'threw'],
    'repl-cell': ['compile-error', 'threw'],
};

// Paths recorded before the playground moved under ghul.dev, and ghul.dev's
// own name where GoatCounter kept it, written as the path they are today.
export function cleanPath(path) {
    const cleaned = path
        .replace('playground.ghul.dev/run/', 'playground-run/')
        .replace('/playground.ghul.dev', '/playground')
        .replace('/ghul.dev', '');

    return cleaned === '' ? '/' : cleaned;
}

// The part of the site a page is in, which is what time in sight is reported
// against and what the funnels step through.
export function area(path) {
    if (path.startsWith('/playground')) return 'playground';
    if (path.startsWith('/repl')) return 'repl';
    if (path.startsWith('/rosetta')) return 'rosetta';
    if (path === '/') return 'landing';
    return 'docs';
}

// Rosetta Code tasks and documentation examples each number in the dozens, and
// a row apiece buries everything else, so the pages can fold each kind into
// one row. Only what names a single task or example is folded: the section's
// own page, /rosetta, stays itself, as does an event that names no task or
// example, such as playground-open/rosetta-code or example-result/ok. Folding
// renames a page or an event and never merges two in a visit, so a visit's
// counts are the same either way and a visit touching several tasks is one
// visit in the row they fold into.
const TASK_PAGES = [[/^\/rosetta\/[^/]/, '/rosetta/*'], [/^\/playground\/rosetta-code\/./, '/playground/rosetta-code/*']];
const EXAMPLE_PAGES = [[/^\/playground\/ghul-examples\/./, '/playground/ghul-examples/*']];
const TASK_EVENTS = new Set(['rosetta-open']);
const EXAMPLE_EVENTS = new Set(['example-edit', 'example-run', 'example-copy']);

// The row a page is shown in: its own path, or the one it folds into.
export function groupPage(path, groups) {
    const folds = [...(groups.tasks ? TASK_PAGES : []), ...(groups.examples ? EXAMPLE_PAGES : [])];

    return folds.find(([pattern]) => pattern.test(path))?.[1] ?? path;
}

// Likewise for an event. A run keeps its mode, since the funnels read it.
export function groupEvent(family, detail, groups) {
    if (groups.tasks && TASK_EVENTS.has(family) && detail) return { family, detail: '*' };
    if (groups.examples && EXAMPLE_EVENTS.has(family) && detail) return { family, detail: '*' };

    const run = /^(automatic|manual)\/(rosetta-code|ghul-examples)\/./.exec(detail);

    if (family === 'playground-run' && run && groups[run[2] === 'rosetta-code' ? 'tasks' : 'examples']) {
        return { family, detail: `${run[1]}/${run[2]}/*` };
    }

    return { family, detail };
}

export function groupVisits(visits, groups) {
    if (!groups.tasks && !groups.examples) return visits;

    const event = e => ({ ...e, ...groupEvent(e.family, e.detail, groups) });

    return visits.map(visit => ({
        ...visit,
        pages: visit.pages.map(path => groupPage(path, groups)),
        events: visit.events.map(event),
        problems: visit.problems.map(event),
    }));
}

export function splitEvent(path) {
    const at = path.indexOf('/');

    return at < 0 ? { family: path, detail: '' } : { family: path.slice(0, at), detail: path.slice(at + 1) };
}

export function classify(family, detail) {
    if (family.endsWith('-error')) return 'fault';
    if (TROUBLE[family]?.includes(detail)) return 'trouble';
    if (PROGRAM_FAILED[family]?.includes(detail)) return 'program';
    if (family === 'example-result' && detail !== 'ok') return 'program';
    return null;
}

// Every hit from `from` up to `to`, oldest first, as plain rows. The database
// is opened for this one read and closed again: the snapshot is replaced by a
// rename every few minutes, and a handle held open would go on reading the
// copy it opened.
export function readHits(file, from, to) {
    const db = new DatabaseSync(file, { readOnly: true });

    try {
        return db.prepare(`
            select lower(hex(h.session)) as session, h.created_at as at, p.path, p.event,
                   h.location as place, h.width, h.first_visit as first, coalesce(r.ref, '') as ref
            from hits h join paths p using (path_id) left join refs r using (ref_id)
            where h.created_at >= ? and h.created_at < ?
            order by h.hit_id`).all(sqlTime(from), sqlTime(to));
    } finally {
        db.close();
    }
}

// GoatCounter writes `YYYY-MM-DD HH:MM:SS` in UTC, and compares as text.
export const sqlTime = date => date.toISOString().slice(0, 19).replace('T', ' ');

const screen = width =>
    !width ? 'unknown' : width < 600 ? 'phone' : width < 1100 ? 'tablet' : 'desktop';

// The rows, gathered into visits in the order each was made.
export function visitsOf(rows) {
    const visits = new Map();

    for (const row of rows) {
        // A hit with no session is one GoatCounter could not place in a visit;
        // it is counted as a visit of its own rather than merged with others.
        const key = row.session || `solo-${visits.size}`;

        let visit = visits.get(key);

        if (!visit) {
            visit = {
                id: key.slice(0, 8), started: row.at, ended: row.at, place: '', screen: 'unknown',
                ref: null, pages: [], events: [], time: [], problems: [],
            };
            visits.set(key, visit);
        }

        visit.ended = row.at;
        if (row.place) visit.place = row.place;
        if (row.width) visit.screen = screen(row.width);
        if (row.first && visit.ref === null) visit.ref = row.ref;

        const path = cleanPath(row.path);

        if (!row.event) {
            // The same page twice running is a reload, not a step.
            if (visit.pages.at(-1) !== path) visit.pages.push(path);
            continue;
        }

        const { family, detail } = splitEvent(path);

        if (TIME_FAMILIES.includes(family)) {
            visit.time.push({ family, band: detail });
            continue;
        }

        visit.events.push({ family, detail });

        const kind = classify(family, detail);

        if (kind) visit.problems.push({ kind, family, detail });
    }

    return [...visits.values()];
}

// Counts of `key(item)` over `items`, largest first, as [key, count] pairs.
function tally(items, key = x => x) {
    const counts = new Map();

    for (const item of items) {
        const k = key(item);
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

const unique = items => [...new Set(items)];

const reached = (visit, test) => visit.events.some(test) || false;

const pageIn = (visit, name) => visit.pages.some(p => area(p) === name);

const event = (family, detail) => e =>
    e.family === family && (detail === undefined || (typeof detail === 'function' ? detail(e.detail) : e.detail === detail));

// Each funnel is a list of steps, and a step is counted as reached by a visit
// whatever order it did them in: the counter says what happened, not always
// in the order it happened, since events can wait for the counter to load.
//
// The whole-site one is `parts` rather than a sequence - a visit can open the
// REPL without ever reading the docs - so it is read against its first step
// alone. In the others each step can only be reached through the one before,
// so the fall from step to step is where readers dropped off.
export const FUNNELS = [
    {
        name: 'The whole site',
        note: 'Every visit that saw a page, and how many went on to each part.',
        within: visit => visit.pages.length > 0,
        parts: true,
        steps: [
            ['saw a page', () => true],
            ['read the docs or Rosetta', v => ['docs', 'landing', 'rosetta'].some(a => pageIn(v, a))],
            ['ran an example in the docs', v => reached(v, event('example-run'))],
            ['opened the playground', v => pageIn(v, 'playground')],
            ['ran something by hand', v => reached(v, event('playground-run', d => d.startsWith('manual/')))],
            ['opened the REPL', v => pageIn(v, 'repl')],
            ['ran a REPL cell', v => reached(v, event('repl-cell'))],
        ],
    },
    {
        name: 'The playground',
        note: 'Visits that opened the playground.',
        within: v => reached(v, event('playground-open')),
        steps: [
            ['opened it', () => true],
            ['ran a program', v => reached(v, event('playground-run'))],
            ['got a result', v => reached(v, event('playground-result'))],
            ['compiled and ran cleanly', v => reached(v, event('playground-result', 'compiled-ok'))],
        ],
    },
    {
        name: 'The REPL',
        note: 'Visits that opened the REPL.',
        within: v => reached(v, event('repl-open')),
        steps: [
            ['opened it', () => true],
            ['ran a cell', v => reached(v, event('repl-cell'))],
            ['a cell worked', v => reached(v, event('repl-cell', 'ok'))],
        ],
    },
    {
        name: 'Examples in the docs',
        note: 'Visits that touched an example on a documentation page.',
        within: v => reached(v, e => ['example-edit', 'example-run', 'example-copy'].includes(e.family)),
        steps: [
            ['touched one', () => true],
            ['ran one', v => reached(v, event('example-run'))],
            ['got a result', v => reached(v, event('example-result'))],
            ['it worked', v => reached(v, event('example-result', 'ok'))],
        ],
    },
];

export function funnels(visits) {
    return FUNNELS.map(funnel => {
        const within = visits.filter(funnel.within);

        return {
            name: funnel.name,
            note: funnel.note,
            parts: Boolean(funnel.parts),
            // In a sequence a visit counts at a step only if it reached every
            // step before it too, so an event lost on the way - a counter that
            // had not loaded - cannot make a later step larger than an earlier.
            steps: funnel.steps.map(([label, test], i) => ({
                label,
                count: within.filter(v => funnel.parts
                    ? test(v)
                    : funnel.steps.slice(0, i + 1).every(([, t]) => t(v))).length,
            })),
        };
    });
}

// How long pages were in sight, by the family that reported it.
export function timeInSight(visits) {
    return TIME_FAMILIES.map(family => {
        const reports = visits.flatMap(v => v.time.filter(t => t.family === family));

        return {
            family,
            total: reports.length,
            bands: TIME_BANDS.map(band => ({ band, count: reports.filter(t => t.band === band).length })),
        };
    }).filter(f => f.total > 0);
}

// Per page: how many visits saw it, how many started or ended there, and how
// many saw nothing else.
export function pages(visits) {
    const rows = new Map();

    const row = path => {
        if (!rows.has(path)) rows.set(path, { path, visits: 0, entries: 0, exits: 0, bounces: 0 });
        return rows.get(path);
    };

    for (const visit of visits) {
        if (!visit.pages.length) continue;

        for (const path of unique(visit.pages)) row(path).visits++;

        row(visit.pages[0]).entries++;
        row(visit.pages.at(-1)).exits++;

        if (visit.pages.length === 1) row(visit.pages[0]).bounces++;
    }

    return [...rows.values()].sort((a, b) => b.visits - a.visits || a.path.localeCompare(b.path));
}

export function steps(visits) {
    const moves = visits.flatMap(v => v.pages.slice(1).map((to, i) => `${v.pages[i]}\u0000${to}`));

    return tally(moves).map(([key, count]) => {
        const [from, to] = key.split('\u0000');
        return { from, to, count };
    });
}

export function referrers(visits) {
    return tally(visits.filter(v => v.ref !== null), v => v.ref || '(typed or bookmarked)')
        .map(([ref, count]) => ({ ref, count }));
}

// Each kind of problem, how often and in how many visits, with a count per day.
export function problems(visits, days) {
    const rows = new Map();

    for (const visit of visits) {
        for (const p of visit.problems) {
            const key = `${p.family}/${p.detail}`;

            if (!rows.has(key)) rows.set(key, { key, ...p, times: 0, visits: new Set(), byDay: new Map() });

            const row = rows.get(key);
            const day = visit.started.slice(0, 10);

            row.times++;
            row.visits.add(visit.id);
            row.byDay.set(day, (row.byDay.get(day) ?? 0) + 1);
        }
    }

    const order = { fault: 0, trouble: 1, program: 2 };

    return [...rows.values()]
        .map(row => ({ ...row, visits: row.visits.size, byDay: days.map(d => row.byDay.get(d) ?? 0) }))
        .sort((a, b) => order[a.kind] - order[b.kind] || b.times - a.times);
}

// The outcome mix for the families that report one per attempt, so a rate can
// be read as well as a count.
export function outcomes(visits) {
    const families = ['playground-result', 'repl-cell', 'example-result', 'playground-first-output'];

    return families.map(family => {
        const seen = visits.flatMap(v => v.events.filter(e => e.family === family));

        return {
            family,
            total: seen.length,
            details: tally(seen, e => e.detail).map(([detail, count]) => ({
                detail, count, kind: classify(family, detail),
            })),
        };
    }).filter(f => f.total > 0);
}

// Every event, for anything the pages above do not already name.
export function events(visits) {
    const name = e => e.detail ? `${e.family}/${e.detail}` : e.family;
    const inVisits = new Map(tally(visits.flatMap(v => unique(v.events.map(name)))));

    return tally(visits.flatMap(v => v.events), name)
        .map(([name, count]) => ({ name, count, visits: inVisits.get(name) }));
}

// The UTC days from `from` up to `to`, as `YYYY-MM-DD`.
export function daysBetween(from, to) {
    const days = [];

    for (let d = new Date(from); d < to; d = new Date(d.getTime() + 86400000)) {
        days.push(d.toISOString().slice(0, 10));
    }

    return days;
}

export function perDay(visits, days) {
    const counts = new Map(tally(visits.filter(v => v.pages.length), v => v.started.slice(0, 10)));

    return days.map(day => ({ day, visits: counts.get(day) ?? 0 }));
}

// The headline numbers for one period.
export function summary(visits) {
    const withPages = visits.filter(v => v.pages.length);

    return {
        visits: withPages.length,
        pageviews: withPages.reduce((n, v) => n + v.pages.length, 0),
        bounced: withPages.filter(v => v.pages.length === 1 && !v.events.length).length,
        troubled: withPages.filter(v => v.problems.some(p => p.kind !== 'program')).length,
        ranCode: withPages.filter(v => v.events.some(e =>
            ['playground-run', 'repl-cell', 'example-run'].includes(e.family))).length,
    };
}
