#!/usr/bin/env bash
# Prepares web resources for the jafar-web build:
#   1. Generates reflect-config.json for GraalVM native-image
#   2. Downloads external JS/CSS libraries to web/lib/ (cached)
# Usage: prepare-web-resources.sh <jafar-parser-jar-path> <output-dir>
set -euo pipefail

JAR="$1"
OUT_DIR="$2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/web/lib"

mkdir -p "$LIB_DIR"

# ── 1. reflect-config.json ──────────────────────────────────────────────

mkdir -p "$OUT_DIR"

echo '[' > "$OUT_DIR/reflect-config.json"

jar tf "$JAR" \
  | grep '\.class$' \
  | grep -E '^io/jafar/' \
  | grep -v 'package-info' \
  | grep -v '\$' \
  | sed 's|/|.|g; s|\.class$||' \
  | sort \
  | while IFS= read -r cls; do
      echo "  {"
      echo "    \"name\": \"$cls\","
      echo "    \"allDeclaredConstructors\": true,"
      echo "    \"allDeclaredMethods\": true,"
      echo "    \"allDeclaredFields\": true,"
      echo "    \"allPublicConstructors\": true,"
      echo "    \"allPublicMethods\": true,"
      echo "    \"allPublicFields\": true"
      echo "  },"
    done \
  | sed '$ s/,$//' \
  >> "$OUT_DIR/reflect-config.json"

echo ']' >> "$OUT_DIR/reflect-config.json"

echo "Generated reflect-config.json with $(grep -c '"name"' "$OUT_DIR/reflect-config.json") entries"

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
