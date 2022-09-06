/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import * as React from 'react';
import { Localized } from '@fluent/react';
import {
  getMarkerSchemaByName,
  getProfileExtraInfo,
} from 'firefox-profiler/selectors/profile';
import explicitConnect from 'firefox-profiler/utils/connect';
import { formatFromMarkerSchema } from 'firefox-profiler/profile-logic/marker-schema';
import type {
  ExtraProfileInfoSection,
  MarkerSchemaByName,
} from 'firefox-profiler/types';
import type { ConnectedProps } from 'firefox-profiler/utils/connect';

import './MoreInfoPanel.css';

type OwnProps = {|
  +open: boolean,
  +onPanelClose: () => void,
|};

type StateProps = {|
  +profileExtraInfo: ExtraProfileInfoSection[],
  +markerSchemaByName: MarkerSchemaByName,
  +open: boolean,
  +onPanelClose: () => void,
|};

type Props = ConnectedProps<OwnProps, StateProps, {||}>;

/**
 * This component formats the profile's more information panel,
 * containing all markers that should be displayed there
 */
class MoreInfoPanelImpl extends React.PureComponent<Props> {
  _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this.closePanel();
    }
  };

  _onClickOutside = (_: MouseEvent) => {
    this.closePanel();
  };

  _onClickInside = (e: MouseEvent) => {
    e.stopPropagation();
  };

  componentDidMount() {
    // the panel can be closed by pressing the Esc key
    window.addEventListener('keydown', this._onKeyDown);
    // or by clicking outside of the panel
    window.addEventListener('click', this._onClickOutside);
  }

  componentWillUnmount() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('click', this._onClickOutside);
  }

  closePanel() {
    this.props.onPanelClose();
  }

  _renderSection(section: ExtraProfileInfoSection) {
    return (
      <div key={section.label}>
        <h2 className="moreInfoSubTitle" key={'title ' + section.label}>
          {section.label}
        </h2>
        <div className="moreInfoSection" key={'section ' + section.label}>
          {section.entries.map(({ label, format, value }) => {
            return (
              <div className="moreInfoRow" key={label}>
                <span className="moreInfoLabel">{label}</span>
                <div>{formatFromMarkerSchema('moreInfo', format, value)}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  render() {
    const { open } = this.props;
    if (!open) {
      return <div></div>;
    }
    return (
      <div className="moreInfoContainerVoid">
        <div className="moreInfoContainer">
          <div className="moreInfoContent" onClick={this._onClickInside}>
            <h1 className="moreInfoTitle">
              <Localized id="MenuButtons--moreInfo-title">
                Additional Profile Information
              </Localized>
            </h1>
            {this.props.profileExtraInfo.map(this._renderSection)}
          </div>
        </div>
      </div>
    );
  }
}

export const MoreInfoPanel = explicitConnect<OwnProps, StateProps, {||}>({
  mapStateToProps: (state, ownProps) => {
    return {
      profileExtraInfo: getProfileExtraInfo(state),
      markerSchemaByName: getMarkerSchemaByName(state),
      ...ownProps,
    };
  },
  component: MoreInfoPanelImpl,
});
