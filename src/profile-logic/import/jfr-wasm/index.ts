/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// WASM bridge for the in-browser JFR parser + converter (jfrtofp).
//
// jfrtofp.js + jfrtofp.js.wasm are loaded eagerly by a classic <script> tag
// injected into index.html by generateHtmlPlugin (only when JFR_CONVERTER is
// enabled at build time). See jfr-wasm/README.md for build details.
//
// The Java side does ALL the work in a single native call: it parses the JFR
// recording AND runs the full Profile conversion (event stream → Profile object),
// returning the resulting Profile JSON as a single string. The JS side
// `JSON.parse`s it once. This collapses the WASM↔JS boundary to one crossing.

interface JafarWASMModule {
  JFRParser: {
    parseToProfileJSON(binaryString: string): string;
  };
  CJFRParser: {
    parseToProfileJSON(binaryString: string): string;
  };
}

let wasmModule: JafarWASMModule | null = null;

async function loadWasm(): Promise<JafarWASMModule> {
  if (wasmModule) {
    return wasmModule;
  }
  // The classic <script src="jfrtofp.js"> tag injected by generateHtmlPlugin
  // bootstraps GraalVM asynchronously and eventually assigns globalThis.JFRParser
  // and globalThis.CJFRParser from inside the WASM module's main(). There is no
  // public Promise we can await on, so poll until both parsers appear (or time out).
  const startedAt = Date.now();
  while (true) {
    const g = globalThis as unknown as Record<string, unknown>;
    const jfrParser = g.JFRParser;
    const cjfrParser = g.CJFRParser;
    if (jfrParser && cjfrParser) {
      wasmModule = {
        JFRParser: jfrParser as JafarWASMModule['JFRParser'],
        CJFRParser: cjfrParser as JafarWASMModule['CJFRParser'],
      };
      return wasmModule;
    }
    if (Date.now() - startedAt > 30_000) {
      throw new Error(
        'jfrtofp WASM module did not initialize within 30 s. Make sure ' +
          'jfrtofp.js + jfrtofp.js.wasm are present in src/profile-logic/import/jfr-wasm/.'
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function parseJFRToProfile(
  fileBytes: Uint8Array
): Promise<unknown> {
  const wasm = await loadWasm();

  // parseToProfileJSON expects a binary string (FileReader.readAsBinaryString style)
  // so the Java side can do (byte)char at each index.
  //
  // Build it in chunks via fromCharCode.apply rather than `+=` per byte: the
  // naive loop is O(n²) (each `s += c` allocates a new string of length n)
  // and gets unusably slow past a few MB. 16 KB chunks keep us well under the
  // engine's argument-count limit while only allocating ~n/16384 strings.
  const binaryString = toBinaryString(fileBytes);

  const json = wasm.JFRParser.parseToProfileJSON(binaryString);
  return parseJsonResult(json, 'JFR');
}

/** Shared binary-string builder + JSON parse. */
function toBinaryString(fileBytes: Uint8Array): string {
  const CHUNK = 16 * 1024;
  const parts: string[] = [];
  for (let i = 0; i < fileBytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, fileBytes.length);
    parts.push(
      String.fromCharCode.apply(
        null,
        fileBytes.subarray(i, end) as unknown as number[]
      )
    );
  }
  return parts.join('');
}

function parseJsonResult(json: unknown, format: string): unknown {
  // GraalVM Web Image sometimes hands back a Java-string proxy rather than a
  // primitive JS string; coerce explicitly.
  const jsonStr = typeof json === 'string' ? json : String(json);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const head = jsonStr.slice(0, 200);
    const tail = jsonStr.slice(-100);
    throw new Error(
      `${format} converter returned non-JSON (length=${jsonStr.length}, ` +
        `type=${typeof json}). Head: ${JSON.stringify(head)} ` +
        `Tail: ${JSON.stringify(tail)}. Original: ${(e as Error).message}`
    );
  }
}

export async function parseCJFRToProfile(
  fileBytes: Uint8Array
): Promise<unknown> {
  const wasm = await loadWasm();
  const binaryString = toBinaryString(fileBytes);
  const json = wasm.CJFRParser.parseToProfileJSON(binaryString);
  return parseJsonResult(json, 'CJFR');
}
