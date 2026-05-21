/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Port of Tables.kt — all deduplication/indexing tables for the converter.

import { CategoryE, sub, fromCategoryName } from './categories';
import type { JFRConverterConfig } from './config';
import { isNonProjectPackage } from './config';
import type { JFRFrame, Milliseconds, Percentage } from './types';

// ---- String table ----

export class StringTableWrapper {
  private strings: string[] = [];
  private map = new Map<string, number>();

  get(str: string): number {
    let idx = this.map.get(str);
    if (idx === undefined) {
      idx = this.strings.length;
      this.strings.push(str);
      this.map.set(str, idx);
    }
    return idx;
  }

  toArray(): string[] {
    return this.strings;
  }
}

// ---- Source table ----

export class SourceTableWrapper {
  private ids: Array<string | null> = [];
  private filenames: number[] = []; // indices into string table
  private sourceUrls: Array<number | null> = [];
  private map = new Map<string, number>(); // key: `${filenameIdx}:${urlIdx}`

  constructor(private stringTable: StringTableWrapper) {}

  getOrCreate(
    filename: string | null,
    sourceUrl: string | null
  ): number | null {
    if (filename === null) {return null;}
    const filenameIdx = this.stringTable.get(filename);
    const urlIdx = sourceUrl !== null ? this.stringTable.get(sourceUrl) : null;
    const key = `${filenameIdx}:${urlIdx}`;
    let idx = this.map.get(key);
    if (idx === undefined) {
      idx = this.ids.length;
      this.ids.push(null);
      this.filenames.push(filenameIdx);
      this.sourceUrls.push(urlIdx);
      this.map.set(key, idx);
    }
    return idx;
  }

  toSourceTable() {
    const length = this.filenames.length;
    const hasSourceUrls = this.sourceUrls.some((u) => u !== null);
    return {
      length,
      id: [...this.ids],
      filename: [...this.filenames],
      startLine: new Array(length).fill(-1),
      startColumn: new Array(length).fill(-1),
      sourceMapURL: new Array(length).fill(null),
      sourceUrl: hasSourceUrls ? [...this.sourceUrls] : undefined,
    };
  }

  get size(): number {
    return this.filenames.length;
  }
}

// ---- Resource table ----

export class ResourceTableWrapper {
  private names: number[] = [];
  private hosts: Array<number | null> = [];
  private types: number[] = []; // 0=unknown, 5=url
  // key: `${typeName}:${isJava}`
  private map = new Map<string, number>();

  constructor(private stringTable: StringTableWrapper) {}

  getResource(typeName: string, isJava: boolean): number {
    const key = `${typeName}:${isJava}`;
    let idx = this.map.get(key);
    if (idx === undefined) {
      idx = this.names.length;
      this.names.push(this.stringTable.get(typeName.split('$')[0]));
      if (isJava) {
        this.hosts.push(this.stringTable.get(typeName));
        this.types.push(5);
      } else {
        this.hosts.push(null);
        this.types.push(0);
      }
      this.map.set(key, idx);
    }
    return idx;
  }

  toResourceTable() {
    const length = this.names.length;
    return {
      name: [...this.names],
      length,
      lib: new Array(length).fill(null),
      host: [...this.hosts],
      type: [...this.types],
    };
  }

  get size(): number {
    return this.names.length;
  }
}

// ---- Func table ----

export class FuncTableWrapper {
  private names: number[] = [];
  private isJss: boolean[] = [];
  private relevantForJss: boolean[] = [];
  private resources: number[] = [];
  private sources: Array<number | null> = [];
  private lineNumbers: number[] = [];
  // key: `${className}.${methodName}${descriptor}`
  private map = new Map<string, number>();
  private miscFunctions = new Map<string, number>();

  constructor(
    private stringTable: StringTableWrapper,
    private sourceTable: SourceTableWrapper,
    private resourceTable: ResourceTableWrapper
  ) {}

  getFunction(
    className: string,
    methodName: string,
    descriptor: string,
    isJava: boolean,
    lineNumber: number,
    sourceUrl: string | null
  ): number {
    const key = `${className}.${methodName}${descriptor}`;
    let idx = this.map.get(key);
    if (idx === undefined) {
      idx = this.names.length;
      const displayName = `${shortClassName(className)}.${methodName}${formatDescriptor(descriptor)}`;
      this.names.push(this.stringTable.get(displayName));
      this.isJss.push(isJava);
      this.relevantForJss.push(true);
      this.resources.push(this.resourceTable.getResource(className, isJava));
      this.sources.push(this.sourceTable.getOrCreate(className, sourceUrl));
      this.lineNumbers.push(lineNumber);
      this.map.set(key, idx);
    }
    return idx;
  }

