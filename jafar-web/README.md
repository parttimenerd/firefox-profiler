# jafar-web

GraalVM Web Image (WASM) module that compiles the [jafar](https://github.com/btraceio/jafar)
JFR parser to WebAssembly for use in the browser.

This module is the WASM layer of the **in-browser JFR converter** for the
`jfrtofp` branch of Firefox Profiler. The compiled WASM assets are loaded
on-demand when a user drops a `.jfr` file into the profiler.

## What it produces

- `web/jafar.js` — GraalVM bootstrap script (~100 KB)
- `web/jafar.js.wasm` — compiled WebAssembly binary (~12 MB)

These two files are copied into `src/profile-logic/import/jfr-wasm/` before
running `yarn build-prod`.

## Build requirements

- GraalVM 25 with `native-image` and `--tool:svm-wasm`
- Maven 3.9+

## Building

```sh
mvn package -DskipTests
```

Output lands in `web/`.

## Architecture

`WebMain.java` is the original DOM UI entry point. `JFRParser.java` is the
programmatic API exposed to the TypeScript bridge:

```
globalThis.JFRParser.parseJFR(binaryString, callback)
  → calls callback({ type, startMs, endMs, fields, thread, stackTrace })
    for each event, then callback(null) to signal completion

globalThis.JFRParser.getMetadata()
  → returns { jvmVersion, jvmArgs, javaArgs, startMs, endMs,
              cpuModel, cpuCores, cpuHwThreads, osVersion, pid }
```

The TypeScript bridge lives in `src/profile-logic/import/jfr-wasm/index.ts`.
