# jfr-wasm

This directory holds the GraalVM-compiled WASM assets used by the in-browser
JFR importer ("jfrtofp"). The Java sources and Maven build live in
[`jafar/`](./jafar) inside this same directory — that module is a thin wrapper
around the [jafar JFR parser](https://github.com/btraceio/jafar) that adds the
event-stream → Firefox Profiler conversion and the JS/WASM glue.

**Required artifacts (not committed):**

- `jfrtofp.js` — GraalVM bootstrap JS (~100 KB)
- `jfrtofp.js.wasm` — compiled WASM binary (~12 MB)

**How to build locally:**

```sh
yarn build-jfr-wasm
```

This runs `mvn package -DskipTests` inside `jafar/` and copies the produced
`jafar/web/jfrtofp.js` and `jafar/web/jfrtofp.js.wasm` into this directory.

Requires GraalVM 25 with the `native-image` and `svm-wasm` tools installed
(`gu install native-image` and `gu install wasm` on a GraalVM JDK).

When `jfrtofp.js.wasm` is present, `yarn build-prod` includes the JFR converter
(`JFR_CONVERTER_ENABLED=true`). Without it the build still succeeds — `.jfr`
files show a clear error message pointing here.

The CI `deploy-pages` job runs `yarn build-jfr-wasm` automatically before
deploying to GitHub Pages.

## Debug build (opt-in)

```sh
yarn build-jfr-wasm-debug
```

Produces a ~22 MB WASM (vs ~12 MB) that keeps DWARF info + the WASM `name`
section + parameter/local names. Browser profilers and debuggers can then
show readable Java method names like `Tables.processFrames` instead of
`func$3429`. Runtime speed is unchanged — only the binary is larger.

Use this when profiling or debugging the converter itself. The default
`yarn build-jfr-wasm` (and CI) keep the symbol-stripped binary.

## Credits

The JFR binary parsing is provided by [jafar](https://github.com/btraceio/jafar)
(BTrace project). The `jafar/` Maven module here is the wrapper that exposes
jafar to the browser via GraalVM Web Image and runs the
event-stream → Firefox Profiler conversion in-process, in a single WASM call.

## Notes for future maintainers

**Don't try to pass `Uint8Array` directly via `@JS @JS.Coerce` returning `byte[]`.**
GraalVM Web Image (as of Oracle GraalVM 25.0.3) emits glue that references
`byteArrayHub` / `intArrayHub` / etc. but never defines them, so the first
call into any `_JSObject.extractByteArray` path throws
`ReferenceError: byteArrayHub is not defined` at runtime — even when
triggered internally by Web Image rather than user code. The current
binary-string round-trip (`String.fromCharCode.apply` chunked build on the
JS side, `charAt(i)` byte loop on the Java side) is the only reliable way to
hand JFR bytes across the boundary.

**Hot-path allocation discipline.** The Java converter (`jafar/src/main/java/me/bechberger/jafar/web/converter/`)
runs once per JFR event for hundreds of thousands of events. Any per-event
or per-frame allocation will dominate runtime. Specifically:

- `Tables.processFrames` takes parallel arrays (class, method, descriptor,
  line, isJava) — never reintroduce a per-frame wrapper object.
- `FrameTableWrapper.getFrame` and `StackTableWrapper.appendFrame` keep a
  1-element last-seen cache; identical adjacent frames skip the `HashMap`
  probe entirely.
- `Categories.subPacked` returns a `long` packing `(categoryIdx, subIdx)` —
  never go back to returning `int[2]`.
- `JsonWriter`'s array methods (`intArray`, `doubleArray`, `stringArray`, …)
  bypass per-element `prefix()` machinery — use them instead of looping
  with `value()` per element.
