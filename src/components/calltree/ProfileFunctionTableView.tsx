/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Custom (fork-only): see FunctionTable for details.

import { FunctionTable } from './FunctionTable';
import { StackSettings } from 'firefox-profiler/components/shared/StackSettings';
import { TransformNavigator } from 'firefox-profiler/components/shared/TransformNavigator';

export const ProfileFunctionTableView = () => (
  <div
    className="treeAndSidebarWrapper"
    id="function-table-tab"
    role="tabpanel"
    aria-labelledby="function-table-tab-button"
  >
    <StackSettings />
    <TransformNavigator />
    <FunctionTable />
  </div>
);
