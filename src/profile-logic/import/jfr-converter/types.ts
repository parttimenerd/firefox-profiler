/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Types for events emitted by the jafar WASM JFR parser.
// The WASM layer parses the binary JFR format and emits these flat structures;
// the TypeScript converter layer (this package) transforms them into a Profile.

export interface JFRFrame {
  methodName: string;
  className: string;
  descriptor: string;
  lineNumber: number;
  isJavaFrame: boolean;
}

export interface JFRThread {
  id: number;
  javaName: string | null;
  osName: string | null;
  virtual: boolean;
}

// All primitive field values from a JFR event, flattened by the WASM layer.
// Nested RecordedObject fields are dot-joined: "heapSpace.committedSize"
export type JFRFieldValue = string | number | boolean | null;

export interface ParsedJFREvent {
  type: string; // e.g. "jdk.ExecutionSample"
  startMs: number;
  endMs: number;
  stackTrace?: JFRFrame[];
  thread?: JFRThread;
  fields: Record<string, JFRFieldValue>;
}

export interface JFRMetadata {
  jvmVersion: string | null;
  jvmArgs: string | null;
  javaArgs: string | null;
  startMs: number;
  endMs: number;
  cpuModel: string | null;
  cpuCores: number | null;
  cpuHwThreads: number | null;
  osVersion: string | null;
  pid: number;
}

// Internal converter types (not emitted by WASM)

export type Milliseconds = number;
export type Percentage = number;

export interface StackEntry {
  frameIndex: number;
  prefixIndex: number | null;
}
