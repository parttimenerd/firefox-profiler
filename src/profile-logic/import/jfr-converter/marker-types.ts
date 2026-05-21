/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Port of MarkerType.kt — field value conversion for marker data.

import type { JFRFieldValue } from './types';
import type { Tables } from './tables';

export type MarkerFormatType =
  | 'url'
  | 'file-path'
  | 'string'
  | 'duration'
  | 'time'
  | 'seconds'
  | 'milliseconds'
  | 'microseconds'
  | 'nanoseconds'
  | 'bytes'
  | 'percentage'
  | 'integer'
  | 'decimal'
  | 'list';

export interface TableColumnFormat {
  type?: MarkerFormatType;
  label?: string;
}

export interface TableMarkerFormat {
  type: 'table';
  columns: TableColumnFormat[];
}

export type AnyMarkerFormat = MarkerFormatType | TableMarkerFormat;

export type ConvertedValue =
  | string
  | number
  | boolean
  | null
  | unknown[]
  | Record<string, unknown>;

type Converter = (
  tables: Tables,
  startTimeMs: number | null,
  value: JFRFieldValue
) => ConvertedValue;

interface MarkerTypeEntry {
  format: AnyMarkerFormat;
  convert: Converter;
  aliases?: string[];
  generic?: boolean;
}

const stringConverter: Converter = (_, __, v) => String(v ?? '');

// Modifier bit flags
const MODIFIER_FLAGS: Array<[number, string]> = [
  [0x0001, 'public'],
  [0x0002, 'private'],
  [0x0004, 'protected'],
  [0x0008, 'static'],
  [0x0010, 'final'],
  [0x0020, 'synchronized'],
  [0x0040, 'volatile'],
  [0x0080, 'transient'],
  [0x0100, 'native'],
  [0x0200, 'interface'],
  [0x0400, 'abstract'],
  [0x0800, 'strict'],
];

const MARKER_TYPES: Record<string, MarkerTypeEntry> = {
  BOOLEAN: { format: 'string', convert: stringConverter },
  BYTES: {
    format: 'bytes',
    convert: (_, __, v) => Number(v ?? 0),
    aliases: [
      'dataAmount',
      'allocated',
      'totalSize',
      'usedSize',
      'initialSize',
      'reservedSize',
      'nonNMethodSize',
      'profiledSize',
      'nonProfiledSize',
      'expansionSize',
      'minBlockLength',
      'minSize',
      'maxSize',
      'osrBytesCompiled',
      'minTLABSize',
      'tlabRefillWasteLimit',
    ],
  },
  ADDRESS: {
    format: 'string',
    convert: (_, __, v) =>
      '0x' +
      (BigInt(Number(v ?? 0)) & BigInt('0xFFFFFFFFFFFFFFFF')).toString(16),
    aliases: [
      'baseAddress',
      'topAddress',
      'startAddress',
      'reservedTopAddress',
      'heapAddressBits',
      'objectAlignment',
    ],
  },
  INT: { format: 'integer', convert: (_, __, v) => Number(v ?? 0) },
  LONG: {
    format: 'integer',
    convert: (_, __, v) => Number(v ?? 0),
    generic: true,
  },
  FLOAT: {
    format: 'decimal',
    convert: (_, __, v) => Number(v ?? 0),
    generic: true,
  },
  DOUBLE: {
    format: 'decimal',
    convert: (_, __, v) => Number(v ?? 0),
    generic: true,
  },
  STRING: { format: 'string', convert: stringConverter, generic: true },
  MILLIS: {
    format: 'milliseconds',
    convert: (tables, _, v) => Number(v ?? 0) - tables.startTimeMs,
  },
  TIMESTAMP: {
    format: 'integer',
    convert: (tables, _, v) => {
      const startMs = tables.startTimeMs;
      let val = Number(v ?? 0);
      while (val > startMs * 100) val /= 1000;
      return val - startMs;
    },
  },
  TIMESPAN: {
    format: 'duration',
    convert: (_, __, v) => Number(v ?? 0) / 1_000_000,
  },
  NANOS: {
    format: 'milliseconds',
    convert: (_, __, v) => Number(v ?? 0) / 1_000_000,
  },
  PERCENTAGE: {
    format: 'percentage',
    convert: (_, __, v) => Number(v ?? 0),
  },
  EVENT_THREAD: {
    format: 'string',
    convert: (_, __, v) => String(v ?? ''),
  },
  STACKTRACE: {
    format: 'integer',
    convert: (_, __, v) => Number(v ?? 0),
  },
  BYTES_PER_SECOND: {
    format: 'bytes',
    convert: (_, __, v) => Number(v ?? 0),
  },
  BITS_PER_SECOND: {
    format: 'bytes',
    convert: (_, __, v) => Number(v ?? 0) / 8,
  },
  PATH: {
    format: 'file-path',
    convert: stringConverter,
  },
  CLASS: { format: 'string', convert: stringConverter },
  METHOD: { format: 'string', convert: stringConverter },
  MODIFIERS: {
    format: 'string',
    convert: (_, __, v) => {
      const n = Number(v ?? 0);
      return MODIFIER_FLAGS.filter(([bit]) => (n & bit) !== 0)
        .map(([, name]) => name)
        .join(' ');
    },
  },
  EPOCH_MILLIS: {
    format: 'milliseconds',
    convert: (_, __, v) => Number(v ?? 0),
  },
  TICKS: { format: 'integer', convert: (_, __, v) => Number(v ?? 0) },
  TICKSPAN: { format: 'integer', convert: (_, __, v) => Number(v ?? 0) },
  TABLE: {
    format: { type: 'table', columns: [{}, {}] },
    convert: stringConverter,
    generic: true,
  },
  UBYTE: {
    format: 'integer',
    convert: (_, __, v) => Number(v ?? 0),
    generic: true,
  },
  UNSIGNED: {
    format: 'integer',
    convert: (_, __, v) => Number(v ?? 0),
    generic: true,
  },
  UINT: {
    format: 'integer',
    convert: (_, __, v) => Number(v ?? 0),
    generic: true,
  },
  USHORT: {
    format: 'integer',
    convert: (_, __, v) => Number(v ?? 0),
    generic: true,
  },
  ULONG: {
    format: 'integer',
    convert: (_, __, v) => Number(v ?? 0),
    generic: true,
  },
};

