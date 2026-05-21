/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export interface JFRConverterConfig {
  nonProjectPackagePrefixes: string[];
  maxExecutionSamplesPerThread: number;
  maxMiscSamplesPerThread: number;
  sourceUrl: string | null;
  executionSampleTypes: RegExp;
  enableMarkers: boolean;
  enableAllocations: boolean;
  maxThreads: number;
  includeGCThreads: boolean;
  minRequiredItemsPerThread: number;
  initialVisibleThreads: number;
  initialSelectedThreads: number;
  selectProcessTrackInitially: boolean;
  useNonProjectCategory: boolean;
  omitEventThreadProperty: boolean;
  ignoredEvents: Set<string>;
}

const DEFAULT_NON_PROJECT_PREFIXES = [
  'java.',
  'javax.',
  'kotlin.',
  'jdk.',
  'com.google.',
  'org.apache.',
  'org.spring.',
  'sun.',
  'scala.',
];

const DEFAULT_IGNORED_EVENTS = new Set([
  'jdk.ActiveSetting',
  'jdk.ActiveRecording',
  'jdk.BooleanFlag',
  'jdk.IntFlag',
  'jdk.DoubleFlag',
  'jdk.LongFlag',
  'jdk.NativeLibrary',
  'jdk.StringFlag',
  'jdk.UnsignedIntFlag',
  'jdk.UnsignedLongFlag',
  'jdk.InitialSystemProperty',
  'jdk.InitialEnvironmentVariable',
  'jdk.SystemProcess',
  'jdk.ModuleExport',
  'jdk.ModuleRequire',
]);

export function defaultConfig(
  overrides: Partial<JFRConverterConfig> = {}
): JFRConverterConfig {
  return {
    nonProjectPackagePrefixes: DEFAULT_NON_PROJECT_PREFIXES,
    maxExecutionSamplesPerThread: -1,
    maxMiscSamplesPerThread: -1,
    sourceUrl: null,
    executionSampleTypes: /jdk\.ExecutionSample|jdk\.NativeMethodSample/,
    enableMarkers: true,
    enableAllocations: true,
    maxThreads: Number.MAX_SAFE_INTEGER,
    includeGCThreads: false,
    minRequiredItemsPerThread: 3,
    initialVisibleThreads: 10,
    initialSelectedThreads: 10,
    selectProcessTrackInitially: true,
    useNonProjectCategory: true,
    omitEventThreadProperty: true,
    ignoredEvents: DEFAULT_IGNORED_EVENTS,
    ...overrides,
  };
}

export function isExecutionSample(
  eventType: string,
  config: JFRConverterConfig
): boolean {
  return config.executionSampleTypes.test(eventType);
}

export function isNonProjectPackage(
  packageName: string,
  config: JFRConverterConfig
): boolean {
  return config.nonProjectPackagePrefixes.some((p) =>
    packageName.startsWith(p)
  );
}
