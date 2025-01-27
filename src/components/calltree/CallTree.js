/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

import React, { PureComponent } from 'react';
import memoize from 'memoize-immutable';
import explicitConnect from 'firefox-profiler/utils/connect';
import {
  TreeView,
  ColumnSortState,
} from 'firefox-profiler/components/shared/TreeView';
import { CallTreeEmptyReasons } from './CallTreeEmptyReasons';
import { Icon } from 'firefox-profiler/components/shared/Icon';
import { getCallNodePathFromIndex } from 'firefox-profiler/profile-logic/profile-data';
import {
  getInvertCallstack,
  getImplementationFilter,
  getSearchStringsAsRegExp,
  getSelectedThreadsKey,
} from 'firefox-profiler/selectors/url-state';
import {
  getScrollToSelectionGeneration,
  getFocusCallTreeGeneration,
  getPreviewSelection,
  getCategories,
  getCurrentTableViewOptions,
} from 'firefox-profiler/selectors/profile';
import { selectedThreadSelectors } from 'firefox-profiler/selectors/per-thread';
import {
  changeSelectedCallNode,
  changeRightClickedCallNode,
  changeExpandedCallNodes,
  addTransformToStack,
  handleCallNodeTransformShortcut,
  openSourceView,
} from 'firefox-profiler/actions/profile-view';
import { assertExhaustiveCheck } from 'firefox-profiler/utils/flow';

import type {
  State,
  ImplementationFilter,
  ThreadsKey,
  CallNodeInfo,
  CategoryList,
  IndexIntoCallNodeTable,
  CallNodeDisplayData,
  WeightType,
  TableViewOptions,
} from 'firefox-profiler/types';
import type { TabSlug } from 'firefox-profiler/app-logic/tabs-handling';
import type { CallTree as CallTreeType } from 'firefox-profiler/profile-logic/call-tree';

import type {
  Column,
  MaybeResizableColumn,
} from 'firefox-profiler/components/shared/TreeView';
import type { ConnectedProps } from 'firefox-profiler/utils/connect';

import './CallTree.css';

type StateProps = {|
  +threadsKey: ThreadsKey,
  +scrollToSelectionGeneration: number,
  +focusCallTreeGeneration: number,
  +searchStringsRegExp: RegExp | null,
  +disableOverscan: boolean,
  +invertCallstack: boolean,
  +implementationFilter: ImplementationFilter,
  +weightType: WeightType,
  +tableViewOptions: TableViewOptions,
  +categories: CategoryList,
|};

type DispatchProps = {|
  +addTransformToStack: typeof addTransformToStack,
  +handleCallNodeTransformShortcut: typeof handleCallNodeTransformShortcut,
  +openSourceView: typeof openSourceView,
|};

type Props = {|
  tabslug: TabSlug,
  tree: CallTreeType,
  callNodeInfo: CallNodeInfo,
  +selectedCallNodeIndex: IndexIntoCallNodeTable | null,
  +rightClickedCallNodeIndex: IndexIntoCallNodeTable | null,
  +expandedCallNodeIndexes: Array<IndexIntoCallNodeTable | null>,
  +callNodeMaxDepth: number,

  // dispatchers
  +changeSelectedCallNode: typeof changeSelectedCallNode,
  +changeRightClickedCallNode?: typeof changeRightClickedCallNode,
  +changeExpandedCallNodes?: typeof changeExpandedCallNodes,
  +onTableViewOptionsChange: (TableViewOptions) => any,
|};

type AllProps = ConnectedProps<Props, StateProps, DispatchProps>;

class CallTreeImpl extends PureComponent<AllProps> {
  _mainColumn: Column<CallNodeDisplayData> = {
    propName: 'name',
    titleL10nId: '',
  };
  _appendageColumn: Column<CallNodeDisplayData> = {
    propName: 'lib',
    titleL10nId: '',
  };
  _treeView: TreeView<CallNodeDisplayData> | null = null;
  _takeTreeViewRef = (treeView) => (this._treeView = treeView);
  _sortableColumns = new Set(['self', 'total']);
  _sortedColumns = new ColumnSortState([{ column: 'total', ascending: false }]);

