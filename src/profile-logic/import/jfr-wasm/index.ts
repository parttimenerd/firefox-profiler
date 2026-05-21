/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// WASM bridge for the jafar JFR parser.
//
// This module loads the GraalVM-compiled WASM (jafar.js + jafar.js.wasm) and
// exposes a Promise-based API for parsing JFR binary data.
//
// The WASM must expose the following JS-callable methods (added to jafar-ex):
//   JFRParser.parseJFR(bytesArray, callback)   — calls callback(event) for each event, null to finish
//   JFRParser.getMetadata()                     — returns metadata object after parseJFR completes
//
// If the WASM is not available (JFR_CONVERTER_ENABLED=false), this module is
// never imported (tree-shaken by esbuild).

import type { ParsedJFREvent, JFRMetadata } from '../jfr-converter/types';
import type { JFREventTypeInfo } from '../jfr-converter/marker-schemas';

export interface ParseResult {
  events: ParsedJFREvent[];
  eventTypeInfoMap: Map<string, JFREventTypeInfo>;
  metadata: JFRMetadata;
}

// Dynamically loaded WASM module interface (matches what jafar-ex exposes)
interface JafarWASMModule {
  JFRParser: {
    parseJFR(binaryString: string, callback: unknown): void;
    getMetadata(): unknown;
  };
}

let wasmModule: JafarWASMModule | null = null;

async function loadWasm(): Promise<JafarWASMModule> {
  if (wasmModule) {
    return wasmModule;
  }
  // jafar.js is copied to the root of dist/ (same level as index.html).
  // Use an absolute URL built from PUBLIC_PATH so the import works correctly
  // regardless of which sub-directory the caller chunk lives in.
  const jafarJsUrl = (process.env.PUBLIC_PATH ?? '/') + 'jafar.js';
  await import(/* @vite-ignore */ /* webpackIgnore: true */ jafarJsUrl);
  // GraalVM bootstrap sets up the module on globalThis
  const mod = (globalThis as unknown as Record<string, unknown>).JFRParser;
  if (!mod) {
    throw new Error(
      'jafar WASM module did not initialize. Make sure jafar.js.wasm is present.'
    );
  }
  wasmModule = { JFRParser: mod as JafarWASMModule['JFRParser'] };
  return wasmModule;
}

export async function parseJFR(fileBytes: Uint8Array): Promise<ParseResult> {
  const wasm = await loadWasm();

  // JFRParser.parseJFR expects a binary string (like FileReader.readAsBinaryString)
  // Convert Uint8Array → binary string so the Java side can do (byte)char at each index.
  let binaryString = '';
  for (let i = 0; i < fileBytes.length; i++) {
    binaryString += String.fromCharCode(fileBytes[i]);
  }

  const events: ParsedJFREvent[] = [];
  const eventTypeInfoMap = new Map<string, JFREventTypeInfo>();

  await new Promise<void>((resolve, reject) => {
    try {
      wasm.JFRParser.parseJFR(binaryString, (event: ParsedJFREvent | null) => {
        if (event === null) {
          resolve();
          return;
        }
        events.push(event);

        // Build eventTypeInfoMap on the fly from events if not separately provided
        // (the WASM may also send type metadata via a special event type)
        if (!eventTypeInfoMap.has(event.type)) {
          // Synthesize a minimal JFREventTypeInfo from the event shape.
          // Ideally, the WASM sends full metadata; this is the fallback.
          const fieldNames = Object.keys(event.fields).filter(
            (k) => !k.includes('.')
          );
          eventTypeInfoMap.set(event.type, {
            name: event.type,
            label: event.type.replace(/^jdk\./, ''),
            description: undefined,
            categoryNames: [guessCategoryFromEventType(event.type)],
            fields: fieldNames.map((name) => ({
              name,
              typeName: 'string',
              contentType: null,
              label: name,
            })),
            hasStackTrace:
              event.stackTrace !== undefined && event.stackTrace.length > 0,
          });
        }
      });
    } catch (e) {
      reject(e);
    }
  });

  const rawMeta = wasm.JFRParser.getMetadata() as Partial<JFRMetadata>;
  const metadata: JFRMetadata = {
    jvmVersion: rawMeta.jvmVersion ?? null,
    jvmArgs: rawMeta.jvmArgs ?? null,
    javaArgs: rawMeta.javaArgs ?? null,
    startMs: rawMeta.startMs ?? events[0]?.startMs ?? 0,
    endMs: rawMeta.endMs ?? events[events.length - 1]?.endMs ?? 0,
    cpuModel: rawMeta.cpuModel ?? null,
    cpuCores: rawMeta.cpuCores ?? null,
    cpuHwThreads: rawMeta.cpuHwThreads ?? null,
    osVersion: rawMeta.osVersion ?? null,
    pid: rawMeta.pid ?? -1,
  };

  return { events, eventTypeInfoMap, metadata };
}

// Guess a JFR category display name from event type for fallback
function guessCategoryFromEventType(eventType: string): string {
  if (
    eventType.startsWith('jdk.GC') ||
    eventType.includes('GarbageCollection')
  ) {
    return 'Java Virtual Machine, GC, Collector';
  }
  if (
    eventType.startsWith('jdk.Compiler') ||
    eventType.includes('Compilation')
  ) {
    return 'Java Virtual Machine, Compiler';
  }
  if (eventType.includes('Thread')) {
    return 'Java Application';
  }
  if (
    eventType.includes('Socket') ||
    eventType.includes('File') ||
    eventType.includes('IO')
  ) {
    return 'Operating System';
  }
  if (eventType.startsWith('jdk.CPU') || eventType.includes('CPULoad')) {
    return 'Operating System, Processor';
  }
  return 'Java Application';
}
