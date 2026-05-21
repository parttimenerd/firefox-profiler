/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Custom (fork-only): the Function Table is a flat call-tree view that
// aggregates samples by function rather than call path. It uses the inverted
// CallNodeInfo (so each top-level row is one function) and only renders the
// roots — the tree is never expanded deeper. Most behavior mirrors CallTree;
// see that file for details on sorting, columns, and selection.

import { PureComponent } from 'react';
import memoize from 'memoize-immutable';
import explicitConnect from 'firefox-profiler/utils/connect';
import {
  TreeView,
  ColumnSortState,
} from 'firefox-profiler/components/shared/TreeView';
import { CallTreeEmptyReasons } from './CallTreeEmptyReasons';
import { Icon } from 'firefox-profiler/components/shared/Icon';
import {
  getImplementationFilter,
  getSearchStringsAsRegExp,
  getSelectedThreadsKey,
} from 'firefox-profiler/selectors/url-state';
import {
  getScrollToSelectionGeneration,
  getFocusCallTreeGeneration,
  getPreviewSelectionIsBeingModified,
  getCurrentTableViewOptions,
} from 'firefox-profiler/selectors/profile';
import { selectedThreadSelectors } from 'firefox-profiler/selectors/per-thread';
import {
  changeSelectedCallNode,
  changeRightClickedCallNode,
  changeExpandedCallNodes,
  addTransformToStack,
  handleCallNodeTransformShortcut,
  changeTableViewOptions,
  updateBottomBoxContentsAndMaybeOpen,
} from 'firefox-profiler/actions/profile-view';
import { assertExhaustiveCheck } from 'firefox-profiler/utils/types';

import type {
  State,
  ImplementationFilter,
  ThreadsKey,
  IndexIntoCallNodeTable,
  CallNodeDisplayData,
  WeightType,
  TableViewOptions,
  SelectionContext,
} from 'firefox-profiler/types';
import type { CallTree as CallTreeType } from 'firefox-profiler/profile-logic/call-tree';
import type { CallNodeInfo } from 'firefox-profiler/profile-logic/call-node-info';

import type {
  Column,
  MaybeResizableColumn,
} from 'firefox-profiler/components/shared/TreeView';
import type { ConnectedProps } from 'firefox-profiler/utils/connect';

import './CallTree.css';

type StateProps = {
  readonly threadsKey: ThreadsKey;
  readonly scrollToSelectionGeneration: number;
  readonly focusCallTreeGeneration: number;
  readonly tree: CallTreeType;
  readonly callNodeInfo: CallNodeInfo;
  readonly selectedCallNodeIndex: IndexIntoCallNodeTable | null;
  readonly rightClickedCallNodeIndex: IndexIntoCallNodeTable | null;
  readonly expandedCallNodeIndexes: Array<IndexIntoCallNodeTable | null>;
  readonly searchStringsRegExp: RegExp | null;
  readonly disableOverscan: boolean;
  readonly implementationFilter: ImplementationFilter;
  readonly callNodeMaxDepthPlusOne: number;
  readonly weightType: WeightType;
  readonly tableViewOptions: TableViewOptions;
};

type DispatchProps = {
  readonly changeSelectedCallNode: typeof changeSelectedCallNode;
  readonly changeRightClickedCallNode: typeof changeRightClickedCallNode;
  readonly changeExpandedCallNodes: typeof changeExpandedCallNodes;
  readonly addTransformToStack: typeof addTransformToStack;
  readonly handleCallNodeTransformShortcut: typeof handleCallNodeTransformShortcut;
  readonly updateBottomBoxContentsAndMaybeOpen: typeof updateBottomBoxContentsAndMaybeOpen;
  readonly onTableViewOptionsChange: (param: TableViewOptions) => any;
};

type Props = ConnectedProps<{}, StateProps, DispatchProps>;

class FunctionTableImpl extends PureComponent<Props> {
  _mainColumn: Column<CallNodeDisplayData> = {
    propName: 'name',
    titleL10nId: '',
  };
  _appendageColumn: Column<CallNodeDisplayData> = {
    propName: 'lib',
    titleL10nId: '',
  };
  _treeView: TreeView<CallNodeDisplayData> | null = null;
  _takeTreeViewRef = (treeView: TreeView<CallNodeDisplayData> | null) =>
    (this._treeView = treeView);

  _sortableColumns: ReadonlySet<string> = new Set(['self', 'total']);

  _toColumnSortState = memoize(
    (sortedColumns: TableViewOptions['sortedColumns']): ColumnSortState =>
      new ColumnSortState(sortedColumns ?? []),
    { limit: 1 }
  );

