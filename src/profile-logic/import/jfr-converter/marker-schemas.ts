/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Port of MarkerSchemaWrapper.kt — JFR event → Firefox Profiler marker schema.

import {
  resolveMarkerType,
  convertFieldValue,
  getFormat,
} from './marker-types';
import type { MarkerTypeEntry, AnyMarkerFormat } from './marker-types';
import type { Tables } from './tables';
import type { JFRConverterConfig } from './config';
import type { ParsedJFREvent, JFRFieldValue } from './types';

// ---- Schema types (what we emit in profile.meta.markerSchema) ----

export interface MarkerSchemaField {
  key: string;
  label?: string;
  format: AnyMarkerFormat;
  isHidden?: boolean;
}

export interface MarkerGraph {
  key: string;
  type: 'bar' | 'line' | 'line-filled';
  color?: string;
  fillColor?: string;
  strokeColor?: string;
  isPreScaled?: boolean;
  width?: number;
}

export interface MarkerSchema {
  name: string;
  tooltipLabel?: string;
  tableLabel?: string;
  chartLabel?: string;
  display: string[];
  fields: MarkerSchemaField[];
  description?: string;
  graphs?: MarkerGraph[];
  trackLabel?: string;
  graphHeight?: 'small' | 'medium' | 'large';
  isPreSelected?: boolean;
}

// ---- Field definition (runtime only, not serialized) ----

interface Field {
  // If sourceName is set, read event.fields[sourceName].
  // If accessor is set, call accessor(event) to get the value.
  sourceName?: string;
  accessor?: (event: ParsedJFREvent) => JFRFieldValue;
  targetName: string;
  type: MarkerTypeEntry;
  label?: string;
}

interface SchemaMapping {
  name: string;
  fields: Field[];
}

// ---- Special per-event graph/track config ----

interface SpecialConfig {
  directDataFields?: Field[];
  graphs?: MarkerGraph[];
  trackLabel?: string;
  graphHeight?: 'small' | 'medium' | 'large';
  isPreSelected?: boolean;
}

import { MARKER_TYPES } from './marker-types';

const SPECIAL_EVENT_TYPES: Record<string, SpecialConfig> = {
  'jdk.CPULoad': {
    trackLabel: 'CPU Load',
    graphHeight: 'large',
    isPreSelected: true,
    graphs: [
      { key: 'jvmSystem', type: 'line', strokeColor: 'orange' },
      { key: 'jvmUser', type: 'line', strokeColor: 'blue' },
    ],
  },
  'jdk.NetworkUtilization': {
    trackLabel: 'Network Utilization',
    graphHeight: 'large',
    graphs: [
      { key: 'readRate', type: 'line', strokeColor: 'blue' },
      { key: 'writeRate', type: 'line', strokeColor: 'orange' },
    ],
  },
  'jdk.GCHeapSummary': {
    directDataFields: [
      {
        sourceName: 'gcId',
        targetName: 'gcId',
        type: MARKER_TYPES.INT,
        label: 'GC Identifier',
      },
      {
        sourceName: 'when',
        targetName: 'when',
        type: MARKER_TYPES.STRING,
        label: 'When',
      },
      {
        sourceName: 'heapUsed',
        targetName: 'heapUsed',
        type: MARKER_TYPES.BYTES,
        label: 'Heap Used',
      },
      {
        accessor: (e) =>
          (e.fields['heapSpace.committedSize'] as JFRFieldValue) ?? null,
        targetName: 'heapCommitted',
        type: MARKER_TYPES.BYTES,
        label: 'Heap Committed',
      },
      {
        accessor: (e) =>
          (e.fields['heapSpace.reservedSize'] as JFRFieldValue) ?? null,
        targetName: 'heapReserved',
        type: MARKER_TYPES.BYTES,
        label: 'Heap Reserved',
      },
    ],
    trackLabel: 'GC Heap Summary',
    graphHeight: 'large',
    isPreSelected: true,
    graphs: [
      { key: 'heapUsed', type: 'line', strokeColor: 'blue' },
      { key: 'heapCommitted', type: 'line', strokeColor: 'orange' },
    ],
  },
};

const TIMELINE_OVERVIEW_EVENTS = new Set(['jdk.ThreadPark']);
const TIMELINE_MEMORY_KEYWORDS = ['memory', 'gc', 'GarbageCollection'];

function isMemoryEvent(name: string): boolean {
  return TIMELINE_MEMORY_KEYWORDS.some((kw) => name.includes(kw));
}

// ---- JFR event metadata (provided by the WASM layer per event type) ----

