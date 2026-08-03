#!/usr/bin/env bash
# Prepares web resources for the jafar-web build:
#   1. Generates reflect-config.json for GraalVM native-image
#   2. Downloads external JS/CSS libraries to web/lib/ (cached)
# Usage: prepare-web-resources.sh <jafar-parser-jar> <output-dir> [extra-jar ...]
set -euo pipefail

JAR="$1"
OUT_DIR="$2"
shift 2
EXTRA_JARS=("$@")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/web/lib"

mkdir -p "$LIB_DIR"

# ── 1. reflect-config.json ──────────────────────────────────────────────

mkdir -p "$OUT_DIR"

# Collect class names from a JAR, optionally filtered by package prefix.
collect_from_jar() {
  local jar="$1"
  local filter="${2:-}"
  local stream
  stream=$(jar tf "$jar" | grep '\.class$' | grep -v 'package-info')
  if [ -n "$filter" ]; then
    stream=$(echo "$stream" | grep -E "^${filter}" || true)
  fi
  echo "$stream" | sed 's|/|.|g; s|\.class$||'
}

# Build a temp file with one class name per line then generate JSON via Python.
TMP_CLASSES=$(mktemp)
TMP_LZ4=$(mktemp)
trap 'rm -f "$TMP_CLASSES" "$TMP_LZ4"' EXIT

collect_from_jar "$JAR" 'io/jafar/' >> "$TMP_CLASSES"
for extra in "${EXTRA_JARS[@]}"; do
  [ -f "$extra" ] || continue
  # Register me.bechberger.* classes with full reflection (allDeclaredMethods etc).
  collect_from_jar "$extra" 'me/bechberger/' >> "$TMP_CLASSES"
  # Register net.jpountz.* (lz4-java) classes with constructors+fields only —
  # NOT allDeclaredMethods, which makes VarHandleDoubles/Floats CAS reachable
  # and breaks the GraalVM WASM compiler.
  collect_from_jar "$extra" 'net/jpountz/' >> "$TMP_LZ4"
done

python3 - "$OUT_DIR/reflect-config.json" "$TMP_CLASSES" "$TMP_LZ4" <<'PYEOF'
import sys, json

out_path = sys.argv[1]
classes_file = sys.argv[2]
with open(classes_file) as f:
    classes = sorted({l.strip() for l in f if l.strip()})

# Exclude condenser-side classes that have float/double fields. Registering
# them with allDeclaredMethods makes VarHandleDoubles/Floats CAS entry points
# reachable, which GraalVM WASM cannot compile.
CONDENSER_EXCLUDES = (
    "me.bechberger.jfr.BasicJFRWriter",
    "me.bechberger.jfr.CombinerSpec",
    "me.bechberger.jfr.EventCombiner",
    "me.bechberger.jfr.EventDeduplication",
    "me.bechberger.jfr.FastChunkWriter",
    "me.bechberger.jfr.JFREventCombiner",
    "me.bechberger.jfr.JFREventDeduplication",
    "me.bechberger.jfr.JFREventTypedValueCombiner",
    "me.bechberger.jfr.JFRHashConfig",
    "me.bechberger.jfr.WritingJFRReader",
    "me.bechberger.jfr.TypeUtil",
    "me.bechberger.jfr.TypedValueUtil",
)
classes = [c for c in classes if not any(c == ex or c.startswith(ex + "$") for ex in CONDENSER_EXCLUDES)]

full_entry = {
    "allDeclaredConstructors": True,
    "allDeclaredMethods": True,
    "allDeclaredFields": True,
    "allPublicConstructors": True,
    "allPublicMethods": True,
    "allPublicFields": True,
}
config = [{"name": c, **full_entry} for c in classes]

# lz4-java (net.jpountz.*) classes are loaded reflectively by LZ4Factory/XXHashFactory.
# Register constructors+fields only — NOT allDeclaredMethods, which would make
# VarHandleDoubles/Floats CAS entry points reachable and break the WASM compiler.
lz4_entry = {
    "allDeclaredConstructors": True,
    "allPublicConstructors": True,
    "allDeclaredFields": True,
    "allPublicFields": True,
}
lz4_classes_file = sys.argv[3]
with open(lz4_classes_file) as f:
    lz4_classes = sorted({l.strip() for l in f if l.strip()})
config.extend({"name": c, **lz4_entry} for c in lz4_classes)

with open(out_path, "w") as f:
    json.dump(config, f, indent=2)
print(len(config))
PYEOF

COUNT=$(python3 -c "import json; print(len(json.load(open('$OUT_DIR/reflect-config.json'))))")
echo "Generated reflect-config.json with $COUNT entries"

# ── 2. Download external libraries (cached) ──────────────────────────────

HLJS_VERSION="11.9.0"
HLJS_BASE="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VERSION}"

declare -A FILES=(
  ["highlight.min.js"]="${HLJS_BASE}/highlight.min.js"
  ["github-dark.min.css"]="${HLJS_BASE}/styles/github-dark.min.css"
)

for name in "${!FILES[@]}"; do
  dest="$LIB_DIR/$name"
  if [ -f "$dest" ]; then
    continue
  fi
  echo "Downloading $name …"
  curl -fsSL -o "$dest" "${FILES[$name]}"
done

echo "Libraries ready in web/lib/"
