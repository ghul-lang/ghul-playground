// The pages, as plain HTML written on the server.
//
// No script and nothing loaded from anywhere: one document per page, with its
// styles inline, so the content security policy can refuse everything else.
// The layout is a single column that is readable on a phone and simply gets
// wider on a desktop; tables that could be wider than the screen scroll inside
// themselves rather than making the page scroll sideways.
//
// Links are relative, so the same pages work behind nginx under
// /insights/ and at the root of an ssh tunnel.

import { TIME_BANDS } from './report.js';

export const escape = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// Tagged template that escapes every value unless it is already markup.
class Html {
    constructor(text) { this.text = text; }
    toString() { return this.text; }
}

export function html(strings, ...values) {
    let out = strings[0];

    values.forEach((value, i) => {
        out += render(value) + strings[i + 1];
    });

    return new Html(out);
}

function render(value) {
    if (value instanceof Html) return value.text;
    if (Array.isArray(value)) return value.map(render).join('');
    if (value === null || value === undefined || value === false) return '';
    return escape(value);
}

const number = n => Math.round(n).toLocaleString('en-GB');

const percent = (part, whole) => whole ? `${Math.round((part / whole) * 100)}%` : '–';

export function bytes(n) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;

    while (Math.abs(n) >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }

    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`;
}

export function formatValue(value, unit) {
    if (value === undefined || value === null || Number.isNaN(value)) return '–';
    if (unit === 'percent') return `${value.toFixed(0)}%`;
    if (unit === 'bytes') return bytes(value);
    if (unit === 'rate') return `${bytes(value)}/s`;
    return value < 10 ? value.toFixed(2) : number(value);
}

// The pieces of the site's own names that make a path hard to read at a glance.
const short = path => path.length > 48 ? `${path.slice(0, 46)}…` : path;

export const PAGES = [
    ['', 'Overview'],
    ['pages', 'Pages'],
    ['journeys', 'Journeys'],
    ['problems', 'Problems'],
    ['visits', 'Visits'],
    ['system', 'System'],
];

export const PERIODS = [1, 7, 30, 90];

// The query every link carries, so a period or a grouping chosen on one page
// holds on the next. Folding is the default and the parameters say when it is
// off, so a bare address shows the folded rows.
export const GROUPINGS = [['tasks', 'Rosetta tasks'], ['examples', 'Examples']];

export function queryFor(days, groups) {
    const off = GROUPINGS.filter(([key]) => !groups[key]).map(([key]) => `&${key}=each`);

    return `?days=${days}${off.join('')}`;
}

const STYLE = `
:root {
    color-scheme: light;
    --plane: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
    --series-1: #2a78d6; --series-1-soft: #86b6ef; --series-2: #eb6834;
    --good: #0ca30c; --good-ink: #006300; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
    --wash: rgba(42,120,214,0.08);
}
@media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
        color-scheme: dark;
        --plane: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
        --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
        --series-1: #3987e5; --series-1-soft: #184f95; --series-2: #d95926;
        --good-ink: #0ca30c; --wash: rgba(57,135,229,0.14);
    }
}
:root[data-theme="dark"] {
    color-scheme: dark;
    --plane: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --series-1: #3987e5; --series-1-soft: #184f95; --series-2: #d95926;
    --good-ink: #0ca30c; --wash: rgba(57,135,229,0.14);
}
* { box-sizing: border-box; }
body {
    margin: 0; background: var(--plane); color: var(--ink);
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { background: var(--surface); border-bottom: 1px solid var(--ring); position: sticky; top: 0; z-index: 1; }
.bar { max-width: 1100px; margin: 0 auto; padding: 8px 16px; display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; }
.bar strong { font-size: 15px; margin-right: 8px; }
nav, .periods, .groups { display: flex; flex-wrap: wrap; gap: 2px; }
.groups { flex-basis: 100%; align-items: center; font-size: 13px; color: var(--ink-2); }
.groups span { margin: 0 4px 0 12px; }
.groups span:first-child { margin-left: 0; }
nav a, .periods a, .groups a {
    color: var(--ink-2); text-decoration: none; padding: 4px 8px; border-radius: 6px; font-size: 14px;
}
nav a:hover, .periods a:hover, .groups a:hover { background: var(--wash); }
nav a[aria-current], .periods a[aria-current], .groups a[aria-current] { color: var(--ink); background: var(--wash); font-weight: 600; }
.periods { margin-left: auto; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
h1 { font-size: 20px; margin: 4px 0 4px; }
h2 { font-size: 16px; margin: 0 0 4px; }
p.lede { color: var(--ink-2); margin: 0 0 16px; }
.note { color: var(--muted); font-size: 13px; margin: 0 0 8px; }
section.card {
    background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 16px; min-width: 0;
}
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.grid { margin-bottom: 16px; }
.grid > section.card { margin-bottom: 0; }
.tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 16px; }
.tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 10px 14px; }
.tile .label { color: var(--ink-2); font-size: 13px; }
.tile .value { font-size: 26px; font-weight: 600; line-height: 1.2; }
.tile .change { font-size: 13px; color: var(--muted); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th { text-align: left; font-weight: 600; color: var(--ink-2); font-size: 13px; border-bottom: 1px solid var(--axis); padding: 4px 8px 4px 0; }
td { border-bottom: 1px solid var(--grid); padding: 5px 8px 5px 0; vertical-align: top; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.path { word-break: break-all; }
.meter { display: flex; align-items: center; gap: 8px; }
.meter .track { flex: 1; height: 10px; background: var(--grid); border-radius: 4px; overflow: hidden; min-width: 40px; }
.meter .fill { height: 100%; background: var(--series-1); border-radius: 0 4px 4px 0; }
.meter .num { min-width: 72px; white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; color: var(--ink-2); }
.step { margin: 6px 0; }
.step .what { font-size: 14px; display: flex; justify-content: space-between; gap: 8px; }
.step .drop { color: var(--muted); font-size: 12px; }
.bands { display: flex; height: 16px; border-radius: 4px; overflow: hidden; gap: 2px; background: var(--surface); }
.bands span { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--ink-2); margin-top: 6px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.b0 { background: #cde2fb; } .b1 { background: #86b6ef; } .b2 { background: #3987e5; } .b3 { background: #1c5cab; } .b4 { background: #0d366b; }
.badge { display: inline-block; font-size: 12px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--ring); color: var(--ink-2); white-space: nowrap; }
.badge.fault::before, .badge.trouble::before, .badge.program::before {
    content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px;
}
.badge.fault::before { background: var(--critical); }
.badge.trouble::before { background: var(--serious); }
.badge.program::before { background: var(--muted); }
.visit { border-bottom: 1px solid var(--grid); padding: 8px 0; }
.visit:last-child { border-bottom: 0; }
.visit .meta { font-size: 13px; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px 12px; }
.visit .trail { font-size: 14px; margin: 2px 0; word-break: break-word; }
.visit .trail .arrow { color: var(--muted); }
.chart svg { display: block; width: 100%; height: 90px; }
.chart .axis { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
.chart .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.chart .now { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.chart .range { font-size: 12px; color: var(--ink-2); }
.spark { display: block; width: 100%; max-width: 160px; height: 24px; }
.warn { border-left: 4px solid var(--serious); }
a { color: var(--series-1); }
`;

export function layout({ title, current, days, groups, generated, body }) {
    const query = queryFor(days, groups);
    const href = page => (page ? page : './') + query;
    const here = current || './';

    return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title} · ghul.dev insights</title>
<style>${new Html(STYLE)}</style>
</head>
<body>
<header><div class="bar">
<strong>ghul.dev insights</strong>
<nav>${PAGES.map(([page, name]) =>
        html`<a href="${href(page)}"${new Html(page === current ? ' aria-current="page"' : '')}>${name}</a>`)}</nav>
<div class="periods">${PERIODS.map(n =>
        html`<a href="${here + queryFor(n, groups)}"${new Html(n === days ? ' aria-current="true"' : '')}>${n === 1 ? '24h' : `${n}d`}</a>`)}</div>
${current === 'system' ? '' : html`<div class="groups">${GROUPINGS.map(([key, name]) => html`<span>${name}:</span>${[true, false].map(on =>
        html`<a href="${here + queryFor(days, { ...groups, [key]: on })}"${new Html(groups[key] === on ? ' aria-current="true"' : '')}>${on ? 'one row' : 'each'}</a>`)}`)}</div>`}
</div></header>
<main>
${body}
<p class="note">Generated ${generated} UTC from the analytics copy taken every five minutes. Visits by the site's own people are removed from that copy; see deploy/README.md.</p>
</main>
</body>
</html>`.text;
}

// A share of something, as a bar with its number beside it.
export function meter(count, of, label = `${number(count)} · ${percent(count, of)}`) {
    const width = of ? Math.max(count ? 1 : 0, (count / of) * 100) : 0;

    return html`<div class="meter"><div class="track"><div class="fill" style="width:${width.toFixed(1)}%"></div></div><span class="num">${label}</span></div>`;
}

export function tile(label, value, change) {
    return html`<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>${change ? html`<div class="change">${change}</div>` : ''}</div>`;
}

// Against the period before, written so that it reads without a colour.
export function change(now, before) {
    if (!before) return now ? 'none the period before' : '';

    const delta = Math.round(((now - before) / before) * 100);

    return delta === 0 ? 'same as the period before' : `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}% on the period before (${number(before)})`;
}

// Bars for a count per day. Each bar carries its own tooltip.
export function dayBars(series, label = 'visits') {
    const max = Math.max(1, ...series.map(d => d.visits));
    const w = 1000 / series.length;
    const gap = Math.min(2, w * 0.2);

    const bars = series.map((d, i) => {
        const h = (d.visits / max) * 86;

        return html`<rect x="${(i * w + gap / 2).toFixed(2)}" y="${(90 - h).toFixed(2)}" width="${(w - gap).toFixed(2)}" height="${h.toFixed(2)}" rx="2" fill="var(--series-1)"><title>${d.day}: ${number(d.visits)} ${label}</title></rect>`;
    });

    return html`<div class="chart">
<div class="head"><span class="range">busiest day ${number(max)}</span></div>
<svg viewBox="0 0 1000 90" preserveAspectRatio="none" role="img" aria-label="${label} per day">
<line x1="0" x2="1000" y1="89.5" y2="89.5" stroke="var(--axis)" vector-effect="non-scaling-stroke"/>
${bars}</svg>
<div class="axis"><span>${series[0]?.day ?? ''}</span><span>${series.at(-1)?.day ?? ''}</span></div>
</div>`;
}

// A small bar series with no axes, for a row of a table.
export function spark(values) {
    const max = Math.max(1, ...values);
    const w = 160 / Math.max(1, values.length);

    return html`<svg class="spark" viewBox="0 0 160 24" preserveAspectRatio="none" aria-hidden="true">${values.map((v, i) =>
        html`<rect x="${(i * w).toFixed(2)}" y="${(24 - (v / max) * 22).toFixed(2)}" width="${Math.max(0.5, w - 1).toFixed(2)}" height="${((v / max) * 22).toFixed(2)}" fill="var(--serious)"/>`)}</svg>`;
}

// A line over time for one measurement, with its latest value, its range, and
// its limit drawn as a dashed line when it has one.
export function lineChart({ title, unit, points, limit, note }) {
    if (!points?.length) {
        return html`<section class="card chart"><h2>${title}</h2><p class="note">No data for this period.</p></section>`;
    }

    const values = points.map(([, v]) => v);
    const t0 = points[0][0];
    const t1 = points.at(-1)[0];
    const top = Math.max(...values, limit ?? 0) * 1.05 || 1;

    const x = t => t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * 1000;
    const y = v => 90 - (v / top) * 88;

    const line = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${line}L${x(t1).toFixed(1)},90L0,90Z`;

    const when = t => new Date(t).toISOString().slice(5, 16).replace('T', ' ');

    return html`<section class="card chart">
<div class="head"><h2>${title}</h2><span class="now">${formatValue(values.at(-1), unit)}</span></div>
<div class="range">low ${formatValue(Math.min(...values), unit)} · high ${formatValue(Math.max(...values), unit)}${limit ? ` · limit ${formatValue(limit, unit)}` : ''}</div>
<svg viewBox="0 0 1000 90" preserveAspectRatio="none" role="img" aria-label="${title}">
<line x1="0" x2="1000" y1="89.5" y2="89.5" stroke="var(--axis)" vector-effect="non-scaling-stroke"/>
${limit ? html`<line x1="0" x2="1000" y1="${y(limit).toFixed(1)}" y2="${y(limit).toFixed(1)}" stroke="var(--critical)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>` : ''}
<path d="${area}" fill="var(--wash)"/>
<path d="${line}" fill="none" stroke="var(--series-1)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
</svg>
<div class="axis"><span>${when(t0)}</span><span>${when(t1)}</span></div>
${note ? html`<p class="note">${note}</p>` : ''}
</section>`;
}

// How long a family's pages were in sight, as one bar split into bands.
export function bands(family) {
    return html`<div class="step">
<div class="what"><span>${family.family.replace(/-time$/, '')}</span><span class="drop">${number(family.total)} reports</span></div>
<div class="bands">${family.bands.filter(b => b.count).map(b =>
        html`<span class="b${TIME_BANDS.indexOf(b.band)}" style="width:${((b.count / family.total) * 100).toFixed(1)}%" title="${b.band}: ${number(b.count)} (${percent(b.count, family.total)})"></span>`)}</div>
</div>`;
}

export const bandLegend = () =>
    html`<div class="legend">${TIME_BANDS.map((b, i) => html`<span><i class="b${i}"></i>${b}</span>`)}</div>`;

export function funnel(f) {
    const first = f.steps[0].count;

    return html`<section class="card">
<h2>${f.name}</h2><p class="note">${f.note}</p>
${first ? f.steps.map((s, i) => html`<div class="step">
<div class="what"><span>${s.label}</span>${i && !f.parts && f.steps[i - 1].count ? html`<span class="drop">${f.steps[i - 1].count - s.count ? `${number(f.steps[i - 1].count - s.count)} dropped off here` : 'none dropped off'}</span>` : ''}</div>
${meter(s.count, first)}
</div>`) : html`<p class="note">No visits in this period.</p>`}
</section>`;
}

export function table(headings, rows, empty = 'Nothing in this period.') {
    if (!rows.length) return html`<p class="note">${empty}</p>`;

    return html`<div class="scroll"><table>
<thead><tr>${headings.map(h => html`<th${new Html(h.endsWith(' ') ? ' class="n"' : '')}>${h.trim()}</th>`)}</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

export const cell = {
    n: value => html`<td class="n">${typeof value === 'number' ? number(value) : value}</td>`,
    path: value => html`<td class="path" title="${value}">${short(value)}</td>`,
    text: value => html`<td>${value}</td>`,
};

export const KIND_NAMES = {
    fault: 'page fault',
    trouble: 'service trouble',
    program: "reader's program failed",
};

export const badge = (kind, text = KIND_NAMES[kind]) => html`<span class="badge ${kind}">${text}</span>`;

export { number, percent, short, Html };
