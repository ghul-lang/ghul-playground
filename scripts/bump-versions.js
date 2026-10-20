// Moves versions.json to new tool versions and writes them everywhere the
// site names one, so a bump is one command instead of several edits kept in
// sync by hand - the history this repository has is exactly the other way
// round, a version landing in all but one site and check-versions.js catching
// it after the fact.
//
//   node scripts/bump-versions.js --latest
//   node scripts/bump-versions.js --compiler 66.12.7 --llvm 1.5.0
//   node scripts/bump-versions.js
//
// `--latest` resolves each tool's current highest stable release; an explicit
// flag sets only the tool it names (and applies after --latest). The flags are
// the tool names in versions.json: --compiler, --runtime, --raster, --core,
// --llvm, --language-server, --disassembler, --repl. Running with neither
// prints the current versions and does nothing.

const https = require('https');
const { execFileSync } = require('child_process');
const path = require('path');
const { TOOLS, wanted, read, write } = require('./versions');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'user-agent': 'ghul-playground-bump-versions' } }, res => {
            if (res.statusCode !== 200) {
                reject(new Error(`${url}: HTTP ${res.statusCode}`));
                res.resume();
                return;
            }

            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(new Error(`${url}: ${err.message}`));
                }
            });
        }).on('error', reject);
    });
}

const compare = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);

    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }

    return 0;
};

// Highest stable version nuget.org lists for a package - prereleases
// (anything with a `-`) are never what a routine bump wants.
async function latestPublished(packageId) {
    const index = await fetchJson(`https://api.nuget.org/v3-flatcontainer/${packageId.toLowerCase()}/index.json`);

    return index.versions.filter(v => !v.includes('-')).sort(compare).pop();
}

// The newest release GitHub marks as latest.
async function latestRelease(repository) {
    const release = await fetchJson(`https://api.github.com/repos/${repository}/releases/latest`);

    return release.tag_name.replace(/^v/, '');
}

const SOURCES = {
    compiler: () => latestPublished('ghul.compiler'),
    runtime: () => latestPublished('ghul.runtime'),
    raster: () => latestPublished('ghul.raster'),
    repl: () => latestPublished('ghul.repl'),
    disassembler: () => latestPublished('ilspycmd'),
    core: () => latestRelease('ghul-lang/ghul-core'),
    llvm: () => latestRelease('ghul-lang/ghul-llvm'),
    languageServer: () => latestRelease('ghul-lang/ghul-vsce')
};

const FLAGS = { languageServer: '--language-server' };
const flagOf = tool => FLAGS[tool] ?? `--${tool}`;

async function main() {
    const args = process.argv.slice(2);
    const versions = wanted();

    if (args.includes('--latest')) {
        const latest = await Promise.all(TOOLS.map(tool => SOURCES[tool]()));

        TOOLS.forEach((tool, i) => versions[tool] = latest[i]);
    }

    for (const tool of TOOLS) {
        const i = args.indexOf(flagOf(tool));

        if (i !== -1) {
            versions[tool] = args[i + 1];
        }
    }

    const before = wanted();
    const changed = TOOLS.filter(tool => before[tool] !== versions[tool]);

    if (!args.length) {
        for (const tool of TOOLS) console.log(`${tool.padEnd(15)} ${before[tool]}`);
        console.log('\nNothing to do - pass --latest or a tool flag (--compiler 66.12.7) to bump.');
        return;
    }

    for (const tool of changed) console.log(`${tool}: ${before[tool]} -> ${versions[tool]}`);

    const ordered = Object.fromEntries(TOOLS.map(tool => [tool, versions[tool]]));

    write('versions.json', JSON.stringify(ordered, null, 4) + '\n');

    execFileSync('node', [path.join(__dirname, 'sync-versions.js')], { stdio: 'inherit' });
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