  getMiscFunction(
    name: string,
    isNative: boolean,
    defaultUrl: string | null
  ): number {
    let idx = this.miscFunctions.get(name);
    if (idx === undefined) {
      idx = this.names.length;
      this.names.push(this.stringTable.get(name));
      this.isJss.push(isNative);
      this.relevantForJss.push(true);
      this.resources.push(-1);
      this.sources.push(this.sourceTable.getOrCreate(null, defaultUrl));
      this.lineNumbers.push(-1);
      this.miscFunctions.set(name, idx);
    }
    return idx;
  }

  toFuncTable() {
    const length = this.names.length;
    return {
      name: [...this.names],
      isJS: [...this.isJss],
      relevantForJS: [...this.relevantForJss],
      resource: [...this.resources],
      source: [...this.sources],
      length,
      lineNumber: [...this.lineNumbers],
      columnNumber: new Array(length).fill(null),
    };
  }

  get size(): number {
    return this.sources.length;
  }
}

// ---- Frame table ----

export class FrameTableWrapper {
  private categories: Array<number | null> = [];
  private subcategories: Array<number | null> = [];
  private funcs: number[] = [];
  private lines: Array<number | null> = [];
  // key: `${funcIdx}:${line}`
  private map = new Map<string, number>();
  private miscFrames = new Map<string, number>();

  constructor(
    private funcTable: FuncTableWrapper,
    private config: JFRConverterConfig
  ) {}

  getFrame(
    className: string,
    methodName: string,
    descriptor: string,
    lineNumber: number,
    isJavaFrame: boolean,
    sourceUrl: string | null
  ): number {
    const funcIdx = this.funcTable.getFunction(
      className,
      methodName,
      descriptor,
      isJavaFrame,
      -1,
      sourceUrl
    );
    const line = lineNumber === -1 ? null : lineNumber;
    const key = `${funcIdx}:${line}`;
    let idx = this.map.get(key);
    if (idx === undefined) {
      idx = this.funcs.length;
      let catIdx: number;
      let subIdx: number;
      if (
        this.config.useNonProjectCategory &&
        isJavaFrame &&
        isNonProjectPackage(getPackage(className), this.config)
      ) {
        [catIdx, subIdx] = sub(CategoryE.NON_PROJECT_JAVA, 'Other');
      } else if (isJavaFrame) {
        [catIdx, subIdx] = sub(CategoryE.JAVA, 'Other');
      } else {
        [catIdx, subIdx] = sub(CategoryE.CPP, 'Other');
      }
      this.categories.push(catIdx);
      this.subcategories.push(subIdx);
      this.funcs.push(funcIdx);
      this.lines.push(line);
      this.map.set(key, idx);
    }
    return idx;
  }

  getMiscFrame(
    name: string,
    categoryName: string,
    subcategoryName: string,
    isNative: boolean,
    _defaultUrl: string | null
  ): number {
    let idx = this.miscFrames.get(name);
    if (idx === undefined) {
      const catEntry = fromCategoryName(categoryName) ?? CategoryE.MISC;
      const [catIdx, subIdx] = sub(catEntry, subcategoryName);
      idx = this.funcs.length;
      this.categories.push(catIdx);
      this.subcategories.push(subIdx);
      this.funcs.push(this.funcTable.getMiscFunction(name, isNative, null));
      this.lines.push(null);
      this.miscFrames.set(name, idx);
    }
    return idx;
  }

  toFrameTable() {
    const length = this.funcs.length;
    return {
      category: [...this.categories],
      subcategory: [...this.subcategories],
      func: [...this.funcs],
      line: [...this.lines],
      length,
      address: new Array(length).fill(-1),
      inlineDepth: new Array(length).fill(0),
      nativeSymbol: new Array(length).fill(null),
      innerWindowID: new Array(length).fill(null),
      column: new Array(length).fill(null),
    };
  }

  get size(): number {
    return this.funcs.length;
  }
}

