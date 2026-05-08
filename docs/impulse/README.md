# Impulse Documentation

This directory contains the documentation site for Impulse, built with [Docusaurus 3](https://docusaurus.io/).

## Prerequisites

- **Node.js**: Version 20.0 or higher
- **npm**: Comes bundled with Node.js

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Development Server

For development with hot reloading:

```bash
npm run docusaurus start
```

**Note**: The default `npm start` script builds and serves the production version. For development, use the command above.

Keep in mind the search functionallity is only working with ```bash npm start```.

### 3. View Documentation

Open your browser and navigate to:
```
http://localhost:3000
```

The site will automatically reload when you make changes to the source files.

## Regenerating the API reference

The pages under `docs/references/api/` are auto-generated from the NumPy-style
docstrings in `src/` using [pydoc-markdown](https://niklasrosenstein.github.io/pydoc-markdown/).
The configuration lives at [`pydoc-markdown.yml`](./pydoc-markdown.yml) next to
this README.

Regenerate after any change to a documented public API. Run from this
directory (`docs/impulse/`):

```bash
uv --project ../.. run pydoc-markdown
```

This rewrites the `.md` files under `docs/references/api/` in place. Commit
the regenerated files alongside the source change so PR diffs show both the
code and doc updates.

> The working directory matters — pydoc-markdown's Docusaurus renderer
> resolves `docs_base_path` relative to cwd. Running it from anywhere other
> than `docs/impulse/` writes the generated files to the wrong location.

### Scope

`pydoc-markdown.yml` lists the modules to scan. Coverage is the curated
user-facing surface — what `demos/` notebooks and existing reference
pages import (`Report`, `Page`, `BasicEvent`, `HistogramDuration`,
config types in `mda_reporting.config`) — plus the production solvers
(`DeltaSolver`, `BasicNarrowSolver`, `KeyValueStoreSolver`),
`SolverConfig`, and the `QuerySolver` base class because solver names
appear in user configs. Internal persistence plumbing, the legacy
`BlobSolver`, the `InMemorySolver` test fixture, and `_private` symbols
are excluded. Add a new module to the `loaders.modules` list when you
introduce another user-facing class.

### Removing a module

Deleting a module from `loaders.modules` does **not** delete its old `.md`
file from `docs/references/api/`. Remove the stale file by hand and commit
the deletion.

### Why it isn't a build step

The generated `.md` files are committed to git (rather than produced fresh on
every Docusaurus build) so reviewers can see doc changes in PR diffs. There is
no Python step in the JS docs build — `npm run build` just reads the committed
files.
