/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow
import * as React from 'react';

import { getStackType } from 'firefox-profiler/profile-logic/transforms';
import { parseFileNameFromSymbolication } from 'firefox-profiler/utils/special-paths';
import { objectEntries } from 'firefox-profiler/utils/flow';
import { formatCallNodeNumberWithUnit } from 'firefox-profiler/utils/format-numbers';
import { Icon } from 'firefox-profiler/components/shared/Icon';
import {
  getFriendlyStackTypeName,
  getCategoryPairLabel,
  getLastCategoryPartLabel,
} from 'firefox-profiler/profile-logic/profile-data';

import type { CallTree } from 'firefox-profiler/profile-logic/call-tree';
import type {
  Thread,
  CategoryList,
  IndexIntoCallNodeTable,
  CallNodeDisplayData,
  CallNodeInfo,
  WeightType,
  Milliseconds,
  CallTreeSummaryStrategy,
  InnerWindowID,
  Page,
} from 'firefox-profiler/types';

import type {
  TimingsForPath,
  BreakdownByCategory,
} from 'firefox-profiler/profile-logic/profile-data';

import './CallNode.css';
import classNames from 'classnames';

const GRAPH_WIDTH = 150;
const GRAPH_HEIGHT = 10;

type Props = {|
  +thread: Thread,
  +weightType: WeightType,
  +innerWindowIDToPageMap: Map<InnerWindowID, Page> | null,
  +callNodeIndex: IndexIntoCallNodeTable,
  +callNodeInfo: CallNodeInfo,
  +categories: CategoryList,
  +interval: Milliseconds,
  // Since this tooltip can be used in different context, provide some kind of duration
  // label, e.g. "100ms" or "33%".
  +durationText: string,
  +callTree?: CallTree,
  +timings?: TimingsForPath,
  +callTreeSummaryStrategy: CallTreeSummaryStrategy,
  +displayStackType: boolean,
|};

/**
 * This class collects the tooltip rendering for anything that cares about call nodes.
 * This includes the Flame Graph and Stack Chart.
 */
export class TooltipCallNode extends React.PureComponent<Props> {
  _renderTimingsHeader(
    displayData: CallNodeDisplayData,
    selfTime: Milliseconds,
    totalTime: Milliseconds,
    addTooltipCategoryLabelClassToHeader: boolean,
    type: string
  ) {
    return (
      <>
        {/* grid row -------------------------------------------------- */}
        <div />
        <div className="tooltipCallNodeHeader" />
        <div className="tooltipCallNodeHeader">
          <span className="tooltipCallNodeHeaderSwatchRunning" />
          Running
        </div>
        <div className="tooltipCallNodeHeaderRight">
          <span className="tooltipCallNodeHeaderSwatchSelf" />
          Self
        </div>
        {/* grid row -------------------------------------------------- */}
        <div
          className={
            'tooltipLabel ' +
            (addTooltipCategoryLabelClassToHeader ? 'tooltipCategoryLabel' : '')
          }
        >
          Overall
        </div>
        <div className="tooltipCallNodeGraph">
          <div
            className={`tooltipCallNode${type}GraphRunning`}
            style={{
              width: GRAPH_WIDTH,
            }}
          />
          <div
            className={`tooltipCallNode${type}GraphSelf`}
            style={{
              width: (GRAPH_WIDTH * selfTime) / totalTime,
            }}
          />
        </div>
        <div
          className={
            'tooltipCallNodeTiming ' +
            (addTooltipCategoryLabelClassToHeader ? 'tooltipCategoryLabel' : '')
          }
        >
          {displayData.totalWithUnit}
        </div>
        <div
          className={
            'tooltipCallNodeTiming ' +
            (addTooltipCategoryLabelClassToHeader ? 'tooltipCategoryLabel' : '')
          }
        >
          {displayData.selfWithUnit}
        </div>
      </>
    );
  }

