/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Port of Processor.kt — top-level orchestration of JFR event stream → Profile.

import type { JFRConverterConfig } from './config';
import { isExecutionSample, isNonProjectPackage } from './config';
import {
  Tables,
  SamplesTableWrapper,
  RawMarkerTableWrapper,
} from './tables';
import {
  MarkerSchemaProcessor,
  generateSampleLikeMarkersConfig,
} from './marker-schemas';
import type { JFREventTypeInfo, SampleLikeMarkerConfig } from './marker-schemas';
import { toCategoryList, fromCategoryName } from './categories';
import type { ParsedJFREvent, JFRMetadata, Milliseconds, Percentage } from './types';

// ---- Thread processing ----

interface PausedRange {
  startTime: Milliseconds;
  endTime: Milliseconds;
  reason: 'parked';
}

class ThreadProcessor {
  private start: Milliseconds | null = null;
  private end: Milliseconds = 0;
  private cpuLoads = new Map<number, Percentage>(); // µs → load
  private seenEventTypes = new Set<string>();
  private itemCount = 0;

  private samplesTable: SamplesTableWrapper;
  private markerTable: RawMarkerTableWrapper;
  private pausedRanges: PausedRange[] = [];

  private threadStartMs: Milliseconds | null = null;
  private threadEndMs: Milliseconds | null = null;
  private javaName: string | null = null;
  private osName: string | null = null;

  constructor(
    public readonly isParentThread: boolean,
    public readonly threadId: number,
    private tables: Tables,
    private markerSchema: MarkerSchemaProcessor,
    private basicInfo: BasicInfo
  ) {
    this.samplesTable = new SamplesTableWrapper();
    this.markerTable = new RawMarkerTableWrapper();
    if (isParentThread) {
      this.start = basicInfo.startMs;
    }
  }

  processEvent(event: ParsedJFREvent, eventTypeInfo: JFREventTypeInfo): void {
    if (this.start === null) this.start = event.startMs;
    this.end = Math.max(this.end, event.endMs);
    this.seenEventTypes.add(event.type);

    if (event.thread) {
      if (this.javaName === null) this.javaName = event.thread.javaName;
      if (this.osName === null) this.osName = event.thread.osName;
    }

    if (isExecutionSample(event.type, this.tables.config)) {
      if (event.stackTrace && event.stackTrace.length > 0) {
        const stackIdx = this.tables.processFrames(event.stackTrace, this.tables.defaultUrl);
        this.samplesTable.processEvent(stackIdx, event.startMs);
      }
      this.itemCount++;
    } else if (this.tables.config.enableMarkers) {
      const mapping = this.markerSchema.getMapping(eventTypeInfo);
      if (mapping) {
        const nameIdx = this.tables.stringTable.get(event.type);
        const phase = event.endMs === event.startMs ? 0 : 1;
        const catEntry = fromCategoryName(eventTypeInfo.categoryNames[0] ?? '');
        const categoryIdx = catEntry.index;
        const data = this.markerSchema.buildMarkerData(
          mapping,
          event,
          this.tables,
          () => {} // stack ref is already embedded in data
        );
        this.markerTable.add({
          name: nameIdx,
          startTime: event.startMs,
          endTime: event.endMs,
          phase,
          category: categoryIdx,
          data,
        });
        this.itemCount++;
      }
    }

    // Handle special events
    switch (event.type) {
      case 'jdk.ThreadCPULoad': {
        const user = Number(event.fields['user'] ?? 0);
        const system = Number(event.fields['system'] ?? 0);
        const micros = Math.round(event.startMs * 1000);
        this.cpuLoads.set(micros, (user + system) * this.basicInfo.hwThreads);
        break;
      }
      case 'jdk.ThreadStart':
        this.threadStartMs = event.startMs;
        break;
      case 'jdk.ThreadEnd':
        this.threadEndMs = event.startMs;
        break;
      case 'jdk.ThreadPark':
        this.pausedRanges.push({
          startTime: event.startMs,
          endTime: event.endMs,
          reason: 'parked',
        });
        break;
    }
  }

  get items(): number {
    return this.itemCount;
  }

  getCpuLoad(timeMs: Milliseconds): Percentage {
    if (this.cpuLoads.size === 0) return 1.0;
    const micros = Math.round(timeMs * 1000);
    // Find nearest entry
    let floor: Percentage | null = null;
    let floorKey = -Infinity;
    let ceil: Percentage | null = null;
    let ceilKey = Infinity;
    for (const [k, v] of this.cpuLoads) {
      if (k <= micros && k > floorKey) { floorKey = k; floor = v; }
      if (k >= micros && k < ceilKey) { ceilKey = k; ceil = v; }
    }
    if (floor === null) return ceil!;
    if (ceil === null) return floor;
    return micros - floorKey < ceilKey - micros ? floor : ceil;
  }

