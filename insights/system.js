// What the host is doing, asked of Prometheus.
//
// Prometheus answers nobody outside the compose network, so this is the one
// way its numbers reach a page. Each chart is one range query, asked for about
// a hundred and fifty points whatever the period, which is as many as a narrow
// screen can show and few enough that a quarter costs the same as an hour.

const POINTS = 150;

// The machine, from node-exporter. `unit` says how a value is written.
export const HOST_CHARTS = [
    {
        title: 'Processor in use',
        unit: 'percent',
        max: 100,
        query: '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
    },
    {
        title: 'Load, one minute',
        unit: 'number',
        note: 'Eight cores, so eight is full.',
        query: 'node_load1',
    },
    {
        title: 'Memory in use',
        unit: 'bytes',
        query: 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes',
        limit: 'node_memory_MemTotal_bytes',
    },
    {
        title: 'Disk free',
        unit: 'bytes',
        query: 'node_filesystem_avail_bytes{mountpoint="/"}',
        limit: 'node_filesystem_size_bytes{mountpoint="/"}',
    },
    {
        title: 'Network in',
        unit: 'rate',
        query: 'sum(rate(node_network_receive_bytes_total{job="host-network",device="eth0"}[5m]))',
    },
    {
        title: 'Network out',
        unit: 'rate',
        query: 'sum(rate(node_network_transmit_bytes_total{job="host-network",device="eth0"}[5m]))',
    },
];

// Per service, from cAdvisor, keyed by the `container` label Prometheus lifts
// out of each cgroup path. Summed by it because a deploy replaces a container,
// and the old one's series and the new one's are the same service.
export const CONTAINER_CHARTS = [
    {
        title: 'Memory',
        unit: 'bytes',
        query: 'sum by (container) (container_memory_working_set_bytes)',
        limit: 'max by (container) (container_spec_memory_limit_bytes)',
    },
    {
        title: 'Processor, in cores',
        unit: 'number',
        query: 'sum by (container) (rate(container_cpu_usage_seconds_total[5m]))',
        limit: 'max by (container) (container_spec_cpu_quota / container_spec_cpu_period)',
    },
];

// A service restarting by itself is the first sign of a cap being reached or a
// process dying, so it is counted over the whole period rather than charted.
const RESTARTS = window => `sum by (container) (changes(container_start_time_seconds[${window}]))`;

async function ask(base, path, params) {
    const url = new URL(path, base);

    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const body = await response.json();

    if (body.status !== 'success') throw new Error(body.error ?? `prometheus answered ${response.status}`);

    return body.data.result;
}

const range = (base, query, from, to) =>
    ask(base, '/api/v1/query_range', {
        query,
        start: from.getTime() / 1000,
        end: to.getTime() / 1000,
        step: Math.max(30, Math.round((to - from) / 1000 / POINTS)),
    }).then(result => result.map(series => ({
        metric: series.metric,
        points: series.values.map(([t, v]) => [t * 1000, Number(v)]),
    })));

const instant = (base, query, at) =>
    ask(base, '/api/v1/query', { query, time: at.getTime() / 1000 })
        .then(result => result.map(series => ({ metric: series.metric, value: Number(series.value[1]) })));

// Everything the system page shows, or the reason it cannot be had. A failure
// is reported rather than thrown: the visitor pages do not depend on this.
export async function system(base, from, to) {
    try {
        const host = await Promise.all(HOST_CHARTS.map(async chart => ({
            ...chart,
            points: (await range(base, chart.query, from, to))[0]?.points ?? [],
            limit: chart.limit ? (await instant(base, chart.limit, to))[0]?.value : chart.max,
        })));

        const services = new Map();

        const service = name => {
            if (!services.has(name)) services.set(name, { name, charts: {}, restarts: 0 });
            return services.get(name);
        };

        for (const chart of CONTAINER_CHARTS) {
            for (const series of await range(base, chart.query, from, to)) {
                // The chart's limit is a query, not a value: it stays unset
                // unless the answer to that query is usable.
                service(series.metric.container).charts[chart.title] = { ...chart, points: series.points, limit: undefined };
            }

            for (const series of await instant(base, chart.limit, to)) {
                const found = services.get(series.metric.container)?.charts[chart.title];

                // cAdvisor reports no limit as zero or as a huge number, and
                // either would flatten the chart to nothing.
                if (found && series.value > 0 && Number.isFinite(series.value) && series.value < 2 ** 60) {
                    found.limit = series.value;
                }
            }
        }

        const window = `${Math.max(1, Math.round((to - from) / 60000))}m`;

        for (const series of await instant(base, RESTARTS(window), to)) {
            if (series.metric.container) service(series.metric.container).restarts = series.value;
        }

        return {
            host,
            services: [...services.values()].filter(s => s.name).sort((a, b) => a.name.localeCompare(b.name)),
        };
    } catch (e) {
        return { error: e.message ?? String(e) };
    }
}