export interface JFREventTypeInfo {
  name: string;
  label?: string;
  description?: string;
  categoryNames: string[];
  fields: Array<{
    name: string;
    typeName: string;
    contentType: string | null;
    label?: string;
  }>;
  hasStackTrace: boolean;
}

// ---- The processor ----

export class MarkerSchemaProcessor {
  private cache = new Map<string, SchemaMapping | null>();
  private schemas: MarkerSchema[] = [];

  constructor(private config: JFRConverterConfig) {}

  private isIgnoredField(fieldName: string): boolean {
    return (
      (this.config.omitEventThreadProperty && fieldName === 'eventThread') ||
      fieldName === 'startTime'
    );
  }

  getMapping(eventTypeInfo: JFREventTypeInfo): SchemaMapping | null {
    const name = eventTypeInfo.name;
    if (this.cache.has(name)) return this.cache.get(name) ?? null;

    const result = this.processEventType(eventTypeInfo);
    this.cache.set(name, result.mapping);
    if (result.schema) this.schemas.push(result.schema);
    return result.mapping;
  }

  private processEventType(eventTypeInfo: JFREventTypeInfo): {
    mapping: SchemaMapping;
    schema: MarkerSchema;
  } {
    const {
      name,
      label,
      description,
      fields: rawFields,
      hasStackTrace,
    } = eventTypeInfo;

    const display: string[] = ['marker-chart', 'marker-table'];
    if (TIMELINE_OVERVIEW_EVENTS.has(name)) {
      display.push('timeline-overview');
    } else if (isMemoryEvent(name)) {
      display.push('timeline-memory');
    }

    const mapping: Field[] = [];
    if (hasStackTrace) {
      mapping.push({
        sourceName: 'stackTrace',
        targetName: 'cause',
        type: MARKER_TYPES.STACKTRACE,
      });
    }

    const addedFields: MarkerSchemaField[] = [
      { key: 'startTime', label: 'Start Time', format: 'seconds' },
    ];

    const special = SPECIAL_EVENT_TYPES[name] ?? {};

    const directSchemaFields: MarkerSchemaField[] = special.directDataFields
      ? special.directDataFields.map((f) => {
          mapping.push(f);
          return {
            key: f.targetName,
            label: f.label ?? f.targetName,
            format: getFormat(f.type),
          };
        })
      : rawFields
          .filter(
            (f) => f.name !== 'stackTrace' && !this.isIgnoredField(f.name)
          )
          .map((f) => {
            const markerType = resolveMarkerType(
              f.name,
              f.typeName,
              f.contentType
            );
            // Avoid clashing with reserved property names
            const targetName =
              f.name === 'type'
                ? 'type '
                : f.name === 'cause'
                  ? 'cause '
                  : f.name;
            mapping.push({ sourceName: f.name, targetName, type: markerType });
            return {
              key: targetName,
              label: f.label && f.label.length < 20 ? f.label : f.name,
              format: getFormat(markerType),
            };
          });

    const allFields = [...addedFields, ...directSchemaFields];

    // Build tooltip/table label heuristic
    const nonTableFields = directSchemaFields.filter(
      (f) => typeof f.format === 'string'
    );
    let tableLabel = nonTableFields
      .slice(0, 3)
      .map((f) => `${f.label} = {marker.data.${f.key}}`)
      .join(', ');
    if (nonTableFields.length === 2 && nonTableFields[0].key === 'key') {
      tableLabel = `{marker.data.key} = {marker.data.${nonTableFields[1].key}}`;
    } else if (nonTableFields.length <= 1 && description) {
      tableLabel = `${description}: ${tableLabel}`;
    }

    const schema: MarkerSchema = {
      name,
      tooltipLabel: label ?? name,
      tableLabel,
      display,
      fields: allFields,
      description: description ?? undefined,
      graphs: special.graphs,
      trackLabel: special.trackLabel,
      graphHeight: special.graphHeight,
      isPreSelected: special.isPreSelected,
    };

    return { mapping: { name, fields: mapping }, schema };
  }

