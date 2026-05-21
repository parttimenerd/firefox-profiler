# jfr-wasm

This directory holds the GraalVM-compiled WASM assets built from the `jafar-web/`
module at the root of this repository.

**Required files (not committed; build them from `jafar-web/`):**

- `jafar.js` — GraalVM bootstrap JS (~100 KB)
- `jafar.js.wasm` — compiled WASM binary (~12 MB)

**How to build locally:**

```sh
cd jafar-web
mvn package -DskipTests
cp web/jafar.js web/jafar.js.wasm \
  ../src/profile-logic/import/jfr-wasm/
```

Requires GraalVM 25 with the `native-image` and `svm-wasm` tools installed.

When `jafar.js.wasm` is present, `yarn build-prod` includes the JFR converter
(`JFR_CONVERTER_ENABLED=true`). Without it the build still succeeds — `.jfr` files
show a clear error message pointing here.

The CI `deploy-pages` job builds the WASM automatically before deploying to
GitHub Pages.
