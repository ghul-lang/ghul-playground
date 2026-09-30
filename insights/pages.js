// What each page says. Each takes what report.js and system.js worked out and
// returns the body of a page for render.js's layout.

import * as report from './report.js';
import {
    html, meter, tile, change, dayBars, spark, lineChart, bands, bandLegend, funnel, table, cell, badge,
    number, percent, short, formatValue, KIND_NAMES,
} from './render.js';

const intro = (title, lede) => html`<h1>${title}</h1><p class="lede">${lede}</p>`;

export function overview({ visits, before, days, period, query }) {
    const now = report.summary(visits);
    const then = report.summary(before);
    const top = report.pages(visits).slice(0, 8);
    const problems = report.problems(visits, days).filter(p => p.kind !== 'program').slice(0, 6);
    const [site] = report.funnels(visits);

    return html`${intro('Overview', `The last ${period}, against the ${period} before it.`)}
<div class="tiles">
${tile('Visits', number(now.visits), change(now.visits, then.visits))}
${tile('Pages seen', number(now.pageviews), change(now.pageviews, then.pageviews))}
${tile('Left after one page', percent(now.bounced, now.visits), `${number(now.bounced)} visits that did nothing else`)}
${tile('Ran some code', percent(now.ranCode, now.visits), `${number(now.ranCode)} visits`)}
${tile('Hit a problem', percent(now.troubled, now.visits), `${number(now.troubled)} visits; see Problems`)}
</div>
<section class="card"><h2>Visits per day</h2>${dayBars(report.perDay(visits, days))}</section>
<div class="grid">
<section class="card"><h2>Most visited pages</h2>
${table(['Page', 'Visits '], top.map(p => html`<tr>${cell.path(p.path)}<td>${meter(p.visits, now.visits)}</td></tr>`))}
<p class="note"><a href="pages${query}">All pages</a></p></section>
${funnel(site)}
</div>
<section class="card"><h2>Problems readers ran into</h2>
${table(['What', 'Kind', 'Visits '], problems.map(p =>
        html`<tr>${cell.path(p.key)}${cell.text(badge(p.kind))}${cell.n(p.visits)}</tr>`), 'No problems recorded in this period.')}
<p class="note"><a href="problems${query}">All problems</a></p></section>`;
}

export function pages({ visits, period }) {
    const rows = report.pages(visits);
    const time = report.timeInSight(visits);
    const total = report.summary(visits).visits;

    return html`${intro('Pages', `What visitors looked at in the last ${period}, and how long it held them.`)}
<section class="card"><h2>Time in sight</h2>
<p class="note">How long a page was actually in front of the reader, reported once as it goes away. Hidden time is not counted. Grouped by the part of the site that reported it.</p>
${time.length ? [time.map(bands), bandLegend()] : html`<p class="note">No page reported its time in this period.</p>`}
</section>
<section class="card"><h2>Every page</h2>
<p class="note">Visits that saw the page; how many started there, ended there, and how many saw nothing else. Hover a shortened path for all of it.</p>
${table(['Page', 'Visits ', 'Share', 'Started ', 'Ended ', 'Only page '], rows.map(p => html`<tr>
${cell.path(p.path)}${cell.n(p.visits)}<td>${meter(p.visits, total, percent(p.visits, total))}</td>${cell.n(p.entries)}${cell.n(p.exits)}${cell.n(p.bounces)}</tr>`))}
</section>`;
}

export function journeys({ visits, period }) {
    const rows = report.pages(visits);
    const total = report.summary(visits).visits;
    const entries = rows.filter(p => p.entries).sort((a, b) => b.entries - a.entries).slice(0, 20);
    const exits = rows.filter(p => p.exits).sort((a, b) => b.exits - a.exits).slice(0, 20);

    return html`${intro('Journeys', `How visits arrived, moved and stopped in the last ${period}.`)}
<div class="grid">${report.funnels(visits).map(funnel)}</div>
<div class="grid">
<section class="card"><h2>Where visits started</h2>
${table(['Page', 'Visits '], entries.map(p => html`<tr>${cell.path(p.path)}<td>${meter(p.entries, total)}</td></tr>`))}
</section>
<section class="card"><h2>Where visits stopped</h2>
<p class="note">The last page a visit saw. "Only page" is how many of those saw nothing before it.</p>
${table(['Page', 'Stopped ', 'Only page '], exits.map(p => html`<tr>${cell.path(p.path)}${cell.n(p.exits)}${cell.n(p.bounces)}</tr>`))}
</section>
<section class="card"><h2>Commonest next steps</h2>
${table(['From', 'To', 'Times '], report.steps(visits).slice(0, 20).map(s =>
        html`<tr>${cell.path(s.from)}${cell.path(s.to)}${cell.n(s.count)}</tr>`))}
</section>
<section class="card"><h2>How they arrived</h2>
${table(['Referrer', 'Visits '], report.referrers(visits).slice(0, 20).map(r =>
        html`<tr>${cell.path(r.ref)}${cell.n(r.count)}</tr>`))}
</section>
</div>`;
}