  /**
   * Call Trees can have different types of "weights" for the data. Choose the
   * appropriate labels for the call tree based on this weight.
   */
  _weightTypeToColumns = memoize(
    (weightType: WeightType): MaybeResizableColumn<CallNodeDisplayData>[] => {
      switch (weightType) {
        case 'tracing-ms':
          return [
            {
              propName: 'totalPercent',
              titleL10nId: '',
              initialWidth: 50,
              hideDividerAfter: true,
            },
            {
              propName: 'total',
              titleL10nId: 'CallTree--tracing-ms-total',
              minWidth: 30,
              initialWidth: 70,
              resizable: true,
              headerWidthAdjustment: 50,
            },
            {
              propName: 'self',
              titleL10nId: 'CallTree--tracing-ms-self',
              minWidth: 30,
              initialWidth: 70,
              resizable: true,
            },
            {
              propName: 'icon',
              titleL10nId: '',
              component: Icon,
              initialWidth: 10,
            },
          ];
        case 'samples':
          return [
            {
              propName: 'totalPercent',
              titleL10nId: '',
              initialWidth: 50,
              hideDividerAfter: true,
            },
            {
              propName: 'total',
              titleL10nId: 'CallTree--samples-total',
              minWidth: 30,
              initialWidth: 70,
              resizable: true,
              headerWidthAdjustment: 50,
            },
            {
              propName: 'self',
              titleL10nId: 'CallTree--samples-self',
              minWidth: 30,
              initialWidth: 70,
              resizable: true,
            },
            {
              propName: 'icon',
              titleL10nId: '',
              component: Icon,
              initialWidth: 10,
            },
          ];
        case 'bytes':
          return [
            {
              propName: 'totalPercent',
              titleL10nId: '',
              initialWidth: 50,
              hideDividerAfter: true,
            },
            {
              propName: 'total',
              titleL10nId: 'CallTree--bytes-total',
              minWidth: 30,
              initialWidth: 140,
              resizable: true,
              headerWidthAdjustment: 50,
            },
            {
              propName: 'self',
              titleL10nId: 'CallTree--bytes-self',
              minWidth: 30,
              initialWidth: 90,
              resizable: true,
            },
            {
              propName: 'icon',
              titleL10nId: '',
              component: Icon,
              initialWidth: 10,
            },
          ];
        default:
          throw assertExhaustiveCheck(weightType, 'Unhandled WeightType.');
      }
    },
    // Use a Map cache, as the function only takes one argument, which is a simple string.
    { cache: new Map() }
  );

  componentDidMount() {
    this.focus();
    this.maybeProcureInterestingInitialSelection();

    if (this.props.selectedCallNodeIndex === null && this._treeView) {
      this._treeView.scrollSelectionIntoView();
    }
  }

  componentDidUpdate(prevProps) {
    if (
      this.props.focusCallTreeGeneration > prevProps.focusCallTreeGeneration
    ) {
      this.focus();
    }

    this.maybeProcureInterestingInitialSelection();

    if (
      this.props.selectedCallNodeIndex !== null &&
      this.props.scrollToSelectionGeneration >
        prevProps.scrollToSelectionGeneration &&
      this._treeView
    ) {
      this._treeView.scrollSelectionIntoView();
    }
  }

  focus() {
    if (this._treeView) {
      this._treeView.focus();
    }
  }

  _onSelectedCallNodeChange = (newSelectedCallNode: IndexIntoCallNodeTable) => {
    const { callNodeInfo, threadsKey, changeSelectedCallNode } = this.props;
    changeSelectedCallNode(
      threadsKey,
      getCallNodePathFromIndex(newSelectedCallNode, callNodeInfo.callNodeTable)
    );
  };

  _onRightClickSelection = (newSelectedCallNode: IndexIntoCallNodeTable) => {
    const { callNodeInfo, threadsKey, changeRightClickedCallNode } = this.props;
    if (changeRightClickedCallNode) {
      changeRightClickedCallNode(
        threadsKey,
        getCallNodePathFromIndex(
          newSelectedCallNode,
          callNodeInfo.callNodeTable
        )
      );
    }
  };

  _onExpandedCallNodesChange = (
    newExpandedCallNodeIndexes: Array<IndexIntoCallNodeTable | null>
  ) => {
    const { callNodeInfo, threadsKey, changeExpandedCallNodes } = this.props;
    if (changeExpandedCallNodes) {
      changeExpandedCallNodes(
        threadsKey,
        newExpandedCallNodeIndexes.map((callNodeIndex) =>
          getCallNodePathFromIndex(callNodeIndex, callNodeInfo.callNodeTable)
        )
      );
    }
  };

  _onKeyDown = (event: SyntheticKeyboardEvent<>) => {
    const {
      selectedCallNodeIndex,
      rightClickedCallNodeIndex,
      handleCallNodeTransformShortcut,
      threadsKey,
    } = this.props;

    const nodeIndex =
      rightClickedCallNodeIndex !== null
        ? rightClickedCallNodeIndex
        : selectedCallNodeIndex;
    if (nodeIndex === null) {
      return;
    }
    handleCallNodeTransformShortcut(event, threadsKey, nodeIndex);
  };

  _onEnter = (
    nodeId: IndexIntoCallNodeTable,
    event: SyntheticKeyboardEvent<>
  ) => {
    const { tree, openSourceView, tabslug } = this.props;
    tree.handleOpenSourceView(
      nodeId,
      (file, name) => openSourceView(file, name, tabslug),
      event.shiftKey
    );
  };

  _onDoubleClick = (
    nodeId: IndexIntoCallNodeTable,
    event: SyntheticMouseEvent<>
  ) => {
    const { tree, openSourceView, tabslug } = this.props;
    tree.handleOpenSourceView(
      nodeId,
      (file, name) => openSourceView(file, name, tabslug),
      event.shiftKey
    );
  };