  toMarkerSchemaList(): MarkerSchema[] {
    // Deduplicate by name (keep first)
    const seen = new Set<string>();
    return this.schemas.filter((s) => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
  }

  /** Convert a parsed event into marker data object, given the field mapping. */
  buildMarkerData(
    mapping: SchemaMapping,
    event: ParsedJFREvent,
    tables: Tables,
    stackRefCallback: (stackIndex: number) => void
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const field of mapping.fields) {
      const raw = field.accessor
        ? field.accessor(event)
        : ((event.fields[field.sourceName!] as JFRFieldValue) ?? null);
      if (raw === null || raw === undefined) continue;

      if (field.type === MARKER_TYPES.STACKTRACE) {
        // stackTrace field: build a stack reference object
        if (event.stackTrace && event.stackTrace.length > 0) {
          const stackIdx = tables.processFrames(
            event.stackTrace,
            tables.defaultUrl
          );
          stackRefCallback(stackIdx);
          data[field.targetName] = { stack: stackIdx, time: event.startMs };
        }
        continue;
      }

      data[field.targetName] = convertFieldValue(
        field.type,
        tables,
        event.startMs,
        raw
      );
    }
    data['type'] = event.type;
    data['startTime'] = event.startMs - tables.startTimeMs;

    // Special: ObjectAllocationSample class synthetic stack
    if (
      event.type === 'jdk.ObjectAllocationSample' &&
      event.fields['objectClass']
    ) {
      const className = String(event.fields['objectClass'] ?? '');
      if (className) {
        const miscStackIdx = tables.stackTable.getMiscStack(className);
        data['_class'] = { stack: miscStackIdx };
      }
    }

    return data;
  }
}

// ---- generateSampleLikeMarkersConfig ----

export interface SampleLikeMarkerConfig {
  name: string;
  label: string;
  marker: string;
  weightType?: 'samples' | 'tracing-ms' | 'bytes';
  weightField?: string;
  stackField?: string;
}

export function generateSampleLikeMarkersConfig(
  eventTypeName: string,
  eventLabel: string | undefined
): SampleLikeMarkerConfig[] {
  const label = eventLabel ?? eventTypeName;
  const name = eventTypeName;
  const result: SampleLikeMarkerConfig[] = [];

  const PRIMARY: Record<string, SampleLikeMarkerConfig> = {
    'jdk.AllocationRequiringGC': {
      name,
      label,
      marker: name,
      weightType: 'bytes',
      weightField: 'size',
    },
    'jdk.ClassDefine': { name, label, marker: name },
    'jdk.ClassLoad': {
      name,
      label,
      marker: name,
      weightType: 'tracing-ms',
      weightField: 'duration',
    },
    'jdk.Deoptimization': { name, label, marker: name },
    'jdk.FileRead': {
      name,
      label,
      marker: name,
      weightType: 'bytes',
      weightField: 'bytesRead',
    },
    'jdk.FileWrite': {
      name,
      label,
      marker: name,
      weightType: 'bytes',
      weightField: 'bytesWritten',
    },
    'jdk.JavaErrorThrow': { name, label, marker: name },
    'jdk.JavaExceptionThrow': { name, label, marker: name },
    'jdk.JavaMonitorEnter': { name, label, marker: name },
    'jdk.JavaMonitorWait': {
      name,
      label,
      marker: name,
      weightType: 'tracing-ms',
      weightField: 'timeout',
    },
    'jdk.ObjectAllocationSample': {
      name,
      label,
      marker: name,
      weightType: 'bytes',
      weightField: 'weight',
    },
    'jdk.ObjectAllocationInNewTLAB': {
      name,
      label,
      marker: name,
      weightType: 'bytes',
      weightField: 'allocationSize',
    },
    'jdk.ObjectAllocationOutsideTLAB': {
      name,
      label,
      marker: name,
      weightType: 'bytes',
      weightField: 'allocationSize',
    },
    'jdk.ProcessStart': { name, label, marker: name },
    'jdk.SocketRead': {
      name,
      label,
      marker: name,
      weightType: 'bytes',
      weightField: 'bytesRead',
    },
    'jdk.SocketWrite': {
      name,
      label,
      marker: name,
      weightType: 'bytes',
      weightField: 'bytesWritten',
    },
    'jdk.SystemGC': { name, label, marker: name },
    'jdk.ThreadPark': {
      name,
      label,
      marker: name,
      weightType: 'tracing-ms',
      weightField: 'duration',
    },
    'jdk.ThreadSleep': {
      name,
      label,
      marker: name,
      weightType: 'tracing-ms',
      weightField: 'duration',
    },
    'jdk.ThreadStart': { name, label, marker: name },
  };

  if (PRIMARY[name]) result.push(PRIMARY[name]);

  // Secondary: class-based strategy for allocation sample
  if (name === 'jdk.ObjectAllocationSample') {
    result.push({
      name: `${name}_class`,
      label: `${label} Classes`,
      marker: name,
      weightType: 'bytes',
      weightField: 'weight',
      stackField: '_class',
    });
  }

  return result;
}
