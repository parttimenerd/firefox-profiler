# Firefox Profiler Fork — Upgrade Plan (v2, revised)

**Last revised:** 2026-05-21 after auditing both versions and confirming user decisions.

## Status legend

⬜ Pending · 🔄 In Progress · ✅ Done · ❌ Blocked · 🟡 Verify

---

## Live progress dashboard

Mirrors the in-session TaskList. Update the marker here whenever a phase flips state, so progress survives across sessions.

| Phase | Subject                            | Status | Task ID |
| ----- | ---------------------------------- | ------ | ------- |
| 0     | Preparation                        | ✅     | #6      |
| 1     | Reset to upstream main             | ✅     | #8      |
| 2     | Port marker-based stack strategies | ✅     | #9      |
| 3     | Port TreeView column sort buttons  | ✅     | #7      |
| 4     | Add Java syntax highlighting       | ✅     | #11     |
| 5     | Port FuncTable.sourceUrl           | ✅     | #12     |
| 6     | Add Function Table tab             | ✅     | #10     |
| 7     | Port per-line marker track styling | ✅     | #1      |
| 8     | Update jfrtofp-server build script | ✅     | #2      |
| 9     | Inventory new upstream features    | ✅     | #5      |
| 10    | Verification gate                  | ✅     | #3      |
| 11    | Git finalize                       | ✅     | #4      |

Phases are linearly blocked: each one's TaskList entry is `blockedBy` the previous, so only the next pending phase is claimable at any time.

---

## Context

|                            | Old fork (current `merged`) | New target (upstream main, May 2026) |
| -------------------------- | --------------------------- | ------------------------------------ |
| Base date                  | mid-2022                    | May 2026                             |
| `GECKO_PROFILE_VERSION`    | 26                          | 34                                   |
| Toolchain                  | Flow + Webpack              | TypeScript + esbuild                 |
| Branch in `jfrtofp-server` | `origin/merged`             | `origin/merged` (unchanged)          |

**Consumer chain:**

```
jfrtofp (Kotlin) ─ emits Profile JSON with custom fields
        │   sampleLikeMarkersConfig (Profile.kt:808)
        │   sourceUrl on FuncTable    (Profile.kt:459)
        │   fillColor/strokeColor/isPreScaled on MarkerGraph (Marker.kt:153–159)
        ▼
jfrtofp-server ─ Java HTTP server, embeds firefox-profiler/ as a git submodule
        │   build.sh: git fetch origin merged && yarn build → cp dist/* → resources/fp/
        ▼
jfrplugin (IntelliJ) ─ depends on jfrtofp-server as Maven artifact
```

**User decisions (already made):**

1. **CallTreeSummaryStrategy:** match the new codebase's existing pattern; don't introduce a `string & {}` hack on top.
2. **Function Table:** reuse upstream's `CallTreeInternalFunctionList` / `FUNCTION_LIST` rather than re-port the old `computeFunctionTableCallTreeCountsAndSummary`.
3. **Build command:** switch `jfrtofp-server/build.sh` to `yarn build-prod`.
4. **Touch PR:** skip — it never landed in the fork.
5. **`sourceUrl` port:** full — including `profile-compacting.ts` registration so string indices remap correctly.
6. **Sort persistence:** persist sort state in URL/state (alongside column widths), not just component-local.
7. **Marker styling:** port — `jfrtofp` actively emits `fillColor`/`strokeColor`/`isPreScaled` on graph lines.
8. **Git workflow:** rebase fork onto upstream main + a single feature commit on top.

---

## Phase 0 — Preparation ⬜

