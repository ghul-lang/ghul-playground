# ghūl playground

Edit [ghūl](https://ghul.dev) in the browser, with diagnostics, hover and
completion as you type. Compile it, and run it in the browser.

It runs at [ghul.dev/playground](https://ghul.dev/playground/), with a REPL at
[ghul.dev/repl](https://ghul.dev/repl/), and is embedded in the examples on
[ghul.dev](https://ghul.dev). The server compiles the source and
sends the assembly to the browser, which runs it. The server never runs what it
compiles. [docs/design.md](docs/design.md) explains the design and the limits.

## running it

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)
and [Node.js](https://nodejs.org/) 22 or later.

```sh
dotnet tool restore
npm install
```

`npm install` also stages the Monaco editor into the web app, which is not
committed.

The services are best run in their containers, because the limits are what
contain the compiler:

```sh
docker compose up --build -d
```

That brings up the compile service on `127.0.0.1:5090` and the analyse service
on `127.0.0.1:5091`. Then:

```sh
npm run web                 # http://127.0.0.1:5080
```

That runs a Release build, and has to: with threading enabled a Debug build's
runtime aborts on startup with `mono_wasm_start_deputy_thread_async() failed`,
so the page loads and nothing ever runs on it. Nothing is lost by it here - the
only C# is the interop shim, and the dev server sends the cross-origin
isolation headers either way.

Open <http://127.0.0.1:5080>. Edit the program and press **Compile and run**,
or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.

To run a service outside a container while working on it, `npm run
compile-service` and `npm run analyse-service` do that. The analyse service
needs `ghul-language-server` on `PATH`, which is published as an asset on the
[extension's releases](https://github.com/degory/ghul-vsce/releases).

## what works

Syntax highlighting, compile, run and output; and from the analyse service,
diagnostics as you type, hover, completion, semantic tokens and the narrowing
inlay hints. A diagnostic appears about 500 ms after a keystroke, 300 ms of
which is the debounce.

Not implemented: go to definition, references, rename, formatting and signature
help. The language server offers all of them, so they are wiring rather than
work.

## reading input

A program can read a line. `IO.Std.read_line` blocks until somebody types one
into the box that appears below the output, and what they type is echoed into
the transcript where a terminal would have echoed it. The box appears because
the program asked for a line and goes away when it stops asking, so a program
that never reads never shows one. Ctrl+D says there is no more input, which is
what a program reading until the stream ends is waiting for.

Output appears as it is written rather than when the run finishes, which is the
same mechanism seen from the other side.

Both need the page to be cross-origin isolated, because the runtime runs on a
worker thread and its heap is a `SharedArrayBuffer`. `dotnet run` sends the two
headers that grant that by itself; a deployed site needs them from its server,
and so does any site embedding the playground, since a frame is isolated only
when the page framing it is. [docs/design.md](docs/design.md) covers why it has
to be a worker thread at all.

An embedded playground has no box: it is part of this page's chrome, and an
embedding page has to offer its own. Until one does, a read there is answered
with end of input rather than left waiting.

## drawing

[`ghul.raster`](https://github.com/degory/ghul-raster) is on the reference list
beside the runtime, so a program can draw into an image and write a PNG. The
picture goes to the browser's own in-memory filesystem, which is emptied with
the tab; calling `show` on it prints the marker that brings it to the page,
where it appears over the editor and can be saved.

```ghul
image.write("plot.png");
image.show("plot.png");
```

`examples/draw.ghul` is a complete one, and is what the browser test draws.

A picture appears as soon as its marker is printed, while the program is still
running, and showing a name that is already on the page replaces that picture
in place. That is how a program animates: draw a frame, write it, show it
under the same name, pause, and repeat. `examples/bounce.ghul` does that, and
takes its pause from `GHUL_LIVE_IMAGES`, which the playground sets, so the same
program run under test or on a terminal does not wait between frames.

Output also honours a carriage return, which goes back to the start of the
line so that what follows writes over it, as a terminal does.

## opening and saving

**File** opens a `.ghul` file from the reader's machine and saves back to it,
through the File System Access API. Firefox and Safari have neither half of
that, so there opening reads a file through an `<input>` and saving downloads a
copy; the menu says which of the two it is offering. The handle of the file
last opened is kept in IndexedDB, so **Save** still knows where to write after
a reload.

None of that is what keeps a reader's work: the editor's contents go to local
storage on every edit and come back on load, so closing the tab loses nothing.
A file is for taking a program somewhere else.

## configuration

Everything is an environment variable read by `docker compose`, or by the
services directly when run outside it. None of these is set for local use.

| | |
| --- | --- |
| `PLAYGROUND_TOKENS` | comma-separated shared tokens; unset, the services are open, which is how ghul.dev runs them |
| `ALLOWED_ORIGINS` | the sites that may drive the services from a browser; unset, any |
| `MAX_CONCURRENT_COMPILES`, `MAX_QUEUED_COMPILES`, `COMPILE_TIMEOUT_MS` | compile service caps |
| `ILSPYCMD`, `MAX_VIEW_BYTES` | the disassembler `POST /compile/view` runs for the compiled-code tab, and the cap on a listing (256 KB); the image installs a pinned `ilspycmd` and sets the path |
| `REPL_ENABLED`, `MAX_CELLS`, `MAX_CHAIN_BYTES`, `CELL_CACHE_DIR`, `CELL_CACHE_BYTES`, `CELL_TOOLCHAIN_SALT` | session cells: off unless `REPL_ENABLED` is 1; see docs/design.md. The analyse service reads `REPL_ENABLED`, `MAX_CELLS` and `CELL_CACHE_DIR` too, and has to be given the directory the compile service writes |
| `GHUL_CORE_DIR`, `GHUL_CORE_VERSION`, `GHUL_RUNTIME_SOURCE_DIR`, `GHUL_RUNTIME_SOURCE_VERSION` | the ghul-core and ghul-runtime sources a `"target": "wasm"` compile builds against; unset, the compile service offers only .NET. The image sets them, at the tags `scripts/check-wasm-pins.js` checks against ghul-cli's pins |
| `MAX_SESSIONS`, `POOL_SIZE`, `IDLE_TIMEOUT_MS`, `MAX_SESSION_MS` | analyse service caps |

The reference assemblies user code can name are listed in
`shared/toolchain.js`, which both services read.

## opening a program by path

`/rosetta-code/<slug>` opens a solution from
[ghul-rosetta-code](https://github.com/ghul-lang/ghul-rosetta-code) in the editor,
and `/rosetta-code/<slug>/<NN-part>` opens one part of a task solved more than
one way. The page fetches the source from `raw.githubusercontent.com` in the
reader's browser, so nothing about the solutions is built into the site. The
program runs as soon as it has loaded, and a line under its output names the
task and links to its page on ghul.dev. A solution carrying a
`playground-unsupported` file is still loaded, with the reason it cannot run
shown in the output pane, and is not run.

A solution that reads files names them in a `playground-files` file beside its
source, one path per line relative to that directory. The page fetches each
one and writes it into the runtime's in-memory filesystem before every run, in
the working directory under its own name, which is where the program opens it.

Collections live in `web/wwwroot/collections.js`, each under its own path
prefix. A new one needs an entry there, its name in the base script at the top
of `index.html`, and a matching `location` in the nginx configuration, which
serves the entry page for every path under the prefix.

## where it is served from

The same build runs at the root of a host and below a path, such as
`/playground/` on ghul.dev. The page works out its base from its own path - cut
at a collection prefix, so a program opened by path finds its files - and
reaches everything, the compile and analyse services included, relative to it.
The services are expected beside the page on the same origin, as nginx puts
them. `test/nginx-stand-in.js` does the same locally, and CI runs the browser
test both at the root and below `/playground/` through it.

## embedding

`embed.html` is the editor with no chrome, meant to be framed by another site.
The frame owns only the editor: output, diagnostics and status are posted to the
parent, which renders them in whatever it already has.

Messages carry `channel: "ghul-playground"`. Origins are checked both ways: the
frame ignores messages from anywhere but an allowed parent, and replies only to
that parent's origin, never to `*`.

Parent to frame:

| type | |
| --- | --- |
| `init` | `{ source, theme }` - create the editor. Must not be sent before `loaded`. |
| `source` | `{ source }` - replace the program |
| `theme` | `{ theme }` - a Monaco theme name |
| `run` | compile and run |

Frame to parent:

| type | |
| --- | --- |
| `loaded` | the frame's script is running and listening |
| `ready` | the editor exists |
| `height` | `{ height }` - what the content needs; the frame cannot size itself |
| `status` | `{ state, detail }` - `compiling`, `starting runtime`, `running`, `done`, `failed`, `error` |
| `output` | `{ text }` - what the program wrote |
| `images` | `{ images }` - `{ name, url }` for each picture it drew, as data URLs; sent again as an animation replaces a picture, with the name unchanged |
| `diagnostics` | `{ diagnostics }` - from the compiler |
| `analyser` | `{ state }` - `ready`, `connecting` or `disconnected` |

**Wait for `loaded` before sending `init`.** `postMessage` is not queued, so a
parent that sends `init` while the frame is still loading loses it silently and
sees an editor that never appears.

## checking it works

Two harnesses, neither with dependencies of its own:

```sh
node test/analyser-stress.js        # can broken source stop the analyser answering?
node test/analyse-eviction.js      # does an address at its cap give up its quietest session? (see the file for the service settings)
node test/browser-end-to-end.js     # editor, analyser, compile and run, in a real browser
node test/live-output.mjs           # the image-marker handling on its own
```

Both take `ANALYSE_URL` / `BASE` and `TOKEN` to run against a deployment rather
than a local one. The browser test needs a Chrome or Chromium binary and takes
`CHROME` if it is not where Playwright puts it.

A run against a deployment would otherwise count itself, so the pages send no
analytics events when the URL carries `?notrack`, and the browser test opens
them that way. The one page in it that checks the events themselves is opened
without it and is served a stub counter instead, so nothing reaches the real
one either way.

## layout

| | |
| --- | --- |
| `web/` | the browser app: a .NET WebAssembly host plus the Monaco front end |
| `web/Program.cs` | the only C#: the `[JSExport]` glue the source generator needs, and nothing else (see the design notes) |
| `web/wwwroot/playground.js` | the editor wired to the services: diagnostics, hover, completion, compile, run |
| `web/wwwroot/main.js` | the standalone page's chrome around it |
| `web/wwwroot/embed.js` | embedded mode: the editor alone, framed by another site |
| `web/wwwroot/lsp.js` | the LSP client the two modes share |
| `web/wwwroot/ghul-language.js` | Monarch grammar and language configuration |
| `web/wwwroot/theme.js` | editor themes, matched to how ghul.dev renders a static example |
| `web/wwwroot/token.js` | the access token, and asking for one |
| `web/wwwroot/files.js` | opening and saving a `.ghul` file, and saving a drawing |
| `web/wwwroot/live-output.js` | the program's output as the page shows it: image markers turned into pictures as they arrive |
| `analyse-service/` | a WebSocket in front of one language server per editor |
| `compile-service/` | compiles posted source, returns an assembly, or a WebAssembly module and its loader when the request asks for `"target": "wasm"` |
| `shared/toolchain.js` | where the toolchain is, and the reference set |
| `shared/wasm-libraries.js` | the library sources a wasm compile builds against |
| `runner/` | the host, in ghūl: load, run, capture the output |
| `examples/` | small programs used to check the host by hand |
| `deploy/` | host setup and the nginx configuration |
| `docs/design.md` | why it is built this way |

## issues

[View open issues](https://github.com/degory/ghul/issues?q=is%3Aopen+is%3Aissue+label%3Aghul-playground) or [raise a new one](https://github.com/degory/ghul/issues/new?labels=ghul-playground).
