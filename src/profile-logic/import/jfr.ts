/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// In-browser JFR importer.
//
// This file is the entry point wired into the format-detection pipeline in
// process-profile.ts. It is only called when:
//   1. The input bytes start with the JFR magic bytes.
//   2. process.env.JFR_CONVERTER_ENABLED is true (WASM asset present at build time).
//
// The full conversion (parse + transform → Profile) happens inside the WASM
// module. JS just decodes the resulting JSON string.

import type { Profile } from '../../types/profile';

// JFR magic: first 4 bytes of a JFR file
// Format: FLR\0 (0x46 0x4C 0x52 0x00)
const JFR_MAGIC = [0x46, 0x4c, 0x52, 0x00];

// CJFR magic: varint-encoded length 13 (0x0D) followed by "CondensedData"
// 0x0D 0x43 0x6F 0x6E 0x64 0x65 0x6E 0x73 0x65 0x64 0x44 0x61 0x74 0x61
const CJFR_MAGIC = [
  0x0d, 0x43, 0x6f, 0x6e, 0x64, 0x65, 0x6e, 0x73, 0x65, 0x64, 0x44, 0x61,
  0x74, 0x61,
];

export function isJFRFormat(bytes: Uint8Array): boolean {
  if (bytes.length < 4) {
    return false;
  }
  return JFR_MAGIC.every((b, i) => bytes[i] === b);
}

export function isCJFRFormat(bytes: Uint8Array): boolean {
  if (bytes.length < CJFR_MAGIC.length) {
    return false;
  }
  return CJFR_MAGIC.every((b, i) => bytes[i] === b);
}

export async function convertJFRProfile(
  fileBytes: Uint8Array
): Promise<Profile | null> {
  if (!process.env.JFR_CONVERTER_ENABLED) {
    // Converter not built — WASM asset was absent at build time.
    return null;
  }

  const { parseJFRToProfile } = await import('./jfr-wasm/index');
  const profile = await parseJFRToProfile(fileBytes);
  return profile as unknown as Profile;
}

export async function convertCJFRProfile(
  fileBytes: Uint8Array
): Promise<Profile | null> {
  if (!process.env.JFR_CONVERTER_ENABLED) {
    return null;
  }

  const { parseCJFRToProfile } = await import('./jfr-wasm/index');
  const profile = await parseCJFRToProfile(fileBytes);
  return profile as unknown as Profile;
}