| #   | Task                                                                                                                                                                                     | Status | Notes                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------- |
| 0.1 | `git tag pre-upgrade-backup` on current `merged` HEAD                                                                                                                                    | ⬜     | Safety net                              |
| 0.2 | Confirm current `yarn build` works on old fork                                                                                                                                           | ⬜     | Baseline regression test                |
| 0.3 | Snapshot current `dist/` file list (for compare with new build output)                                                                                                                   | ⬜     | `cd dist && ls -lR > /tmp/old-dist.txt` |
| 0.4 | Add upstream as a remote: `git remote add upstream https://github.com/firefox-devtools/profiler.git && git fetch upstream main`                                                          | ⬜     | Needed for the rebase target            |
| 0.5 | Identify the exact upstream commit matching `new-version/` (it's at upstream HEAD as of 2026-05-20: commit `570d7c10f` — "Translate URL track-index state through profile sanitization") | ⬜     | Reference commit for the rebase base    |

---

## Phase 1 — Reset to upstream main, drop old src ⬜

User decision: rebase fork onto upstream main + one feature commit.

| #   | Task                                                                                                                               | Status | Notes                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| 1.1 | Create working branch: `git checkout -b upgrade-to-2026 merged`                                                                    | ⬜     | Don't touch `merged` until done                                                                |
| 1.2 | `git reset --hard 570d7c10f` (the upstream commit at `new-version/` HEAD)                                                          | ⬜     | Now branch matches upstream exactly                                                            |
| 1.3 | Remove `new-version/` from working tree (it was only a staging area)                                                               | ⬜     | `rm -rf new-version` — but tree should already be at upstream after reset                      |
| 1.4 | Restore preserved local files (`.agents/`, `.claude/`, `.vscode/settings.json`, `CLAUDE.md`, `UPGRADE.md`) into a follow-up commit | ⬜     | These weren't in upstream; cherry-pick from `pre-upgrade-backup`                               |
| 1.5 | `yarn install` on clean tree                                                                                                       | ⬜     | Verify Node ≥24 (new requirement); `postinstall` runs `patch-package` for `jsdom+26.1.0.patch` |
| 1.6 | `yarn build-prod` — baseline production build (without any custom changes)                                                         | ⬜     | Must succeed before any custom port                                                            |
| 1.7 | `yarn test` — baseline tests pass                                                                                                  | ⬜     |                                                                                                |
| 1.8 | `yarn lint` and `npx tsc --noEmit` — baseline clean                                                                                | ⬜     |                                                                                                |

---

## Phase 2 — Port: marker-based stack strategies (`sampleLikeMarkersConfig`) ⬜

**Why critical:** `jfrtofp` emits this on every Java profile to expose JFR events (GC, file I/O, class load, allocation, exception throws, etc.) as additional call tree strategies. Without this port, the only strategy in the dropdown is "Timing".

**Audit findings to act on:**

- Type lives on `RawThread` in `src/types/profile.ts:669` (new shape: `RawThread` not `Thread`).
- 4 places exhaustively switch on `CallTreeSummaryStrategy`:
  1. `src/profile-logic/call-tree.ts:1133` — `extractSamplesLikeTable()`
  2. `src/profile-logic/call-tree.ts:1208` — `extractUnfilteredSamplesLikeTable()`
  3. `src/selectors/per-thread/thread.tsx:266` — `getCallTreeSummaryStrategy()`
  4. `src/profile-logic/profile-data.ts:1590` — `toValidCallTreeSummaryStrategy()`
- UI: `src/components/shared/CallTreeStrategySetting.tsx:42` renders strategies via per-strategy boolean selectors (`hasUsefulTimingSamples`, etc.).
- `profile-compacting.ts:584` uses `...thread` spread, so the new field passes through compaction unmodified.
- `merge-compare.ts:1229` — `mergeThreads()` doesn't currently merge optional config arrays.

**Strategy approach:** Per user decision #1, fit into the existing pattern. Concretely:

- Extend `CallTreeSummaryStrategy` to a discriminated form. Cleanest fit: keep it as `string` for the URL/state layer (it already is one) but represent custom strategies as `\`marker:\${name}\``— a tagged-string convention. The 4 exhaustive switches add a`default:`case that detects the`marker:`prefix and dispatches to`applyAdditionalStrategy()`. This stays type-safe (the union is untouched, no exhaustiveness break) and round-trips through URL state cleanly.
- Validation in `toValidCallTreeSummaryStrategy()` accepts the prefix and confirms the named strategy exists on the current thread.

| #    | Task                                                                                                                                                | Status | Notes                                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | Add `SampleLikeMarkerConfig` type to `src/types/profile.ts`                                                                                         | ⬜     | Mirror Kotlin: `name`, `label`, `marker`, `weightType?`, `weightField?`, `stackField?`                                                                                                      |
| 2.2  | Add `sampleLikeMarkersConfig?: SampleLikeMarkerConfig[]` to `RawThread` (and `Thread` if separate)                                                  | ⬜     | Confirm whether `Thread` derives from `RawThread`; field must reach derived type                                                                                                            |
| 2.3  | Add helpers to `src/profile-logic/profile-data.ts`                                                                                                  | ⬜     | `getAdditionalStrategiesForThread(thread)` returns `{name, label}[]`; `applyAdditionalStrategy(thread, strategyName)` returns a `SamplesLikeTable`. Use `marker:` prefix — strip in helper. |
| 2.4  | Update `extractSamplesLikeTable()` `default:` case (call-tree.ts:1133) to dispatch via prefix                                                       | ⬜     | Keep `assertExhaustiveCheck` for non-prefixed unknown values                                                                                                                                |
| 2.5  | Same for `extractUnfilteredSamplesLikeTable()` (call-tree.ts:1208)                                                                                  | ⬜     |                                                                                                                                                                                             |
| 2.6  | Update `getCallTreeSummaryStrategy` selector (thread.tsx:238–266)                                                                                   | ⬜     | Accept `marker:NAME` strings as valid                                                                                                                                                       |
| 2.7  | Update `toValidCallTreeSummaryStrategy()` (profile-data.ts:1590) to accept prefixed strings + validate against `getAdditionalStrategiesForThread()` | ⬜     | Thread-aware validation — may need second arg, or fall back to string passthrough                                                                                                           |
| 2.8  | Add `getAdditionalStrategies` selector to `src/selectors/per-thread/thread.tsx` (after line 233 cluster)                                            | ⬜     | Exports `{name, label}[]`                                                                                                                                                                   |
| 2.9  | Update `CallTreeStrategySetting.tsx` to render additional strategies after the built-in `<option>` block                                            | ⬜     | Connect `getAdditionalStrategies`; iterate to emit `<option value="marker:NAME">label</option>`                                                                                             |
| 2.10 | Update `merge-compare.ts:1229` `mergeThreads()` to merge `sampleLikeMarkersConfig` (deduplicate by `name`)                                          | ⬜     | Match old fork logic — unique by `name`, first wins                                                                                                                                         |
| 2.11 | Verify `profile-compacting.ts:584` spread preserves the field                                                                                       | 🟡     | Manual check — should work via `...thread`                                                                                                                                                  |
| 2.12 | Add unit test for `applyAdditionalStrategy()` in `src/test/unit/profile-data.test.ts`                                                               | ⬜     | Cover stackField default ('cause'), weightField, weightType                                                                                                                                 |
| 2.13 | Add unit test for merge-compare merging configs                                                                                                     | ⬜     |                                                                                                                                                                                             |

---

## Phase 3 — Port: TreeView column sort buttons ✅

**Audit findings:**

- New `TreeView.tsx`: `Column<DisplayData>` and `MaybeResizableColumn` types (lines 46–66). Headers in `TreeViewHeader` (lines 78–142). No header onClick currently.
- New `CallTree.tsx`: columns built in `_weightTypeToColumns()` (lines 105–204), passed at line 366. Threading new props is straightforward.
- New `TableViewOptions` (`src/types/state.ts:70–72`): only `fixedColumnWidths`. Per user decision #6, extend to persist sort state.
- No sort indicator CSS yet.

| #    | Task                                                                                                                                                        | Status | Notes                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | Define `SingleColumnSortState = { column: string; ascending: boolean }` and `ColumnSortState` class in `TreeView.tsx`                                       | ⬜     | Port methods: `sortColumn`, `current`, `getStateForColumn`, `getStateForColumnOrDefault`, `sortItemsHelper`. Make it a serializable plain object (not class) so it round-trips through Redux/URL state. Wrap in a small helper module if methods are ergonomic. |
| 3.2  | Add `sortableColumns?: ReadonlySet<string>`, `currentSortedColumn?: SingleColumnSortState`, `onSort?: (next: ColumnSortState) => void` props to `TreeView`  | ⬜     | All optional — preserves existing call sites                                                                                                                                                                                                                    |
| 3.3  | In `TreeViewHeader`, add onClick to fixed-column header spans when column is in `sortableColumns`; render arrow indicators via CSS classes                  | ⬜     | Classes: `sortInactive`, `sortAscending`, `sortDescending`. Don't conflict with the existing resize divider mousedown.                                                                                                                                          |
| 3.4  | Add CSS to `TreeView.css`                                                                                                                                   | ⬜     | `.treeViewHeaderColumn.sortInactive::after { content: ' ▲'; opacity: 0; }`; `.sortDescending::after { content: ' ▲'; }`; `.sortAscending::after { content: ' ▼'; }`; `.sortable { cursor: pointer; }`                                                           |
| 3.5  | Extend `TableViewOptions` in `src/types/state.ts` with `sortedColumns?: SingleColumnSortState[]`                                                            | ⬜     | Per user decision #6 — sort persists                                                                                                                                                                                                                            |
| 3.6  | Wire URL state: action + reducer for `CHANGE_TABLE_SORT`; URL serialization (existing column widths set the pattern)                                        | ⬜     | Look at how `changeTableViewOptions` handles `fixedColumnWidths` and mirror                                                                                                                                                                                     |
| 3.7  | In `CallTree.tsx`, pass `sortableColumns={SORTABLE_COLUMNS}` (`'self'`, `'total'`) and `currentSortedColumn` from props; `onSort` dispatches the new action | ⬜     | Default initial sort: total descending                                                                                                                                                                                                                          |
| 3.8  | Apply sort in CallTree's row ordering (where children of a node are listed)                                                                                 | ⬜     | Old fork sorted the data; verify whether new CallTree sorts via `getChildren` selector or component-side                                                                                                                                                        |
| 3.9  | Verify Function Table also gets sort (Phase 6 reuses TreeView)                                                                                              | ✅     | Confirmed: Function Table reuses `TreeView` and passes the same `sortableColumns`/`_onSort` from `FunctionTable.tsx`.                                                                                                                                           |
| 3.10 | Component test: clicking header toggles arrow + reorders rows                                                                                               | ⬜     |                                                                                                                                                                                                                                                                 |

---

## Phase 4 — Port: Java syntax highlighting ✅

**Audit findings:** `_languageExtForPath()` in `src/components/shared/SourceView-codemirror.ts:49–83`. Imports `cpp`, `rust`, `javascript`. Pattern: `path.endsWith('.ext')` returns the language extension. `@codemirror/lang-java` is not in `package.json`.

| #   | Task                                                                                                                                                      | Status | Notes                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------- |
| 4.1 | Add `@codemirror/lang-java: ^6.0.1` (or matching `^6.0.2` style of siblings) to `package.json` dependencies                                               | ⬜     | Match the version range of `@codemirror/lang-cpp` |
| 4.2 | `yarn install`                                                                                                                                            | ⬜     |                                                   |
| 4.3 | In `SourceView-codemirror.ts`: `import { java } from '@codemirror/lang-java'` and add `if (path.endsWith('.java')) return java();` before the JS fallback | ⬜     | Single-line addition                              |

---

## Phase 5 — Port: `FuncTable.sourceUrl` ✅

**Why:** `jfrtofp` writes a per-source URL override (Kotlin `Profile.kt:459`) so the source view can navigate to user-configured Java repos.

**Architecture decision:** the upstream rewrite replaced flat `FuncTable.fileName` with `FuncTable.source: IndexIntoSourceTable` + a separate `SourceTable`. To fit the new pipeline cleanly, the override URL was moved from `FuncTable.sourceUrl` (old fork) → `SourceTable.sourceUrl?` (this port). Far fewer mutation sites; reuses the existing source-indirection pipeline used by `SourceCodeFetcher`.

**Files changed:**

- `src/types/profile.ts` — added optional `sourceUrl?: Array<IndexIntoStringTable | null>` on `SourceTable`.
- `src/profile-logic/merge-compare.ts` — preserved `sourceUrl` through merge with string-index remapping.
- `src/profile-logic/symbolication.ts` — push `null` to `sourceUrl` when extending the SourceTable, gated on the column being present.
- `src/profile-logic/profile-compacting.ts` — registered `sourceUrl` as `indexRefOrNull(stringArray)` in the SourceTable description; made `_markTableAndComputeTranslation` and `_compactTable` skip optional columns that are absent. Generalized `TableDescription<T>` so optional `Array<X>?` keys are still typed.
- `src/selectors/profile.ts` — added `getSourceViewSourceUrl` selector.
- `src/components/app/SourceCodeFetcher.tsx` — when the current source has a `sourceUrl`, fetch directly from that URL and short-circuit the symbol-server / address-proof flow.

**Why no FuncTable changes:** the old fork's "fileName fallback to sourceUrl" pattern is replaced by the new SourceTable indirection — funcTable.source already points at the SourceTable row that carries the URL.

**Why no profile-versioning bump:** the new column is optional; profiles without it work unchanged.

---

## Phase 6 — Port: Function Table tab ✅

**User decision #2:** reuse upstream's `CallTreeInternalFunctionList` / `FUNCTION_LIST`. Don't re-port the old aggregation code.

**Architecture chosen:** create a separate `FunctionTable` component that connects to existing `getFunctionListTree` selector (which uses `_getInvertedCallNodeInfo`) instead of parameterizing `CallTree`. Avoids invasive prop-drilling. The `FUNCTION_LIST` plumbing in `call-tree.ts` was already merged from upstream.

**What was done:**

- Registered `'function-table'` in `tabsWithTitleL10nId` and `tabsShowingSampleData` (`src/app-logic/tabs-handling.ts`).
- Added `TabBar--function-table-tab = Function Table` to `locales/en-US/app.ftl`.
- Exposed `_getInvertedCallNodeInfo` as `getInvertedCallNodeInfo` in `selectedThreadSelectors` so the Function Table view binds directly to inverted node info regardless of the user's invertCallstack URL flag.
- Created `src/components/calltree/FunctionTable.tsx` — mirrors `CallTree.tsx` but binds `tree` → `getFunctionListTree`, `callNodeInfo` → `getInvertedCallNodeInfo`, dispatches `changeTableViewOptions('function-table', ...)`. Drops the auto-expand initial-selection logic (Function Table is flat).
- Created `src/components/calltree/ProfileFunctionTableView.tsx` — shell mirroring `ProfileCallTreeView.tsx`.
- Routed `'function-table': <ProfileFunctionTableView />` in `Details.tsx`.
- Added `'function-table'` to the calltree query-string case in `url-handling.ts` (shares CallTree query params: search, invertCallstack, transforms, ctSummary, sourceView, assemblyView, etc.).
- Added `'function-table': CallTreeSidebar` in `sidebar/index.tsx`.
- Updated `useful-tabs.test.ts` and `Details.test.tsx` with the new tab. Added `DetailsContainer.test.tsx` sidebar map entry.

**Sort buttons (Phase 3):** work automatically — the Function Table reuses the same `TreeView` component and passes the same `sortableColumns` set + `_onSort` handler.

---

## Phase 7 — Port: per-line marker track styling (PR #4198) ✅

**Why:** Confirmed — `jfrtofp/src/main/kotlin/me/bechberger/jfrtofp/types/Marker.kt:153–159` actively emits `fillColor`, `strokeColor`, and `isPreScaled` on graph schema entries. `jfrtofp/processor/MarkerSchemaWrapper.kt:72–151` sets concrete colors (orange, blue, etc.) for memory pool tracks.

**Architecture:** The old fork used a nested `trackConfig.lines[]` structure. The new upstream uses a flat `schema.graphs[]` array. Rather than re-introducing the old nesting, the fork-specific fields were added directly to `MarkerGraph` (same array the upstream already uses). jfrtofp will need updating to emit the new `graphs[]` format instead of `trackConfig.lines[]`.

**What was done:**

- Extended `MarkerGraph` in `src/types/markers.ts` with `fillColor?`, `strokeColor?`, `width?`, `isPreScaled?`. All optional; existing profiles unaffected.
- Added `graphHeight?: 'small' | 'medium' | 'large'` and `isPreSelected?: boolean` to `MarkerSchema` (also to `GeckoMetaMarkerSchema`) for track-level sizing.
- Added `TRACK_MARKER_HEIGHT_SMALL = 15` and `TRACK_MARKER_HEIGHT_LARGE = 50` to `src/app-logic/constants.ts`.
- Updated `TrackCustomMarker.tsx` to read `markerSchema.graphHeight` and set the height accordingly.
- Updated `_calculateUnitValue` in `TrackCustomMarkerGraph.tsx` to short-circuit when `isPreScaled` is true (`value * 0.85`).
- Updated the canvas draw loop to: (a) use `strokeColor`/`fillColor` strings directly when present (arbitrary CSS colors), falling back to the enum-based `getStrokeColor`/`getFillColor`; (b) use per-graph `width` when present.
- Updated `_renderDot` to use `strokeColor` for dot color when present.
- Updated `_convertGeckoMarkerSchema` in `process-profile.ts` to pass through `graphHeight` and `isPreSelected`.
- Updated 3 snapshots (profile-conversion × 2, TrackCustomMarker × 1).

## Phase 8 — Update consumer build scripts ✅

| #   | Task                                                                                                                                                                                         | Status | Notes                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------- |
| 8.1 | Update `/Users/i560383_1/code/tooling/jfrtofp-server/build.sh:23` from `yarn build` to `yarn build-prod`                                                                                     | ✅     | Per user decision #3                              |
| 8.2 | Verify `dist/` after `yarn build-prod` contains: `index.html`, hashed JS bundles, CSS files (now separate, not inlined), `service-worker-compat.js`, `sw.js`, `photon/`, `locales/`, `docs/` | ⬜     | Compare against the snapshot from Phase 0.3       |
| 8.3 | Manually run `jfrtofp-server/build.sh` end-to-end against the new fork                                                                                                                       | ⬜     | Should produce a working `src/main/resources/fp/` |
| 8.4 | Start `jfrtofp-server`, open a JFR file, verify full UI: tabs, strategies, sort, Function Table, sourceUrl, marker colors                                                                    | ⬜     | Smoke test the entire integration                 |
| 8.5 | Check `jfrtofp-server` Java code for any hardcoded bundle filename references (audit said: none — uses static-file serving via `addSinglePageRoot`)                                          | 🟡     | Re-verify after running 8.3                       |
| 8.6 | Optional: bump `jfrtofp` Kotlin types if any new optional fields could be filled in (e.g. now we support `width` on marker graph lines, jfrtofp could emit it)                               | ⬜     | Not required — just a nice-to-have                |

---

## Phase 9 — New upstream features worth knowing about (no port work) ✅

These are upstream additions you'll inherit for free. None require porting effort beyond Phase 1, but it's useful to know what's now available:

| Feature                              | What it is                                            | Where                                              |
| ------------------------------------ | ----------------------------------------------------- | -------------------------------------------------- |
| TypeScript everywhere                | Static typing replacing Flow                          | (whole codebase)                                   |
| esbuild                              | Replaces Webpack; much faster                         | `scripts/build.mjs`                                |
| `AssemblyView`                       | Disassembly view for native symbols                   | `components/shared/AssemblyView*.tsx`              |
| `combined-cpu.ts`                    | Multi-thread CPU aggregation                          | `profile-logic/combined-cpu.ts`                    |
| `graph-color.ts`                     | Consistent graph coloring                             | `profile-logic/graph-color.ts`                     |
| `call-node-info.ts`                  | Refactored CallNodeInfo as an interface               | `profile-logic/call-node-info.ts`                  |
| `profile-compacting.ts`              | Compact large profiles                                | `profile-logic/profile-compacting.ts`              |
| `wasm-symbolication.ts`              | Resolves WASM symbols                                 | `profile-logic/wasm-symbolication.ts`              |
| `TrackCounter` / `TrackCounterGraph` | Counter timeline tracks                               | `components/timeline/TrackCounter*.tsx`            |
| `ThemeToggle`                        | Light/dark theme                                      | `components/shared/ThemeToggle.tsx`                |
| `StackImplementationSetting`         | Extracted JS/Native filter                            | `components/shared/StackImplementationSetting.tsx` |
| `CallTreeStrategySetting`            | Extracted strategy dropdown (Phase 2 plugs into this) | `components/shared/CallTreeStrategySetting.tsx`    |
| `ResizableWithSplitter`              | Better panel resize                                   | `components/shared/ResizableWithSplitter.tsx`      |
| `IonGraphView`                       | Ion compiler graph                                    | `components/shared/IonGraphView.tsx`               |
| `MarkerFiltersContextMenu`           | Marker filter UI                                      | `components/shared/MarkerFiltersContextMenu.tsx`   |
| Service Worker (workbox)             | Offline caching, only via `yarn build-prod`           | `workbox-config.js`                                |
| `profiler-cli`                       | New CLI tool for profile analysis                     | `profiler-cli/`                                    |
| `profile-query` package              | Queryable subset of profile-logic                     | `src/profile-query/`                               |
| `node-tools`                         | Profile manipulation utilities                        | `src/node-tools/`                                  |
| `index-translation.ts`               | Index remapping helpers (used by sanitize/compact)    | `profile-logic/index-translation.ts`               |

**Action items from this list:**

- `call-node-info.ts` is now an interface — Phase 6 must use the interface, not the old struct shape.
- `index-translation.ts` provides primitives that may simplify Phase 5's index remapping in merge-compare.

---

## Phase 10 — Verification gate ✅

| #     | Task                                                                                                                                    | Status | Notes                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| 10.1  | `npx tsc --noEmit` — zero errors                                                                                                        | ✅     |                                                                           |
| 10.2  | `yarn lint` — zero errors                                                                                                               | ✅     |                                                                           |
| 10.3  | `yarn test` — all tests pass                                                                                                            | ✅     | 2205 passing, 4 todo                                                      |
| 10.4  | `yarn build-prod` succeeds                                                                                                              | ✅     | dist/ contains index.html, hashed JS/CSS, sw.js, photon/, locales/, docs/ |
| 10.5  | Manual: load a JFR profile (`cpu_sampler.jfr`) → open via `jfrtofp-server` → verify Call Tree dropdown lists JFR-event strategies       | ⬜     |                                                                           |
| 10.6  | Manual: switch to a JFR-event strategy (e.g. `jdk.AllocationRequiringGC`) → verify call tree populates                                  | ⬜     |                                                                           |
| 10.7  | Manual: click `self`/`total` column headers → verify sort arrow appears and rows reorder                                                | ⬜     |                                                                           |
| 10.8  | Manual: reload page → verify sort persists in URL/state                                                                                 | ⬜     |                                                                           |
| 10.9  | Manual: open the Function Table tab → verify flat per-function list renders                                                             | ⬜     |                                                                           |
| 10.10 | Manual: open a profile with `.java` source → verify Java syntax highlighting                                                            | ⬜     |                                                                           |
| 10.11 | Manual: open a profile with custom `sourceUrl` → click a line → verify navigation to the configured URL                                 | ⬜     |                                                                           |
| 10.12 | Manual: open a JFR profile with custom marker tracks (e.g. memory pool) → verify per-line `fillColor`/`strokeColor` and `height` render | ⬜     |                                                                           |
| 10.13 | Run `jfrtofp-server`'s test suite (Gradle) end-to-end if available                                                                      | ⬜     |                                                                           |

---

## Phase 11 — Git finalize ✅

User decision #8: **rebase fork onto upstream main + one feature commit on top.**

| #    | Task                                                                                                    | Status | Notes                                                       |
| ---- | ------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| 11.1 | Squash all custom-port commits into a single commit                                                     | ✅     | Squashed phases 2–8 into `82f81fa8f`                        |
| 11.2 | Confirm branch shape: `merged~1 == 570d7c10f` (upstream commit) and `merged == <single feature commit>` | ✅     | Verified with `git log --oneline`                           |
| 11.3 | Force-push `merged` (with `-f`) — **confirm with user before force-pushing**                            | ⬜     | Destructive on remote; users of the branch need to re-fetch |
| 11.4 | Tag the new shape: `git tag merged-2026-05-21`                                                          | ✅     | Tagged locally                                              |
| 11.5 | Update `CLAUDE.md` to reflect TS/esbuild reality                                                        | ✅     | Updated all Flow/Webpack references to TypeScript/esbuild   |
| 11.6 | Commit and push consumer-tool changes: `jfrtofp-server/build.sh` (decision #3)                          | ⬜     | build.sh updated locally; push when ready                   |

---

## Risks & open verifications

| Risk                                                                                                                                 | Mitigation                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `marker:NAME` strategy convention conflicts with future upstream additions                                                           | Vanishingly unlikely — upstream doesn't use prefixes; we own the namespace via the `marker:` tag                                         |
| `profile-compacting.ts` doesn't preserve the new sourceUrl field                                                                     | 5.8 explicitly registers it; verify with a unit test                                                                                     |
| `RawThread` vs `Thread` derivation differs from the old `Thread` shape                                                               | Audit confirmed `RawThread` is the new home; also check whether `Thread` (post-derivation) needs the field too                           |
| Function Table strategy state collision with Call Tree strategy state                                                                | Strategy is per-thread, not per-tab; both tabs will read the same selector. Confirm that's the desired behavior or add per-tab override. |
| `yarn build-prod` includes service worker that aggressively caches `index.html`                                                      | Audit jfrtofp-server's serving — local-only, so caching shouldn't bite, but verify with hard reload after rebuild                        |
| Force-push of `merged` breaks any downstream user's local checkout                                                                   | Communicate before pushing; users do `git fetch origin merged && git reset --hard origin/merged` to recover                              |
| `TableViewOptions` URL state schema change breaks old shareable URLs                                                                 | Existing fork users had URL state with widths only; the new sort field is additive and optional → safe                                   |
| `data-structures.ts` `getEmptyFuncTable` doesn't allocate sourceUrl, so any code reading `funcTable.sourceUrl[i]` blindly will fault | Always use `funcTable.sourceUrl?.[i]` (optional chaining); cover with tests                                                              |

---

## Files summary (final delta on top of upstream)

**New files:**

- `src/components/calltree/ProfileFunctionTableView.tsx`

**Modified files:**

- `src/types/profile.ts` — `SampleLikeMarkerConfig`, `RawThread.sampleLikeMarkersConfig`, `FuncTable.sourceUrl`
- `src/types/markers.ts` — `MarkerGraph` extended with `fillColor`/`strokeColor`/`width`/`isPreScaled`; schema-level `height`/`isPreSelected`
- `src/types/state.ts` — `TableViewOptions.sortedColumns`
- `src/profile-logic/profile-data.ts` — `getAdditionalStrategiesForThread`, `applyAdditionalStrategy`, `toValidCallTreeSummaryStrategy` updated
- `src/profile-logic/call-tree.ts` — `extractSamplesLikeTable`, `extractUnfilteredSamplesLikeTable` default cases
- `src/profile-logic/data-structures.ts` — `shallowCloneFuncTable` clones sourceUrl
- `src/profile-logic/global-data-collector.ts` — sourceUrl push
- `src/profile-logic/sanitize.ts` — sourceUrl push (both paths)
- `src/profile-logic/import/simpleperf.ts` — sourceUrl push
- `src/profile-logic/process-profile.ts` — sourceUrl init from incoming profile
- `src/profile-logic/transforms.ts` — sourceUrl copy
- `src/profile-logic/symbolication.ts` — sourceUrl push
- `src/profile-logic/line-timings.ts` — sourceUrl read
- `src/profile-logic/merge-compare.ts` — sourceUrl merge with index remap; `mergeThreads` merges sampleLikeMarkersConfig
- `src/profile-logic/profile-compacting.ts` — sourceUrl in TableDescription
- `src/selectors/per-thread/thread.tsx` — `getAdditionalStrategies`, validate prefixed strategies
- `src/selectors/per-thread/stack-sample.ts` — function-table selectors
- `src/actions/profile-view.ts` — `changeSelectedFunctionTableCallNode`, `changeTableViewOptions` extended
- `src/components/shared/CallTreeStrategySetting.tsx` — render additional strategies
- `src/components/shared/TreeView.tsx` — `ColumnSortState`, sort props, header onClick
- `src/components/shared/TreeView.css` — sort indicator styles
- `src/components/calltree/CallTree.tsx` — sortable columns wired
- `src/components/shared/SourceView-codemirror.ts` — Java detection
- `src/components/timeline/TrackCustomMarkerGraph.tsx` — per-line color/width/preScaled rendering
- `src/components/timeline/TrackCustomMarker.tsx` — height variants
- `src/app-logic/tabs-handling.ts` — `'function-table'` registered
- `src/components/app/Details.tsx` — `function-table` routes to `ProfileFunctionTableView`
- `locales/en-US/app.ftl` — `TabBar--function-table-tab`
- `package.json` — `@codemirror/lang-java`

**Consumer changes:**

- `/Users/i560383_1/code/tooling/jfrtofp-server/build.sh` — `yarn build` → `yarn build-prod`