// Aliases used for name-based lookup (fieldName → type)
const FIELD_NAME_ALIASES = new Map<string, MarkerTypeEntry>();
const TYPE_NAME_MAP = new Map<string, MarkerTypeEntry>();

(function buildLookups() {
  for (const [name, entry] of Object.entries(MARKER_TYPES)) {
    const key = name.toLowerCase().replace(/_/g, '');
    TYPE_NAME_MAP.set(key, entry);
    for (const alias of entry.aliases ?? []) {
      FIELD_NAME_ALIASES.set(alias.toLowerCase(), entry);
    }
  }
  // extra string aliases that share the STRING converter
  for (const alias of [
    'COMPILER_PHASE_TYPE',
    'COMPILER_TYPE',
    'DEOPTIMIZATION_ACTION',
    'DEOPTIMIZATION_REASON',
    'FLAG_VALUE_ORIGIN',
    'FRAME_TYPE',
    'G1_HEAP_REGION_TYPE',
    'G1_YC_TYPE',
    'GC_CAUSE',
    'GC_NAME',
    'GC_THRESHHOLD_UPDATER',
    'GC_WHEN',
    'INFLATE_CAUSE',
    'METADATA_TYPE',
    'METASPACE_OBJECT_TYPE',
    'NARROW_OOP_MODE',
    'NETWORK_INTERFACE_NAME',
    'OLD_OBJECT_ROOT_TYPE',
    'OLD_OBJECT_ROOT_SYSTEM',
    'REFERENCE_TYPE',
    'ShenandoahHeapRegionState',
    'SYMBOL',
    'ThreadState',
    'VMOperationType',
    'ZPageTypeType',
    'ZStatisticsCounterType',
    'ZStatisticsSamplerType',
  ]) {
    TYPE_NAME_MAP.set(
      alias.toLowerCase().replace(/_/g, ''),
      MARKER_TYPES.STRING
    );
  }
})();

const BYTE_FIELD_NAMES = new Set([
  'committed',
  'reserved',
  'used',
  'gcThreshold',
  'unallocatedCapacity',
]);

export function resolveMarkerType(
  fieldName: string,
  typeName: string,
  contentType: string | null
): MarkerTypeEntry {
  const fieldNameLower = fieldName.toLowerCase();

  if (fieldNameLower.endsWith('pointer')) return MARKER_TYPES.ADDRESS;
  if (fieldName.endsWith('Size') || BYTE_FIELD_NAMES.has(fieldName))
    return MARKER_TYPES.BYTES;

  const contentTypeResult = contentType
    ? TYPE_NAME_MAP.get(
        contentType.toLowerCase().split('.').at(-1)!.replace(/_/g, '')
      )
    : undefined;
  const nameResult =
    FIELD_NAME_ALIASES.get(fieldNameLower) ??
    TYPE_NAME_MAP.get(fieldNameLower) ??
    TYPE_NAME_MAP.get(
      typeName.toLowerCase().split('.').at(-1)!.replace(/_/g, '')
    ) ??
    MARKER_TYPES.TABLE;

  if (
    nameResult !== MARKER_TYPES.TABLE &&
    contentTypeResult !== undefined &&
    contentTypeResult.generic
  ) {
    return nameResult;
  }
  return contentTypeResult ?? nameResult;
}

export function convertFieldValue(
  entry: MarkerTypeEntry,
  tables: Tables,
  startTimeMs: number | null,
  value: JFRFieldValue
): ConvertedValue {
  try {
    return entry.convert(tables, startTimeMs, value);
  } catch {
    return String(value ?? '');
  }
}

export function getFormat(entry: MarkerTypeEntry): AnyMarkerFormat {
  return entry.format;
}

export { MARKER_TYPES };
export type { MarkerTypeEntry };