// ---- Stack table ----

export class StackTableWrapper {
  private frames: number[] = [];
  private prefixes: Array<number | null> = [];
  // Map from serialized frame-list key → stack index
  private map = new Map<string, number>();
  private miscStacks = new Map<string, number>();

  constructor(private frameTable: FrameTableWrapper) {}

  // stackFrames: array of frame indices, bottom-of-stack first (caller → callee)
  getStack(frameIndices: number[]): number {
    if (frameIndices.length === 0) {return -1;}
    // Build prefix chain from bottom to top
    let prefixIdx: number | null = null;
    let lastStackIdx = -1;
    for (const frameIdx of frameIndices) {
      const key = `${prefixIdx}:${frameIdx}`;
      let stackIdx = this.map.get(key);
      if (stackIdx === undefined) {
        stackIdx = this.frames.length;
        this.frames.push(frameIdx);
        this.prefixes.push(prefixIdx);
        this.map.set(key, stackIdx);
      }
      prefixIdx = stackIdx;
      lastStackIdx = stackIdx;
    }
    return lastStackIdx;
  }

  getMiscStack(name: string): number {
    let idx = this.miscStacks.get(name);
    if (idx === undefined) {
      const frameIdx = this.frameTable.getMiscFrame(
        name,
        'Misc',
        'Other',
        false,
        null
      );
      idx = this.frames.length;
      this.frames.push(frameIdx);
      this.prefixes.push(null);
      this.miscStacks.set(name, idx);
    }
    return idx;
  }

  toStackTable() {
    return {
      frame: [...this.frames],
      prefix: [...this.prefixes],
      length: this.frames.length,
    };
  }

  get size(): number {
    return this.frames.length;
  }
}

// ---- Shared Tables container ----

export class Tables {
  readonly stringTable = new StringTableWrapper();
  readonly sourceTable: SourceTableWrapper;
  readonly resourceTable: ResourceTableWrapper;
  readonly funcTable: FuncTableWrapper;
  readonly frameTable: FrameTableWrapper;
  readonly stackTable: StackTableWrapper;

  constructor(
    public readonly config: JFRConverterConfig,
    public readonly startTimeMs: number,
    public readonly defaultUrl: string | null = null
  ) {
    this.sourceTable = new SourceTableWrapper(this.stringTable);
    this.resourceTable = new ResourceTableWrapper(this.stringTable);
    this.funcTable = new FuncTableWrapper(
      this.stringTable,
      this.sourceTable,
      this.resourceTable
    );
    this.frameTable = new FrameTableWrapper(this.funcTable, config);
    this.stackTable = new StackTableWrapper(this.frameTable);
  }

  processFrames(rawFrames: JFRFrame[], sourceUrl: string | null): number {
    if (rawFrames.length === 0) {return -1;}
    // JFR gives frames top-of-stack first; Firefox Profiler wants bottom-first prefix chain.
    const reversed = [...rawFrames].reverse();
    const frameIndices = reversed.map((f) =>
      this.frameTable.getFrame(
        f.className,
        f.methodName,
        f.descriptor,
        f.lineNumber,
        f.isJavaFrame,
        sourceUrl
      )
    );
    return this.stackTable.getStack(frameIndices);
  }

  toSharedData() {
    return {
      stringArray: this.stringTable.toArray(),
      stackTable: this.stackTable.toStackTable(),
      frameTable: this.frameTable.toFrameTable(),
      funcTable: this.funcTable.toFuncTable(),
      resourceTable: this.resourceTable.toResourceTable(),
      nativeSymbols: {
        libIndex: [],
        address: [],
        name: [],
        functionSize: [],
        length: 0,
      },
      sources: this.sourceTable.toSourceTable(),
    };
  }
}

// ---- Samples table wrapper ----

export class SamplesTableWrapper {
  private stacks: number[] = [];
  private times: Milliseconds[] = [];

  processEvent(stackIndex: number, startMs: Milliseconds): void {
    this.stacks.push(stackIndex);
    this.times.push(startMs);
  }

