/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Public API for the JFR → Firefox Profiler conversion layer.
// This module only does data transformation — it has no JFR binary parsing.
// The WASM bridge (jfr-wasm/) provides the ParsedJFREvent stream.

export { convertJFREventStream } from './processor';
export { defaultConfig } from './config';
export type { JFRConverterConfig } from './config';
export type { ParsedJFREvent, JFRMetadata } from './types';
export type { JFREventTypeInfo } from './marker-schemas';
