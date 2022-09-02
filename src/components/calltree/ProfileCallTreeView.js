/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import React, { PureComponent } from 'react';
import type { ConnectedProps } from 'firefox-profiler/utils/connect';
import { StackSettings } from 'firefox-profiler/components/shared/StackSettings';
import { TransformNavigator } from 'firefox-profiler/components/shared/TransformNavigator';
import { selectedThreadSelectors } from '../../selectors/per-thread';
import type { CallNodeInfo, IndexIntoCallNodeTable } from '../../types';
import type { CallTree as CallTreeType } from 'firefox-profiler/profile-logic/call-tree';
import { CallTree } from './CallTree';
import explicitConnect from 'firefox-profiler/utils/connect';
import {
  changeSelectedCallNode,
  changeRightClickedCallNode,
  changeExpandedCallNodes,
} from 'firefox-profiler/actions/profile-view';
import type { TabSlug } from 'firefox-profiler/app-logic/tabs-handling';

type StateProps = {|
  +tabslug: TabSlug,
  +tree: CallTreeType,
  +callNodeInfo: CallNodeInfo,
  +selectedCallNodeIndex: IndexIntoCallNodeTable | null,
  +rightClickedCallNodeIndex: IndexIntoCallNodeTable | null,
  +expandedCallNodeIndexes: Array<IndexIntoCallNodeTable | null>,
  +callNodeMaxDepth: number,
|};

type DispatchProps = {|
  +changeSelectedCallNode: typeof changeSelectedCallNode,
  +changeRightClickedCallNode: typeof changeRightClickedCallNode,
  +changeExpandedCallNodes: typeof changeExpandedCallNodes,
|};

type Props = ConnectedProps<{||}, StateProps, DispatchProps>;

class ProfileCallTreeViewImpl extends PureComponent<Props> {
  render() {
    return (
      <div
        className="treeAndSidebarWrapper"
        id="calltree-tab"
        role="tabpanel"
        aria-labelledby="calltree-tab-button"
      >
        <StackSettings />
        <TransformNavigator />
        <CallTree {...this.props} />
      </div>
    );
  }
}

export const ProfileCallTreeView = explicitConnect<
  {||},
  StateProps,
  DispatchProps
>({
  mapStateToProps: (state) => ({
    tabslug: 'calltree',
    tree: selectedThreadSelectors.getCallTree(state),
    callNodeInfo: selectedThreadSelectors.getCallNodeInfo(state),
    selectedCallNodeIndex:
      selectedThreadSelectors.getSelectedCallNodeIndex(state),
    rightClickedCallNodeIndex:
      selectedThreadSelectors.getRightClickedCallNodeIndex(state),
    expandedCallNodeIndexes:
      selectedThreadSelectors.getExpandedCallNodeIndexes(state),
    // Use the filtered call node max depth, rather than the preview filtered call node
    // max depth so that the width of the TreeView component is stable across preview
    // selections.
    callNodeMaxDepth:
      selectedThreadSelectors.getFilteredCallNodeMaxDepth(state),
  }),
  mapDispatchToProps: {
    changeSelectedCallNode,
    changeRightClickedCallNode,
    changeExpandedCallNodes,
  },
  component: ProfileCallTreeViewImpl,
});
