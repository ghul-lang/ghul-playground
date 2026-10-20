// Writes every place the playground names a tool version from versions.json,
// the one list of what the site runs. Run it after editing versions.json, or
// let bump-versions.js do both.
//
//   node scripts/sync-versions.js

const { SITES, wanted } = require('./versions');

const versions = wanted();

for (const site of SITES) {
    const before = site.read();
    const version = versions[site.tool];

    if (before === undefined) {
        throw new Error(`${site.file}: no ${site.tool} version to update`);
    }

    if (before !== version) {
        site.write(version);
        console.log(`${site.tool}: ${before} -> ${version}  ${site.file}`);
    }
}