  toSamplesTable(cpuLoadAtTime: (t: Milliseconds) => Percentage) {
    // Sort by time
    const order = Array.from({ length: this.times.length }, (_, i) => i).sort(
      (a, b) => this.times[a] - this.times[b]
    );
    const stack = order.map((i) => this.stacks[i]);
    const time = order.map((i) => this.times[i]);

    // threadCPUDelta in µs
    const threadCPUDelta: number[] = [0];
    for (let i = 1; i < time.length; i++) {
      if (i === time.length - 1) {
        threadCPUDelta.push(0);
      } else {
        threadCPUDelta.push(
          (time[i] - time[i - 1]) * 1000.0 * cpuLoadAtTime(time[i])
        );
      }
    }

    return {
      stack,
      eventDelay: new Array(stack.length).fill(0.0),
      time,
      weight: null,
      weightType: 'samples' as const,
      threadCPUDelta,
      length: stack.length,
    };
  }
}

// ---- Marker table wrapper ----

export interface MarkerItem {
  name: number; // string table index
  startTime: Milliseconds | null;
  endTime: Milliseconds | null;
  phase: number; // 0=instant, 1=interval
  category: number;
  data: Record<string, unknown>;
}

export class RawMarkerTableWrapper {
  private items: MarkerItem[] = [];

  add(item: MarkerItem): void {
    this.items.push(item);
  }

  toRawMarkerTable() {
    const sorted = [...this.items].sort(
      (a, b) => (a.startTime ?? 0) - (b.startTime ?? 0)
    );
    return {
      data: sorted.map((i) => i.data),
      name: sorted.map((i) => i.name),
      startTime: sorted.map((i) => i.startTime),
      endTime: sorted.map((i) => i.endTime),
      phase: sorted.map((i) => i.phase),
      category: sorted.map((i) => i.category),
      length: sorted.length,
    };
  }
}

// ---- Bytecode helpers ----

export function shortClassName(className: string): string {
  const dollarIdx = className.indexOf('$');
  const base = dollarIdx === -1 ? className : className.substring(0, dollarIdx);
  const dotIdx = base.lastIndexOf('.');
  return dotIdx === -1 ? base : base.substring(dotIdx + 1);
}

export function getPackage(className: string): string {
  const dollarIdx = className.indexOf('$');
  const base = dollarIdx === -1 ? className : className.substring(0, dollarIdx);
  const dotIdx = base.lastIndexOf('.');
  return dotIdx === -1 ? '' : base.substring(0, dotIdx);
}

// Simple descriptor parser — turns "(ILjava/lang/String;)[B" into "(int, String): byte[]"
export function formatDescriptor(descriptor: string): string {
  try {
    const closeIdx = descriptor.indexOf(')');
    if (closeIdx === -1) {return descriptor;}
    const paramStr = descriptor.substring(1, closeIdx);
    const returnStr = descriptor.substring(closeIdx + 1);
    const params = parseTypes(paramStr).map((t) => formatType(t, true));
    const ret = formatType(returnStr, true);
    return ret === 'void'
      ? `(${params.join(', ')})`
      : `(${params.join(', ')}): ${ret}`;
  } catch {
    return descriptor;
  }
}

function parseTypes(s: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === 'L') {
      const end = s.indexOf(';', i);
      result.push(s.substring(i, end + 1));
      i = end + 1;
    } else if (s[i] === '[') {
      let j = i + 1;
      while (j < s.length && s[j] === '[') {j++;}
      if (s[j] === 'L') {
        const end = s.indexOf(';', j);
        result.push(s.substring(i, end + 1));
        i = end + 1;
      } else {
        result.push(s.substring(i, j + 1));
        i = j + 1;
      }
    } else {
      result.push(s[i]);
      i++;
    }
  }
  return result;
}

function formatType(t: string, omitPackages: boolean): string {
  if (t === '') {return 'void';}
  const dims = (t.match(/^\[+/) ?? [''])[0].length;
  const base = t.substring(dims);
  const suffix = '[]'.repeat(dims);
  const PRIMITIVES: Record<string, string> = {
    V: 'void',
    Z: 'boolean',
    C: 'char',
    B: 'byte',
    S: 'short',
    I: 'int',
    F: 'float',
    J: 'long',
    D: 'double',
  };
  if (base in PRIMITIVES) {return PRIMITIVES[base] + suffix;}
  if (base.startsWith('L') && base.endsWith(';')) {
    const className = base.substring(1, base.length - 1).replace(/\//g, '.');
    const display = omitPackages ? shortClassName(className) : className;
    return display + suffix;
  }
  return t;
}