export function problems({ visits, days, period }) {
    const rows = report.problems(visits, days);
    const total = report.summary(visits).visits;

    return html`${intro('Problems', `What went wrong for readers in the last ${period}.`)}
<section class="card"><h2>Every problem</h2>
<p class="note">${badge('fault')} the page itself failed: a script error, a runtime that would not load, a worker that died.
${badge('trouble')} the services let the reader down: busy, unreachable, timed out, or slow to first output.
${badge('program')} the reader's own program did not compile or threw, which is what a playground is for, but a lot of it on one example is worth a look.</p>
${table(['What', 'Kind', 'Times ', 'Visits ', 'Of all visits ', 'Per day'], rows.map(p => html`<tr>
${cell.path(p.key)}${cell.text(badge(p.kind))}${cell.n(p.times)}${cell.n(p.visits)}${cell.n(percent(p.visits, total))}<td>${spark(p.byDay)}</td></tr>`), 'No problems recorded in this period.')}
</section>
<div class="grid">${report.outcomes(visits).map(o => html`<section class="card"><h2>${o.family}</h2>
<p class="note">Every outcome reported, ${number(o.total)} in all.</p>
${table(['Outcome', 'Share'], o.details.map(d => html`<tr>${cell.text(d.kind ? [d.detail, ' ', badge(d.kind, KIND_NAMES[d.kind])] : d.detail)}<td>${meter(d.count, o.total)}</td></tr>`))}
</section>`)}</div>
<section class="card"><h2>Every event</h2>
<p class="note">Everything the pages counted other than time in sight, for anything the pages here do not already name.</p>
${table(['Event', 'Times ', 'Visits '], report.events(visits).map(e => html`<tr>${cell.path(e.name)}${cell.n(e.count)}${cell.n(e.visits)}</tr>`))}
</section>`;
}

const LIMIT = 150;

export function visits({ visits, period }) {
    const recent = visits.filter(v => v.pages.length).reverse().slice(0, LIMIT);

    return html`${intro('Visits', `The most recent ${LIMIT} visits in the last ${period}, newest first, each as the pages it went through.`)}
<section class="card">
<p class="note">A visit's id is GoatCounter's own: random, and it lasts one visit, so two visits can never be joined. No address is stored anywhere.</p>
${recent.length ? recent.map(v => html`<div class="visit">
<div class="meta"><span>${v.started.slice(5, 16)}</span><span>${v.place || 'unknown place'}</span><span>${v.screen}</span>${v.ref ? html`<span>from ${short(v.ref)}</span>` : ''}<span>${v.id}</span></div>
<div class="trail">${v.pages.map((p, i) => html`${i ? html`<span class="arrow"> → </span>` : ''}<span title="${p}">${short(p)}</span>`)}</div>
<div class="meta">${v.time.map(t => html`<span>${t.family.replace(/-time$/, '')} ${t.band}</span>`)}${[...new Set(v.problems.map(p => `${p.kind}\u0000${p.family}/${p.detail}`))].map(k => {
        const [kind, what] = k.split('\u0000');
        return badge(kind, what);
    })}</div>
</div>`) : html`<p class="note">No visits in this period.</p>`}
</section>`;
}

export function system({ system, period }) {
    if (system.error) {
        return html`${intro('System', `What the host was doing in the last ${period}.`)}
<section class="card warn"><h2>Prometheus did not answer</h2><p class="note">${system.error}</p></section>`;
    }

    return html`${intro('System', `What the host was doing in the last ${period}. A dashed line is the limit.`)}
<div class="grid">${system.host.map(lineChart)}</div>
<section class="card"><h2>Services</h2>
<p class="note">Restarts count a service restarting by itself, the first sign of a cap reached or a process dying; a deploy replacing it is not one.</p>
${table(['Service', 'Memory now ', 'Memory peak ', 'Memory limit ', 'Processor peak ', 'Restarts '], system.services.map(s => {
        const memory = s.charts['Memory'];
        const cpu = s.charts['Processor, in cores'];
        const peak = chart => chart?.points.length ? Math.max(...chart.points.map(([, v]) => v)) : undefined;

        return html`<tr>${cell.text(s.name)}${cell.n(formatValue(memory?.points.at(-1)?.[1], 'bytes'))}${cell.n(formatValue(peak(memory), 'bytes'))}${cell.n(memory?.limit ? formatValue(memory.limit, 'bytes') : 'none')}${cell.n(`${formatValue(peak(cpu), 'number')}${cpu?.limit ? ` of ${formatValue(cpu.limit, 'number')}` : ''}`)}${cell.n(s.restarts ? html`<strong>${number(s.restarts)}</strong>` : '0')}</tr>`;
    }))}
</section>
<div class="grid">${system.services.flatMap(s => Object.values(s.charts).map(c =>
        lineChart({ ...c, title: `${s.name}: ${c.title.toLowerCase()}` })))}</div>`;
}
