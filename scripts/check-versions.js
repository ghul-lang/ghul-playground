// Every tool has one version across the whole site: the compile service, the
// analyse service, the runner, the web app, the paired ghul-llvm, the language
// server and the libraries all run what versions.json says, and a place that
// says anything else fails here.
//
// The services compile user code against one runtime and the browser loads
// another, so a disagreement is not a build error - it is a program that
// compiles, downloads, and then fails to load, or an editor that reports
// something the compile does not say. An updater proposing a new version edits
// each site separately, so this is also what catches a bump that landed
// everywhere but one.
//
//   node scripts/check-versions.js      fails on any site that is not versions.json
//   node scripts/sync-versions.js       writes the sites from versions.json

const { TOOLS, SITES, wanted, read } = require('./versions');

const versions = wanted();

let failed = false;

for (const tool of TOOLS) {
    const found = SITES.filter(site => site.tool === tool).map(site => ({ site, version: site.read() }));
    const wrong = found.filter(f => f.version !== versions[tool]);

    if (!wrong.length) {
        console.log(`${tool}: ${versions[tool]}${found.length ? ` in all ${found.length} places` : ''}`);
        continue;
    }

    failed = true;

    console.error(`${tool}: versions.json says ${versions[tool]}, but`);

    for (const { site, version } of wrong) {
        console.error(`    ${(version ?? '(not found)').padEnd(12)} ${site.file}`);
    }
}

// A place that names a tool version but is not in the table is a place this
// check cannot see, so it is reported rather than left to drift.
const unregistered = [];

for (const file of ['compile-service/Dockerfile', 'analyse-service/Dockerfile']) {
    for (const [, arg] of read(file).matchAll(/^ARG ([A-Z_]*VERSION)=/gm)) {
        const known = SITES.some(site => site.file === file && site.argName === arg);

        if (!known) unregistered.push(`${file}: ARG ${arg}`);
    }
}

for (const file of ['web/web.csproj', 'runner/runner.ghulproj']) {
    for (const [, id] of read(file).matchAll(/Include="(ghul\.[A-Za-z.]+)"\s+Version=/g)) {
        const known = SITES.some(site => site.file === file && site.id === id);

        if (!known) unregistered.push(`${file}: ${id}`);
    }
}

for (const id of Object.keys(JSON.parse(read('.config/dotnet-tools.json')).tools)) {
    const known = SITES.some(site => site.file === '.config/dotnet-tools.json' && site.id === id);

    if (!known) unregistered.push(`.config/dotnet-tools.json: ${id}`);
}

for (const place of unregistered) {
    failed = true;
    console.error(`${place} names a version scripts/versions.js does not know`);
}

if (failed) {
    console.error('\nEdit versions.json and run node scripts/sync-versions.js.');
}

process.exit(failed ? 1 : 0);
