/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Port of CategoryE.kt

export interface Category {
  name: string;
  color: string;
  subcategories: string[];
}

interface CategoryEntry {
  displayName: string;
  color: string;
  subcategories: string[];
  index: number;
}

function cat(
  displayName: string,
  color: string,
  subcategories: string[] = []
): CategoryEntry {
  return { displayName, color, subcategories, index: 0 };
}

// Keep insertion order — index is assigned below.
const _CATEGORIES: CategoryEntry[] = [
  cat('Other', 'grey', ['Profiling', 'Waiting']),
  cat('Java', 'blue', ['Other', 'Interpreted', 'Compiled', 'Native', 'Inlined']),
  cat('Java (non-project)', 'darkgray', [
    'Other',
    'Interpreted',
    'Compiled',
    'Native',
    'Inlined',
  ]),
  cat('GC', 'orange', ['Other']),
  cat('Native', 'red', ['Other']),
  cat('Flight Recorder', 'lightgrey'),
  cat('Java Application', 'red'),
  cat('Java Application, Statistics', 'grey'),
  cat('Java Virtual Machine, Class Loading', 'brown'),
  cat('Java Virtual Machine, Code Cache', 'lightbrown'),
  cat('Java Virtual Machine, Compiler, Optimization', 'lightblue'),
  cat('Java Virtual Machine, Compiler', 'lightblue'),
  cat('Java Virtual Machine, Diagnostics', 'lightgrey'),
  cat('Java Virtual Machine, Flag', 'lightgrey'),
  cat('Java Virtual Machine, GC, Collector', 'orange'),
  cat('Java Virtual Machine, GC, Configuration', 'lightgrey'),
  cat('Java Virtual Machine, GC, Detailed', 'lightorange'),
  cat('Java Virtual Machine, GC, Heap', 'lightorange'),
  cat('Java Virtual Machine, GC, Metaspace', 'lightorange'),
  cat('Java Virtual Machine, GC, Phases', 'lightorange'),
  cat('Java Virtual Machine, GC, Reference', 'lightorange'),
  cat('Java Virtual Machine, Internal', 'lightgrey'),
  cat('Java Virtual Machine, Profiling', 'lightgrey'),
  cat('Java Virtual Machine, Runtime, Modules', 'lightgrey'),
  cat('Java Virtual Machine, Runtime, Safepoint', 'yellow'),
  cat('Java Virtual Machine, Runtime, Tables', 'lightgrey'),
  cat('Java Virtual Machine, Runtime', 'green'),
  cat('Java Virtual Machine', 'lightgrey'),
  cat('Operating System, Memory', 'lightgrey'),
  cat('Operating System, Network', 'lightgrey'),
  cat('Operating System, Processor', 'lightgrey'),
  cat('Operating System', 'lightgrey'),
  cat('Misc', 'lightgrey', ['Other']),
];

_CATEGORIES.forEach((c, i) => (c.index = i));

const _CATEGORY_MAP = new Map<string, CategoryEntry>(
  _CATEGORIES.map((c) => [c.displayName, c])
);

// Named accessors matching the Kotlin enum members used in Processor/Tables
export const CategoryE = {
  OTHER: _CATEGORIES[0],
  JAVA: _CATEGORIES[1],
  NON_PROJECT_JAVA: _CATEGORIES[2],
  GC: _CATEGORIES[3],
  CPP: _CATEGORIES[4],
  JFR: _CATEGORIES[5],
  JAVA_APPLICATION: _CATEGORIES[6],
  JAVA_APPLICATION_STATS: _CATEGORIES[7],
  JVM_CLASSLOADING: _CATEGORIES[8],
  JVM_CODE_CACHE: _CATEGORIES[9],
  JVM_COMPILATION_OPT: _CATEGORIES[10],
  JVM_COMPILATION: _CATEGORIES[11],
  JVM_DIAGNOSTICS: _CATEGORIES[12],
  JVM_FLAG: _CATEGORIES[13],
  JVM_GC_COLLECTOR: _CATEGORIES[14],
  JVM_GC_CONF: _CATEGORIES[15],
  JVM_GC_DETAILED: _CATEGORIES[16],
  JVM_GC_HEAP: _CATEGORIES[17],
  JVM_GC_METASPACE: _CATEGORIES[18],
  JVM_GC_PHASES: _CATEGORIES[19],
  JVM_GC_REFERENCE: _CATEGORIES[20],
  JVM_INTERNAL: _CATEGORIES[21],
  JVM_PROFILING: _CATEGORIES[22],
  JVM_RUNTIME_MODULES: _CATEGORIES[23],
  JVM_RUNTIME_SAFEPOINT: _CATEGORIES[24],
  JVM_RUNTIME_TABLES: _CATEGORIES[25],
  JVM_RUNTIME: _CATEGORIES[26],
  JVM: _CATEGORIES[27],
  OS_MEMORY: _CATEGORIES[28],
  OS_NETWORK: _CATEGORIES[29],
  OS_PROCESS: _CATEGORIES[30],
  OS: _CATEGORIES[31],
  MISC: _CATEGORIES[32],
} as const;

// Returns (categoryIndex, subcategoryIndex), adding subcategory if new
export function sub(
  category: CategoryEntry,
  subcategoryName: string
): [number, number] {
  let idx = category.subcategories.indexOf(subcategoryName);
  if (idx === -1) {
    category.subcategories.push(subcategoryName);
    idx = category.subcategories.length - 1;
  }
  return [category.index, idx];
}

export function fromCategoryName(displayName: string): CategoryEntry {
  return _CATEGORY_MAP.get(displayName) ?? CategoryE.OTHER;
}

export function toCategoryList(): Category[] {
  return _CATEGORIES.map((c) => ({
    name: c.displayName,
    color: c.color,
    subcategories: [...c.subcategories],
  }));
}

export const MISC_OTHER = sub(CategoryE.MISC, 'Other');