  maybeProcureInterestingInitialSelection() {
    // Expand the heaviest callstack up to a certain depth and select the frame
    // at that depth.
    const {
      tree,
      expandedCallNodeIndexes,
      selectedCallNodeIndex,
      callNodeInfo: { callNodeTable },
      categories,
    } = this.props;

    if (selectedCallNodeIndex !== null || expandedCallNodeIndexes.length > 0) {
      // Let's not change some existing state.
      return;
    }

    const idleCategoryIndex = categories.findIndex(
      (category) => category.name === 'Idle'
    );

    const newExpandedCallNodeIndexes = expandedCallNodeIndexes.slice();
    const maxInterestingDepth = 17; // scientifically determined
    let currentCallNodeIndex = tree.getRoots()[0];
    if (currentCallNodeIndex === undefined) {
      // This tree is empty.
      return;
    }
    newExpandedCallNodeIndexes.push(currentCallNodeIndex);
    for (let i = 0; i < maxInterestingDepth; i++) {
      const children = tree.getChildren(currentCallNodeIndex);
      if (children.length === 0) {
        break;
      }

      // Let's find if there's a non idle children.
      const firstNonIdleNode = children.find(
        (nodeIndex) => callNodeTable.category[nodeIndex] !== idleCategoryIndex
      );

      // If there's a non idle children, use it; otherwise use the first
      // children (that will be idle).
      currentCallNodeIndex =
        firstNonIdleNode !== undefined ? firstNonIdleNode : children[0];
      newExpandedCallNodeIndexes.push(currentCallNodeIndex);
    }
    this._onExpandedCallNodesChange(newExpandedCallNodeIndexes);

    const categoryIndex = callNodeTable.category[currentCallNodeIndex];
    if (categoryIndex !== idleCategoryIndex) {
      // If we selected the call node with a "idle" category, we'd have a
      // completely dimmed activity graph because idle stacks are not drawn in
      // this graph. Because this isn't probably what the average user wants we
      // do it only when the category is something different.
      this._onSelectedCallNodeChange(currentCallNodeIndex);
    }
  }

  _onSort = (sortedColumns: ColumnSortState) => {
    this._sortedColumns = sortedColumns;
  };

  render() {
    const {
      tree,
      selectedCallNodeIndex,
      rightClickedCallNodeIndex,
      expandedCallNodeIndexes,
      searchStringsRegExp,
      disableOverscan,
      callNodeMaxDepth,
      weightType,
      tableViewOptions,
      onTableViewOptionsChange,
    } = this.props;
    if (tree.getRoots().length === 0) {
      return <CallTreeEmptyReasons />;
    }
    return (
      <TreeView
        tree={tree}
        fixedColumns={this._weightTypeToColumns(weightType)}
        mainColumn={this._mainColumn}
        appendageColumn={this._appendageColumn}
        onSelectionChange={this._onSelectedCallNodeChange}
        onRightClickSelection={this._onRightClickSelection}
        onExpandedNodesChange={this._onExpandedCallNodesChange}
        selectedNodeId={selectedCallNodeIndex}
        rightClickedNodeId={rightClickedCallNodeIndex}
        expandedNodeIds={expandedCallNodeIndexes}
        highlightRegExp={searchStringsRegExp}
        disableOverscan={disableOverscan}
        ref={this._takeTreeViewRef}
        contextMenuId="CallNodeContextMenu"
        maxNodeDepth={callNodeMaxDepth}
        rowHeight={16}
        indentWidth={10}
        onKeyDown={this._onKeyDown}
        onEnterKey={this._onEnter}
        onDoubleClick={this._onDoubleClick}
        viewOptions={tableViewOptions}
        onViewOptionsChange={onTableViewOptionsChange}
        initialSortedColumns={this._sortedColumns}
        onSort={this._onSort}
        sortableColumns={this._sortableColumns}
      />
    );
  }
}

export const CallTree = explicitConnect<Props, StateProps, DispatchProps>({
  mapStateToProps: (state: State) => ({
    threadsKey: getSelectedThreadsKey(state),
    scrollToSelectionGeneration: getScrollToSelectionGeneration(state),
    focusCallTreeGeneration: getFocusCallTreeGeneration(state),
    searchStringsRegExp: getSearchStringsAsRegExp(state),
    disableOverscan: getPreviewSelection(state).isModifying,
    invertCallstack: getInvertCallstack(state),
    implementationFilter: getImplementationFilter(state),
    weightType: selectedThreadSelectors.getWeightTypeForCallTree(state),
    tableViewOptions: getCurrentTableViewOptions(state),
    categories: getCategories(state),
  }),
  mapDispatchToProps: {
    addTransformToStack,
    handleCallNodeTransformShortcut,
    openSourceView,
  },
  component: CallTreeImpl,
});