  _renderCategoryTimings(
    maybeTimings: ?TimingsForPath,
    maybeDisplayData: ?CallNodeDisplayData
  ) {
    if (!maybeTimings || !maybeDisplayData) {
      return null;
    }
    const { totalTime, selfTime } = maybeTimings.forPath;
    console.log(totalTime);
    const displayData = maybeDisplayData;
    if (!totalTime.breakdownByCategory) {
      return null;
    }

    const totalTimeBreakdownByCategory: BreakdownByCategory =
      totalTime.breakdownByCategory;

    const { thread, weightType, categories } = this.props;

    // JS Tracer threads have data relevant to the microsecond level.
    const isHighPrecision = Boolean(thread.isJsTracer);

    const categoriesAndTime: {
      category: number,
      subCategory: number,
      totalTime: number,
      selfTime: number,
    }[] = [];
    totalTimeBreakdownByCategory.forEach(
      ({ entireCategoryValue, subcategoryBreakdown }, category) => {
        if (entireCategoryValue === 0) {
          return;
        }
        const selfTimeValue = selfTime.breakdownByCategory
          ? selfTime.breakdownByCategory[category].entireCategoryValue
          : 0;
        categoriesAndTime.push({
          category,
          subCategory: -1,
          selfTime: selfTimeValue,
          totalTime: entireCategoryValue,
        });
        subcategoryBreakdown.forEach((self, subCategory) => {
          if (self === 0) {
            return;
          }
          const selfTimeValue = selfTime.breakdownByCategory
            ? selfTime.breakdownByCategory[category].subcategoryBreakdown[
                subCategory
              ]
            : 0;
          categoriesAndTime.push({
            category,
            subCategory: subCategory,
            selfTime: selfTimeValue,
            totalTime: self,
          });
        });
      }
    );

    return (
      <div className="tooltipCallNodeImplementation">
        {this._renderTimingsHeader(
          displayData,
          selfTime.value,
          totalTime.value,
          true,
          'Category'
        )}
        {categoriesAndTime.map((entry, index) => {
          const categoryColor = categories[entry.category].color;
          return (
            <React.Fragment key={index}>
              <div
                className={classNames({
                  tooltipCallNodeImplementationName: true,
                  tooltipLabel: true,
                  tooltipCategoryLabel: entry.subCategory === -1,
                })}
              >
                {getLastCategoryPartLabel(
                  categories,
                  entry.category,
                  entry.subCategory
                )}
              </div>
              <div
                className={
                  'tooltipCallNodeGraph ' +
                  (entry.subCategory === -1 ? 'tooltipCategoryLabel' : '')
                }
              >
                <div
                  className={`tooltipCallNodeCategoryGraphRunning category-color-${categoryColor}`}
                  style={{
                    width: (GRAPH_WIDTH * entry.totalTime) / totalTime.value,
                  }}
                />
                <div
                  className={`tooltipCallNodeCategoryGraphSelf category-color-${categoryColor}`}
                  style={{
                    width: (GRAPH_WIDTH * entry.selfTime) / totalTime.value,
                  }}
                />
              </div>
              <div
                className={
                  'tooltipCallNodeImplementationTiming ' +
                  (entry.subCategory === -1 ? 'tooltipCategoryLabel' : '')
                }
              >
                {formatCallNodeNumberWithUnit(
                  weightType,
                  isHighPrecision,
                  entry.totalTime
                )}
              </div>
              <div
                className={
                  'tooltipCallNodeImplementationTiming ' +
                  (entry.subCategory === -1 ? 'tooltipCategoryLabel' : '')
                }
              >
                {self === 0
                  ? '—'
                  : formatCallNodeNumberWithUnit(
                      weightType,
                      isHighPrecision,
                      entry.selfTime
                    )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  _canRenderImplementationTimings(
    maybeTimings: ?TimingsForPath,
    maybeDisplayData: ?CallNodeDisplayData
  ) {
    if (!maybeTimings || !maybeDisplayData) {
      return false;
    }
    const { totalTime } = maybeTimings.forPath;
    if (!totalTime.breakdownByImplementation) {
      return false;
    }
    return true;
  }

  _renderImplementationTimings(
    maybeTimings: ?TimingsForPath,
    maybeDisplayData: ?CallNodeDisplayData
  ) {
    if (!maybeTimings || !maybeDisplayData) {
      return null;
    }
    const { totalTime, selfTime } = maybeTimings.forPath;
    const displayData = maybeDisplayData;
    if (!totalTime.breakdownByImplementation) {
      return null;
    }

    const sortedTotalBreakdownByImplementation = objectEntries(
      totalTime.breakdownByImplementation
    ).sort((a, b) => b[1] - a[1]);
    const { thread, weightType } = this.props;

    // JS Tracer threads have data relevant to the microsecond level.
    const isHighPrecision = Boolean(thread.isJsTracer);

    return (
      <div className="tooltipCallNodeImplementation">
        {this._renderTimingsHeader(
          displayData,
          selfTime.value,
          totalTime.value,
          false,
          'Implementation'
        )}
        {/* grid row -------------------------------------------------- */}
        {sortedTotalBreakdownByImplementation.map(
          ([implementation, time], index) => {
            let selfTimeValue = 0;
            if (selfTime.breakdownByImplementation) {
              selfTimeValue =
                selfTime.breakdownByImplementation[implementation] || 0;
            }

            return (
              <React.Fragment key={index}>
                <div className="tooltipCallNodeImplementationName tooltipLabel">
                  {getFriendlyStackTypeName(implementation)}
                </div>
                <div className="tooltipCallNodeGraph">
                  <div
                    className="tooltipCallNodeImplementationGraphRunning"
                    style={{
                      width: (GRAPH_WIDTH * time) / totalTime.value,
                    }}
                  />
                  <div
                    className="tooltipCallNodeImplementationGraphSelf"
                    style={{
                      width: (GRAPH_WIDTH * selfTimeValue) / totalTime.value,
                    }}
                  />
                </div>
                <div className="tooltipCallNodeImplementationTiming">
                  {formatCallNodeNumberWithUnit(
                    weightType,
                    isHighPrecision,
                    time
                  )}
                </div>
                <div className="tooltipCallNodeImplementationTiming">
                  {selfTimeValue === 0
                    ? '—'
                    : formatCallNodeNumberWithUnit(
                        weightType,
                        isHighPrecision,
                        selfTimeValue
                      )}
                </div>
              </React.Fragment>
            );
          }
        )}
      </div>
    );
  }

  render() {
    const {
      callNodeIndex,
      thread,
      durationText,
      categories,
      callTree,
      timings,
      callTreeSummaryStrategy,
      innerWindowIDToPageMap,
      callNodeInfo: { callNodeTable },
      displayStackType,
    } = this.props;
    const categoryIndex = callNodeTable.category[callNodeIndex];
    const categoryColor = categories[categoryIndex].color;
    const subcategoryIndex = callNodeTable.subcategory[callNodeIndex];
    const funcIndex = callNodeTable.func[callNodeIndex];
    const innerWindowID = callNodeTable.innerWindowID[callNodeIndex];
    const funcStringIndex = thread.funcTable.name[funcIndex];
    const funcName = thread.stringTable.getString(funcStringIndex);

    let displayData;
    if (callTree) {
      displayData = callTree.getDisplayData(callNodeIndex);
    }

    let fileName = null;

    const fileNameIndex = thread.funcTable.fileName[funcIndex];
    if (fileNameIndex !== null) {
      let fileNameURL = thread.stringTable.getString(fileNameIndex);
      // fileNameURL could be a path from symbolication (potentially using "special path"
      // syntax, e.g. hg:...), or it could be a URL, if the function is a JS function.
      // If it's a path from symbolication, strip it down to just the actual path.
      fileNameURL = parseFileNameFromSymbolication(fileNameURL).path;

      // JS functions have information about where the function starts.
      // Add :<line>:<col> to the URL, if known.
      const lineNumber = thread.funcTable.lineNumber[funcIndex];
      if (lineNumber !== null) {
        fileNameURL += ':' + lineNumber;
        const columnNumber = thread.funcTable.columnNumber[funcIndex];
        if (columnNumber !== null) {
          fileNameURL += ':' + columnNumber;
        }
      }

      // Because of our use of Grid Layout, all our elements need to be direct
      // children of the grid parent. That's why we use arrays here, to add
      // the elements as direct children.
      fileName = [
        <div className="tooltipLabel" key="file">
          File:
        </div>,
        <div className="tooltipDetailsUrl" key="fileVal">
          {fileNameURL}
        </div>,
      ];
    }

    let resource = null;
    const resourceIndex = thread.funcTable.resource[funcIndex];

    if (resourceIndex !== -1) {
      const resourceNameIndex = thread.resourceTable.name[resourceIndex];
      // Because of our use of Grid Layout, all our elements need to be direct
      // children of the grid parent. That's why we use arrays here, to add
      // the elements as direct children.
      resource = [
        <div className="tooltipLabel" key="resource">
          Resource:
        </div>,
        thread.stringTable.getString(resourceNameIndex),
      ];
    }

    // Finding current frame and parent frame URL(if there is).
    let pageAndParentPageURL;
    if (innerWindowIDToPageMap) {
      const page = innerWindowIDToPageMap.get(innerWindowID);
      if (page) {
        if (page.embedderInnerWindowID !== 0) {
          // This is an iframe since it has an embedder.
          pageAndParentPageURL = [
            <div className="tooltipLabel" key="iframe">
              iframe URL:
            </div>,
            <div className="tooltipDetailsUrl" key="iframeVal">
              {page.url}
            </div>,
          ];

          // Getting the embedder URL now.
          const parentPage = innerWindowIDToPageMap.get(
            page.embedderInnerWindowID
          );
          // Ideally it should find a page.
          if (parentPage) {
            pageAndParentPageURL.push(
              <div className="tooltipLabel" key="page">
                Page URL:
              </div>,
              <div key="pageVal">
                {parentPage.url}
                {parentPage.isPrivateBrowsing ? ' (private)' : null}
              </div>
            );
          }
        } else {
          // This is a regular page without an embedder.
          pageAndParentPageURL = [
            <div className="tooltipLabel" key="page">
              Page URL:
            </div>,
            <div className="tooltipDetailsUrl" key="pageVal">
              {page.url}
              {page.isPrivateBrowsing ? ' (private)' : null}
            </div>,
          ];
        }
      }
    }

    const stackType = getStackType(thread, funcIndex);
    let stackTypeLabel;
    switch (stackType) {
      case 'native':
        stackTypeLabel = 'Native';
        break;
      case 'js':
        stackTypeLabel = 'JavaScript';
        break;
      case 'unsymbolicated':
        stackTypeLabel = thread.funcTable.isJS[funcIndex]
          ? 'Unsymbolicated native'
          : 'Unsymbolicated or generated JIT instructions';
        break;
      default:
        throw new Error(`Unknown stack type case "${stackType}".`);
    }

    return (
      <div
        className="tooltipCallNode"
        style={{
          '--graph-width': GRAPH_WIDTH + 'px',
          '--graph-height': GRAPH_HEIGHT + 'px',
        }}
      >
        <div className="tooltipOneLine tooltipHeader">
          <div className="tooltipTiming">{durationText}</div>
          <div className="tooltipTitle">{funcName}</div>
          <div className="tooltipIcon">
            {displayData && displayData.icon ? (
              <Icon displayData={displayData} />
            ) : null}
          </div>
        </div>
        <div className="tooltipCallNodeDetails">
          {this._canRenderImplementationTimings(timings, displayData)
            ? this._renderImplementationTimings(timings, displayData)
            : this._renderCategoryTimings(timings, displayData)}
          {callTreeSummaryStrategy !== 'timing' && displayData ? (
            <div className="tooltipDetails tooltipCallNodeDetailsLeft">
              {/* Everything in this div needs to come in pairs of two in order to
                respect the CSS grid. */}
              <div className="tooltipLabel">Total Bytes:</div>
              <div>{displayData.totalWithUnit}</div>
              {/* --------------------------------------------------------------- */}
              <div className="tooltipLabel">Self Bytes:</div>
              <div>{displayData.selfWithUnit}</div>
              {/* --------------------------------------------------------------- */}
            </div>
          ) : null}
          <div className="tooltipDetails tooltipCallNodeDetailsLeft">
            {/* Everything in this div needs to come in pairs of two in order to
                respect the CSS grid. */}
            {displayStackType ? (
              <>
                <div className="tooltipLabel">Stack Type:</div>
                <div>{stackTypeLabel}</div>
              </>
            ) : null}
            {/* --------------------------------------------------------------- */}
            <div className="tooltipLabel">Category:</div>
            <div>
              <span
                className={`colored-square category-color-${categoryColor}`}
              />
              {getCategoryPairLabel(
                categories,
                categoryIndex,
                subcategoryIndex
              )}
            </div>
            {/* --------------------------------------------------------------- */}
            {pageAndParentPageURL}
            {fileName}
            {resource}
          </div>
        </div>
      </div>
    );
  }
}
