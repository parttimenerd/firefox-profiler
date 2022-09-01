/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import React, { PureComponent } from 'react';
import type { ConnectedProps } from 'firefox-profiler/utils/connect';
import { StackSettings } from 'firefox-profiler/components/shared/StackSettings';
import { TransformNavigator } from 'firefox-profiler/components/shared/TransformNavigator';
import { selectedThreadSelectors } from '../../selectors/per-thread';
import type { CallNodeInfo } from '../../types';
import type { CallTree as CallTreeType } from 'firefox-profiler/profile-logic/call-tree';
import { CallTree } from './CallTree';
import explicitConnect from 'firefox-profiler/utils/connect';

type StateProps = {|
  +tree: CallTreeType,
  +callNodeInfo: CallNodeInfo,
|};

type Props = ConnectedProps<{||}, StateProps, {||}>;

class ProfileCallTreeViewImpl extends PureComponent<Props> {
  render() {
    const { tree, callNodeInfo } = this.props;
    return (
      <div
        className="treeAndSidebarWrapper"
        id="calltree-tab"
        role="tabpanel"
        aria-labelledby="calltree-tab-button"
      >
        <StackSettings />
        <TransformNavigator />
        <CallTree tree={tree} callNodeInfo={callNodeInfo} />
      </div>
    );
  }
}

export const ProfileCallTreeView = explicitConnect<{||}, StateProps, {||}>({
  mapStateToProps: (state) => ({
    tree: selectedThreadSelectors.getCallTree(state),
    callNodeInfo: selectedThreadSelectors.getCallNodeInfo(state),
  }),
  component: ProfileCallTreeViewImpl,
});
