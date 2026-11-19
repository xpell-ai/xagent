# Experimental Host Facade

Gate D.1 adds an optional experimental trusted text turn delegate; see
[the bounded contract and neutral offline runbook](host-turn-delegate.md).
With that option omitted, the P2.2 behavior below is unchanged. The option does
not activate T1 tools, Router, durable profiles or plugins implicitly.

`@xpell/agent/adk/host` is an opt-in, **experimental, unpublished** Foundation
composition. It delegates to the existing Foundation and one XNode. It proves
native XVM loading of zero or one neutral, read-only system app; it is not a
second runtime or a complete application host.

**The `_profile` nesting and source-directory/SHA256 descriptor are provisional.**
They may be simplified before npm publication. The digest is an integrity check
for this experiment, not a finalized end-user authoring workflow or a permission
grant. Existing root, ADK, T1–T4 and P1 reference APIs remain unchanged.

## Running from an approved local artifact

Public npm Agent 2.0.8 lacks the ADK exports. Use a separately reviewed, exact
source-built artifact that contains `./adk/host`; the earlier P1 artifact does
not contain this implementation. Verify the new artifact checksum, packed Node
peer, ESM graph and native dependencies before running. This is not a public-npm
quickstart, release or production qualification.

The default `examples/host-agent.mjs` performs a mock turn with zero resources.
It requires no credentials, loads no environment file, listens on ephemeral
loopback, closes the Host, and removes only its own disposable parent directory.
Pass an explicitly approved canonical resource directory and its reviewed digest
as the example's two optional arguments to exercise the one-view profile.

```js
import { mockChannel, mockTextModel } from "@xpell/agent/adk";
import { createAgentHost } from "@xpell/agent/adk/host";

const host = createAgentHost({
  _profile: { _type: "foundation", _options: {
    _name: "reference-host",
    _model: mockTextModel({ _text: "Hello from the mock" }),
    _channel: mockChannel({ _id: "local" }),
    _host: { _work_folder: newAbsoluteWorkFolder,
      _listen: { _host: "127.0.0.1", _port: 0 } },
    _plugins: [],
  } },
  _system_apps: [],
});
try {
  await host.start();
  console.log(await host.testTurn({ _text: "hello" }));
} finally { await host.close(); }
```

## Trial resource subset

The optional `_system_apps` array contains at most one descriptor:
`{ _env: "default", _app_id, _source_dir, _sha256 }`. Paths must be explicit,
absolute, canonical paths with no symlink ancestry. The work folder must not
exist and must not overlap the source directory in either direction. Use a
stable operator-owned parent; this in-process library is not a filesystem
sandbox against an attacker concurrently replacing parent directories.

The directory contains **exactly** these two regular, singly linked files:

```text
app.json
views/view-main.json
```

`app.json` accepts only `_app_id`, `_env: "default"` and
`_meta: { _entry_view_id: "view-main" }`. The view accepts only
`{ _id: "view-main", _type: "view", _children: [] }`. Other safe kebab-case
app/view IDs up to 64 characters work when descriptor, filename and metadata
match. Reserved infrastructure IDs/prefixes are rejected. This first experiment
intentionally excludes nonempty child trees, event handlers, commands, flows,
entities, executable files, arbitrary app configuration and extra files.

The combined exact file bytes must be at most 64 KiB. Directory enumeration
stops at the first excess entry; file reads are bounded and use no-follow,
nonblocking handles with before/after identity checks. The digest is SHA256 over
entries sorted by POSIX relative filename: for each entry append UTF-8 filename,
NUL, decimal byte length, NUL, then exact file bytes. A matching digest says
nothing about source provenance or authorization to share its contents.

On explicit `start()`, after the existing exclusive host check, the library
captures and validates one immutable byte snapshot. It creates a derived source
root under the newly owned instance directory, writes that same snapshot, and
passes it to XNode's existing `_system_xapps_path` option. No source tree or
authoritative user-app files are rewritten. Native `server-xvm` list/get-app and
get-view commands verify the actual loaded system app, its one view and zero
flows/entities before Host readiness. XVM's existing system-app protection
rejects mutation; no new public XVM/Node seam or write API is added.

## Ownership, lifecycle and errors

Construction performs no filesystem, listener, model or provider I/O and rejects
unknown/proxy/accessor configuration. `start()` is coalesced while live;
`close()` immediately fences new mock turns, drains owned work and is terminal.
The resource port runs only in this new Foundation-only profile, never with a
durable adapter. Foreign and competing hosts are rejected without stopping their
Core or listeners. A fresh process is required after XNode shutdown.

`getStatus()` returns Host state, nested existing Agent status, resource state
and an optional safe code. Agent readiness and Channel readiness keep their
existing meanings. There is no exposed raw Node/store or independently closable
inner Agent. Errors expose safe codes only, with no raw filesystem path/cause.
Known Foundation busy/closed/not-ready codes are preserved; other startup and
cleanup failures become `E_ADK_HOST_START` / `E_ADK_HOST_CLEANUP`.

Every preflight directory/file handle closes in `finally`. Close drains the
Foundation and its owned XNode listeners/settings/storage, clears the resource
snapshot and marks it closed. **Instance and derived resource files are retained**
for inspection, including after partial startup; the library does not recursively
delete an operator path or unregister unrelated entities. Callers may separately
remove a disposable directory they created, as the example does. Cleanup failure
is reported, not retried or represented as proof all external work completed.

No routes, provider Channels, Router, model loop, plugins/grants, IAM, durable
Actions, existing-store adoption, migration, recovery worker or browser Console
are activated. Optional provider dependencies are not needed for this profile.
In-process application code remains trusted, not isolated by this facade.

## Offline verification

Use isolated Node 22/24 dependency graphs and native builds for each ABI. Package
build/type fixtures and tests can be run directly without pnpm workspace repair:

```sh
node node_modules/typescript/bin/tsc -p .
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2022 --module ES2022 --moduleResolution bundler --types node tests/host-consumer.ts
node --test tests/host.test.mjs
node --test tests/*.test.mjs
```

Host tests use synthetic directories and fresh subprocesses, block all outbound
connections, and permit only their own ephemeral loopback listeners. They cover
native loading/read-only enforcement, snapshots, path/symlink/hardlink/bounds,
resource collisions, partial failures, close races, active-turn drain and foreign
host preservation. Run the unchanged P1 clean consumer and the approved synthetic
downstream suite separately. Record any concurrent SDK fixture failure; an
isolated or serial pass does not establish its cause or erase that limitation.
