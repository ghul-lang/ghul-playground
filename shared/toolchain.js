// Where the compiler, the runtime and the reference assemblies are, and which
// references user code is compiled and analysed against.
//
// Shared by both services deliberately. If the analyse service and the compile
// service disagreed about the reference set, the editor would report errors the
// build does not, or stay silent about errors the build reports. They have to
// be the same list.

const { readdir } = require('fs/promises');
const { existsSync } = require('fs');
const path = require('path');

// What user code can name. The host is published untrimmed, so every
// framework assembly is already downloaded by every visitor whatever this
// list says: the list is a compile-time whitelist, and adding to it costs
// no download.
//
// What may be named is what cannot reach the network, another process,
// native code, or code generated at run time. So `System.Net.Http` stays
// out - it is the browser's fetch, which makes every visitor's browser a
// network egress under our origin - and so do the rest of `System.Net`,
// `System.Diagnostics.Process`, `System.Data`, `System.Reflection.Emit`
// and `System.Linq.Expressions`.
// `System.Runtime.InteropServices.JavaScript` would let a program script
// the hosting page, and it is the one exclusion that matters to anyone but
// the author.
//
// This does NOT deny the filesystem: `System.Runtime` type-forwards the
// `System.IO` surface and cannot be dropped, so `IO.File.read_all_text`
// compiles under any set that also compiles ghūl. That is survivable only
// because compiled code runs in the browser, which has no host filesystem.
//
// The list has to be closed under assembly reference. A type whose signature
// names an assembly that is not loaded fails to materialise with a warning,
// and then reports as a missing member - `Regex` did exactly that while
// `System.Reflection.Emit.ILGeneration` was absent. The entries marked as
// closure are there for that reason and nothing names them directly.
const REFERENCES = [
    'System.Runtime',
    'System.Console',
    'System.Collections',
    'System.Collections.Concurrent',
    'System.Linq',
    'System.Memory',
    'System.Runtime.Extensions',
    'System.Runtime.Numerics',
    'System.Text.Json',
    'System.Text.RegularExpressions',
    // XML, which the XML tasks read and write. An external entity in a
    // document resolves against a host that has neither a filesystem nor
    // a network, so the usual hazard has nowhere to reach.
    'System.Xml.ReaderWriter',
    'System.Xml.XmlDocument',
    'System.Xml.XDocument',
    'System.Xml.XPath',
    'System.Xml.XPath.XDocument',
    'System.Security.Cryptography',
    'System.Collections.Immutable',
    'System.Numerics.Vectors',
    'System.Threading.Channels',
    'System.Web.HttpUtility',
    'System.Drawing.Primitives',
    'System.IO.Compression',
    'System.Threading',
    // The program runs on a worker thread, so Thread.sleep pauses it without
    // stopping the page - which is how an animation paces its frames.
    'System.Threading.Thread',
    'System.Threading.Tasks.Parallel',
    // closure of System.Text.RegularExpressions
    'System.Reflection.Emit.ILGeneration',
    'System.Diagnostics.StackTrace',
    'System.Reflection.Primitives',
    'System.Runtime.InteropServices',
    // closure of ghul-runtime, whose pipe functions read a TextReader or a
    // Stream: the surface is already reachable through System.Runtime
    'System.IO',
    // closure of System.Text.Json
    'System.IO.Pipelines',
    'System.Text.Encodings.Web',
    // closure of System.Xml.XPath.XDocument and System.Security.Cryptography
    'System.Xml.Linq',
    'System.Formats.Asn1',
    'System.Collections.NonGeneric',
    // closure of System.Web.HttpUtility
    'System.Collections.Specialized'
];

function highestVersion(versions) {
    const key = v => v.split(/[.-]/).map(p => (/^\d+$/.test(p) ? +p : -1));

    return versions.sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
        }
        return 0;
    }).pop();
}

async function resolveCompiler() {
    if (process.env.GHUL_COMPILER_DLL) {
        return process.env.GHUL_COMPILER_DLL;
    }

    const packages = path.join(process.env.HOME, '.nuget', 'packages', 'ghul.compiler');
    const version = highestVersion(await readdir(packages));

    return path.join(packages, version, 'tools', 'net10.0', 'any', 'ghul.dll');
}

// Must be the runtime the web app ships, not the copy bundled with the
// compiler: user code is compiled against this and then bound against whatever
// the browser loaded, so a mismatch fails at load time rather than at compile
// time.
async function resolveRuntime() {
    if (process.env.GHUL_RUNTIME_DLL) {
        return process.env.GHUL_RUNTIME_DLL;
    }

    const packages = path.join(process.env.HOME, '.nuget', 'packages', 'ghul.runtime');
    const version = highestVersion(await readdir(packages));

    return path.join(packages, version, 'lib', 'net10.0', 'ghul-runtime.dll');
}

// Drawing. Held to the same rule as the runtime: the web app ships this exact
// assembly, so what is compiled against here is what the browser binds.
//
// It is a ghūl library like any other and needs nothing from the host, which
// is the point - a program here draws into a buffer and writes a PNG in
// managed code, where a graphics stack would need a native library the wasm
// host does not have.
async function resolveRaster() {
    if (process.env.GHUL_RASTER_DLL) {
        return process.env.GHUL_RASTER_DLL;
    }

    const packages = path.join(process.env.HOME, '.nuget', 'packages', 'ghul.raster');
    const version = highestVersion(await readdir(packages));

    return path.join(packages, version, 'lib', 'net10.0', 'ghul-raster.dll');
}

async function resolveReferencePack() {
    if (process.env.GHUL_REFERENCE_PACK) {
        return process.env.GHUL_REFERENCE_PACK;
    }

    for (const root of ['/usr/lib/dotnet', '/usr/share/dotnet', process.env.DOTNET_ROOT]) {
        if (!root) continue;

        const packs = path.join(root, 'packs', 'Microsoft.NETCore.App.Ref');
        if (!existsSync(packs)) continue;

        // A newer SDK beside this one brings a pack for a later framework,
        // with no net10.0 directory in it, so take the highest that has one.
        const versions = (await readdir(packs))
            .filter(v => existsSync(path.join(packs, v, 'ref', 'net10.0')));

        if (versions.length === 0) continue;

        return path.join(packs, highestVersion(versions), 'ref', 'net10.0');
    }

    throw new Error('could not find Microsoft.NETCore.App.Ref; set GHUL_REFERENCE_PACK');
}

// Every reference as an absolute path: the ghūl assemblies first, then the
// framework ones. Both services build their arguments from this one list.
async function resolveReferencePaths() {
    const [referencePack, runtime, raster] = await Promise.all([
        resolveReferencePack(), resolveRuntime(), resolveRaster()
    ]);

    const paths = [runtime, raster, ...REFERENCES.map(r => path.join(referencePack, `${r}.dll`))];

    // A missing entry would not fail here: the compiler loads what it finds
    // and the gap surfaces later as a baffling missing member. Refuse to
    // start instead, so a renamed assembly is a failed deploy.
    const missing = paths.filter(p => !existsSync(p));
    if (missing.length > 0) {
        throw new Error(`reference assemblies not found: ${missing.join(', ')}`);
    }

    return paths;
}

module.exports = {
    REFERENCES,
    highestVersion,
    resolveCompiler,
    resolveRuntime,
    resolveRaster,
    resolveReferencePack,
    resolveReferencePaths
};