  get name(): string {
    if (this.isParentThread) return 'GeckoMain';
    const jn = this.javaName && this.javaName !== '' ? this.javaName : null;
    return jn ?? this.osName ?? '<unknown>';
  }

  get pid(): string {
    return String(this.basicInfo.pid);
  }

  get tid(): number {
    return this.isParentThread ? 0 : this.threadId;
  }

  get processType(): string {
    return this.isParentThread ? 'tab' : 'default';
  }

  private get registerTime(): Milliseconds {
    return this.threadStartMs ?? this.start ?? this.basicInfo.startMs;
  }

  private get unregisterTime(): Milliseconds {
    return this.threadEndMs ?? this.end;
  }

  private generateSampleLikeMarkersConfig(): SampleLikeMarkerConfig[] {
    const result: SampleLikeMarkerConfig[] = [];
    const seen = new Set<string>();
    for (const typeName of this.seenEventTypes) {
      for (const cfg of generateSampleLikeMarkersConfig(typeName, undefined)) {
        if (!seen.has(cfg.name)) {
          seen.add(cfg.name);
          result.push(cfg);
        }
      }
    }
    return result;
  }

  toThread() {
    const threadName = this.name;
    const samples = this.samplesTable.toSamplesTable(this.getCpuLoad.bind(this));
    const markers = this.markerTable.toRawMarkerTable();
    const sampleLikeMarkersConfig = this.generateSampleLikeMarkersConfig();
    return {
      processType: this.processType,
      processStartupTime: this.start ?? this.basicInfo.startMs,
      processShutdownTime: this.end,
      registerTime: this.registerTime,
      unregisterTime: this.unregisterTime,
      pausedRanges: [...this.pausedRanges].sort((a, b) => a.startTime - b.startTime),
      name: threadName,
      isMainThread: threadName === 'GeckoMain',
      processName: 'Parent Process',
      pid: this.pid,
      tid: this.tid,
      samples,
      jsAllocations: null,
      nativeAllocations: null,
      markers,
      sampleLikeMarkersConfig: sampleLikeMarkersConfig.length > 0 ? sampleLikeMarkersConfig : undefined,
    };
  }
}

// ---- Basic information gathered from metadata events ----

interface BasicInfo {
  mainThreadId: number;
  startMs: Milliseconds;
  endMs: Milliseconds;
  intervalMs: Milliseconds;
  pid: number;
  hwThreads: number;
  jvmVersion: string | null;
  jvmArgs: string | null;
  javaArgs: string | null;
  cpuModel: string | null;
  cpuCores: number | null;
  cpuHwThreads: number | null;
  osVersion: string | null;
}

function basicInfoFromMetadata(meta: JFRMetadata): BasicInfo {
  return {
    mainThreadId: -1,
    startMs: meta.startMs,
    endMs: meta.endMs,
    intervalMs: 1.0,
    pid: meta.pid,
    hwThreads: meta.cpuHwThreads ?? 1,
    jvmVersion: meta.jvmVersion,
    jvmArgs: meta.jvmArgs,
    javaArgs: meta.javaArgs,
    cpuModel: meta.cpuModel,
    cpuCores: meta.cpuCores,
    cpuHwThreads: meta.cpuHwThreads,
    osVersion: meta.osVersion,
  };
}

// ---- Thread info for ranking ----

interface ThreadInfo {
  id: number;
  javaName: string | null;
  osName: string | null;
  isMainThread: boolean;
  isSystemThread: boolean;
  isGCThread: boolean;
  executionSampleCount: number;
  otherSampleCount: number;
}

function isSystemThread(javaName: string | null, osName: string | null): boolean {
  if (javaName === null || javaName === '') return false;
  const systemNames = [
    'JFR Periodic Tasks', 'JFR Shutdown Hook', 'Permissionless thread',
    'Thread Monitor CTRL-C', 'Monitor Ctrl-Break', 'Notification Thread',
    'Finalizer', 'Attach Listener',
  ];
  if (systemNames.includes(javaName)) return true;
  if (javaName.startsWith('JFR ')) return true;
  if (javaName.startsWith('GC Thread') || javaName.includes('CompilerThread')) return true;
  return false;
}

function isGCThread(javaName: string | null, osName: string | null): boolean {
  return (osName ?? '').startsWith('GC Thread') && (javaName === null || javaName === '');
}

// ---- Estimate sampling interval ----