  _onSort = (sortedColumns: ColumnSortState) => {
    const { tableViewOptions, onTableViewOptionsChange } = this.props;
    onTableViewOptionsChange({
      ...tableViewOptions,
      sortedColumns: sortedColumns.sortedColumns,
    });
  };

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
              component: Icon as any,
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
              component: Icon as any,
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
              component: Icon as any,
              initialWidth: 10,
            },
          ];
        default:
          throw assertExhaustiveCheck(weightType, 'Unhandled WeightType.');
      }
    },
    { cache: new Map() }
  );

  override componentDidMount() {
    this.focus();

    if (this.props.selectedCallNodeIndex !== null && this._treeView) {
      this._treeView.scrollSelectionIntoView();
    }
  }

  override componentDidUpdate(prevProps: Props) {
    if (
      this.props.focusCallTreeGeneration > prevProps.focusCallTreeGeneration
    ) {
      this.focus();
    }

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

  _onSelectedCallNodeChange = (
    newSelectedCallNode: IndexIntoCallNodeTable,
    context: SelectionContext
  ) => {
    const { callNodeInfo, threadsKey, changeSelectedCallNode } = this.props;
    changeSelectedCallNode(
      threadsKey,
      callNodeInfo.getCallNodePathFromIndex(newSelectedCallNode),
      context
    );
  };

  _onRightClickSelection = (newSelectedCallNode: IndexIntoCallNodeTable) => {
    const { callNodeInfo, threadsKey, changeRightClickedCallNode } = this.props;
    changeRightClickedCallNode(
      threadsKey,
      callNodeInfo.getCallNodePathFromIndex(newSelectedCallNode)
    );
  };

  _onExpandedCallNodesChange = (
    newExpandedCallNodeIndexes: Array<IndexIntoCallNodeTable | null>
  ) => {
    const { callNodeInfo, threadsKey, changeExpandedCallNodes } = this.props;
    changeExpandedCallNodes(
      threadsKey,
      newExpandedCallNodeIndexes.map((callNodeIndex) =>
        callNodeInfo.getCallNodePathFromIndex(callNodeIndex)
      )
    );
  };

  _onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
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

  _onEnterOrDoubleClick = (nodeId: IndexIntoCallNodeTable) => {
    const { tree, updateBottomBoxContentsAndMaybeOpen } = this.props;
    const bottomBoxInfo = tree.getBottomBoxInfoForCallNode(nodeId);
    updateBottomBoxContentsAndMaybeOpen('function-table', bottomBoxInfo);
  };

  override render() {
    const {
      tree,
      selectedCallNodeIndex,
      rightClickedCallNodeIndex,
      expandedCallNodeIndexes,
      searchStringsRegExp,
      disableOverscan,
      callNodeMaxDepthPlusOne,
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
        maxNodeDepth={callNodeMaxDepthPlusOne}
        rowHeight={16}
        indentWidth={10}
        onKeyDown={this._onKeyDown}
        onEnterKey={this._onEnterOrDoubleClick}
        onDoubleClick={this._onEnterOrDoubleClick}
        viewOptions={tableViewOptions}
        onViewOptionsChange={onTableViewOptionsChange}
        sortableColumns={this._sortableColumns}
        initialSortedColumns={this._toColumnSortState(
          tableViewOptions.sortedColumns
        )}
        onSort={this._onSort}
      />
    );
  }
}

export const FunctionTable = explicitConnect<{}, StateProps, DispatchProps>({
  mapStateToProps: (state: State) => {
    const callNodeInfo = selectedThreadSelectors.getInvertedCallNodeInfo(state);
    return {
      threadsKey: getSelectedThreadsKey(state),
      scrollToSelectionGeneration: getScrollToSelectionGeneration(state),
      focusCallTreeGeneration: getFocusCallTreeGeneration(state),
      tree: selectedThreadSelectors.getFunctionListTree(state),
      callNodeInfo,
      selectedCallNodeIndex:
        selectedThreadSelectors.getSelectedCallNodeIndex(state),
      rightClickedCallNodeIndex:
        selectedThreadSelectors.getRightClickedCallNodeIndex(state),
      expandedCallNodeIndexes:
        selectedThreadSelectors.getExpandedCallNodeIndexes(state),
      searchStringsRegExp: getSearchStringsAsRegExp(state),
      disableOverscan: getPreviewSelectionIsBeingModified(state),
      implementationFilter: getImplementationFilter(state),
      callNodeMaxDepthPlusOne:
        selectedThreadSelectors.getFilteredCallNodeMaxDepthPlusOne(state),
      weightType: selectedThreadSelectors.getWeightTypeForCallTree(state),
      tableViewOptions: getCurrentTableViewOptions(state),
    };
  },
  mapDispatchToProps: {
    changeSelectedCallNode,
    changeRightClickedCallNode,
    changeExpandedCallNodes,
    addTransformToStack,
    handleCallNodeTransformShortcut,
    updateBottomBoxContentsAndMaybeOpen,
    onTableViewOptionsChange: (options: TableViewOptions) =>
      changeTableViewOptions('function-table', options),
  },
  component: FunctionTableImpl,
});