function estimateInterval(startTimesPerThread: Map<number, number[]>): number {
  const MAX_INTERVAL = 1000.0;
  const allIntervals: number[] = [];
  for (const times of startTimesPerThread.values()) {
    if (times.length < 3) continue;
    const sorted = [...times].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i] - sorted[i - 1];
      if (diff > 0 && diff < MAX_INTERVAL) allIntervals.push(diff);
    }
  }
  if (allIntervals.length === 0) return 1.0;
  allIntervals.sort((a, b) => a - b);
  const subset = allIntervals.slice(
    Math.floor(allIntervals.length * 0.1),
    Math.floor(allIntervals.length * 0.8)
  );
  if (subset.length === 0) return 1.0;
  return subset.reduce((a, b) => a + b, 0) / subset.length;
}

// ---- Counter processing ----

interface CPULoadSample {
  timeMs: Milliseconds;
  jvmUser: number;
  jvmSystem: number;
}

interface MemorySample {
  timeMs: Milliseconds;
  bytes: number;
}

// ---- Main converter function ----

export interface Profile {
  meta: unknown;
  libs: unknown[];
  shared: unknown;
  counters?: unknown[];
  threads: unknown[];
}

export async function convertJFREventStream(
  events: ParsedJFREvent[],
  eventTypeInfoMap: Map<string, JFREventTypeInfo>,
  meta: JFRMetadata,
  config: JFRConverterConfig
): Promise<Profile> {
  const basicInfo = basicInfoFromMetadata(meta);

  // First pass: collect main thread ID, interval, thread ranks
  const startTimesPerThread = new Map<number, number[]>();
  const threadInfoMap = new Map<number, ThreadInfo>();
  let endMs = meta.startMs;
  let mainThreadId = -1;

  for (const event of events) {
    const t = event.thread;
    if (!t) continue;
    if (t.javaName === 'main' && mainThreadId === -1) mainThreadId = t.id;
    let info = threadInfoMap.get(t.id);
    if (!info) {
      info = {
        id: t.id,
        javaName: t.javaName,
        osName: t.osName,
        isMainThread: false,
        isSystemThread: isSystemThread(t.javaName, t.osName),
        isGCThread: isGCThread(t.javaName, t.osName),
        executionSampleCount: 0,
        otherSampleCount: 0,
      };
      threadInfoMap.set(t.id, info);
    }
    if (isExecutionSample(event.type, config)) {
      info.executionSampleCount++;
      const times = startTimesPerThread.get(t.id) ?? [];
      times.push(event.startMs);
      startTimesPerThread.set(t.id, times);
    } else {
      info.otherSampleCount++;
    }
    endMs = Math.max(endMs, event.endMs);
  }

  basicInfo.mainThreadId = mainThreadId;
  basicInfo.endMs = endMs;
  basicInfo.intervalMs = estimateInterval(startTimesPerThread);

  // Mark main thread
  if (mainThreadId !== -1) {
    const mainInfo = threadInfoMap.get(mainThreadId);
    if (mainInfo) mainInfo.isMainThread = true;
  }

  const tables = new Tables(config, meta.startMs, config.sourceUrl);
  const markerSchemaProcessor = new MarkerSchemaProcessor(config);

  // Parent (process) thread processor
  const parentProcessor = new ThreadProcessor(
    true, -1, tables, markerSchemaProcessor, basicInfo
  );

  // Per-thread processors
  const threadProcessors = new Map<number, ThreadProcessor>();

  // Counter data
  const cpuLoadSamples: CPULoadSample[] = [];
  const usedHeapSamples: MemorySample[] = [];
  const committedHeapSamples: MemorySample[] = [];

  // Second pass: process events
  for (const event of events) {
    if (config.ignoredEvents.has(event.type)) continue;
    const eventTypeInfo = eventTypeInfoMap.get(event.type);
    if (!eventTypeInfo) continue;

    // Counter extraction
    if (event.type === 'jdk.CPULoad') {
      cpuLoadSamples.push({
        timeMs: event.startMs,
        jvmUser: Number(event.fields['jvmUser'] ?? 0),
        jvmSystem: Number(event.fields['jvmSystem'] ?? 0),
      });
    }
    if (event.type === 'jdk.GCHeapSummary') {
      usedHeapSamples.push({ timeMs: event.startMs, bytes: Number(event.fields['heapUsed'] ?? 0) });
      committedHeapSamples.push({ timeMs: event.startMs, bytes: Number(event.fields['heapSpace.committedSize'] ?? 0) });
    }

    const t = event.thread;
    if (t === undefined || t === null) {
      parentProcessor.processEvent(event, eventTypeInfo);
    } else {
      if (!config.includeGCThreads && isGCThread(t.javaName, t.osName)) continue;
      let proc = threadProcessors.get(t.id);
      if (!proc) {
        proc = new ThreadProcessor(false, t.id, tables, markerSchemaProcessor, basicInfo);
        threadProcessors.set(t.id, proc);
      }
      proc.processEvent(event, eventTypeInfo);
    }
  }

  // Filter and rank threads
  function isValidThread(info: ThreadInfo): boolean {
    if (info.isMainThread) return true;
    if (info.isGCThread) return config.includeGCThreads;
    const combined = info.executionSampleCount + info.otherSampleCount;
    if (combined < config.minRequiredItemsPerThread) return false;
    if (!info.isSystemThread) return info.executionSampleCount > 0;
    return true;
  }

  function threadScore(info: ThreadInfo): number {
    if (info.isMainThread) return Number.MAX_SAFE_INTEGER;
    return info.executionSampleCount * 2 + info.otherSampleCount;
  }

  const validInfos = [...threadInfoMap.values()].filter(isValidThread);
  validInfos.sort((a, b) => threadScore(b) - threadScore(a));

  // Build thread list: parent process first, then ranked threads
  const threadList = [parentProcessor.toThread()];
  for (const info of validInfos) {
    const proc = threadProcessors.get(info.id);
    if (proc) threadList.push(proc.toThread());
  }

  // Visibility
  const nonSystemCount = validInfos.filter((i) => !i.isSystemThread).length + 1;
  const initialVisibleThreads = Array.from(
    { length: Math.min(nonSystemCount, config.initialVisibleThreads + 1) },
    (_, i) => i
  );
  const initialSelectedThreads = [
    ...(config.selectProcessTrackInitially ? [0] : []),
    ...initialVisibleThreads.slice(1).slice(0, config.initialSelectedThreads),
  ];

  // Shared data
  const shared = tables.toSharedData();

  // Counters
  const pid = String(basicInfo.pid);
  const counters: unknown[] = [];
  if (cpuLoadSamples.length > 0) {
    const sorted = cpuLoadSamples.sort((a, b) => a.timeMs - b.timeMs);
    counters.push({
      name: 'processCPU',
      category: 'CPU',
      description: 'Process CPU utilization',
      pid,
      mainThreadIndex: 0,
      samples: {
        time: sorted.map((s) => s.timeMs),
        count: sorted.map((s) => Math.round((s.jvmUser + s.jvmSystem) * 1_000_000)),
        length: sorted.length,
      },
      display: { graphType: 'line-rate', unit: '%', color: 'grey' },
    });
  }
  if (usedHeapSamples.length > 0) {
    const sorted = usedHeapSamples.sort((a, b) => a.timeMs - b.timeMs);
    const deltas = sorted.map((s, i) =>
      i === 0 ? s.bytes : s.bytes - sorted[i - 1].bytes
    );
    counters.push({
      name: 'usedHeap',
      category: 'Memory',
      description: 'Used heap',
      pid,
      mainThreadIndex: 0,
      samples: { time: sorted.map((s) => s.timeMs), count: deltas, length: sorted.length },
      display: {
        graphType: 'line-accumulated',
        unit: 'bytes',
        color: 'orange',
        markerSchemaLocation: 'timeline-memory',
      },
    });
  }

  // Meta
  const categories = toCategoryList();
  const markerSchema = markerSchemaProcessor.toMarkerSchemaList();

  const osVersion = meta.osVersion ?? '';
  const platform = osVersion.includes('Android') ? 'Android'
    : osVersion.includes('Mac OS X') ? 'Macintosh'
    : osVersion.includes('Windows') ? 'Windows'
    : 'X11';

  const meta_: unknown = {
    interval: basicInfo.intervalMs,
    startTime: basicInfo.startMs,
    endTime: endMs,
    categories,
    product: meta.javaArgs ?? 'JVM Application',
    stackwalk: 0,
    misc: meta.jvmVersion ? `JVM Version ${meta.jvmVersion}` : undefined,
    oscpu: osVersion || undefined,
    cpuName: meta.cpuModel ?? undefined,
    platform,
    markerSchema,
    arguments: meta.jvmArgs
      ? `jvm=${meta.jvmArgs}  --  java=${meta.javaArgs ?? ''}`
      : '<unknown>',
    physicalCPUs: meta.cpuCores ?? undefined,
    logicalCPUs: meta.cpuHwThreads ?? undefined,
    sampleUnits: { time: 'ms', eventDelay: 'ms', threadCPUDelta: 'µs' },
    importedFrom: 'JFR profile',
    extra: [],
    initialVisibleThreads,
    initialSelectedThreads,
    keepProfileThreadOrder: true,
    processType: 0,
    version: 25,
    preprocessedProfileVersion: 62,
    symbolicated: true,
    symbolicationNotSupported: true,
    usesOnlyOneStackType: true,
    doesNotUseFrameImplementation: true,
    sourceCodeIsNotOnSearchfox: true,
  };

  return {
    meta: meta_,
    libs: [],
    shared,
    counters: counters.length > 0 ? counters : undefined,
    threads: threadList,
  };
}
