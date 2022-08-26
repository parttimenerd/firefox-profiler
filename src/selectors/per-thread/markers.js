/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import { createSelector } from 'reselect';
import { stripIndent } from 'common-tags';

import * as UrlState from '../url-state';
import * as MarkerData from '../../profile-logic/marker-data';
import * as MarkerTimingLogic from '../../profile-logic/marker-timing';
import * as ProfileSelectors from '../profile';
import { getRightClickedMarkerInfo } from '../right-clicked-marker';
import { getLabelGetter } from '../../profile-logic/marker-schema';
import { getInclusiveSampleIndexRangeForSelection } from '../../profile-logic/profile-data';

import type { ThreadSelectorsPerThread } from './thread';
import type {
  RawMarkerTable,
  ThreadIndex,
  MarkerIndex,
  Marker,
  MarkerTiming,
  MarkerTimingAndBuckets,
  DerivedMarkerInfo,
  IndexedArray,
  IndexIntoRawMarkerTable,
  Selector,
  $ReturnType,
  ThreadsKey,
  Tid,
  MarkerSchema,
  MarkerTrackConfig,
  CollectedCustomMarkerSamples,
  IndexIntoSamplesTable,
} from 'firefox-profiler/types';

/**
 * Infer the return type from the getMarkerSelectorsPerThread function. This
 * is done that so that the local type definition with `Selector<T>` is the canonical
 * definition for the type of the selector.
 */
export type MarkerSelectorsPerThread = $ReturnType<
  typeof getMarkerSelectorsPerThread
>;

/**
 * Create the selectors for a thread that have to do with either markers.
 */
export function getMarkerSelectorsPerThread(
  threadSelectors: ThreadSelectorsPerThread,
  threadIndexes: Set<ThreadIndex>,
  threadsKey: ThreadsKey
) {
  const _getRawMarkerTable: Selector<RawMarkerTable> = (state) => {
    return threadSelectors.getThread(state).markers;
  };

  /**
   * Similar to thread filtering, the markers can be filtered as well, and it's
   * important to use the right type of filtering for the view. The steps for filtering
   * markers are a bit different, since markers can be valid over ranges, and need a
   * bit more processing in order to get into a correct state. There are a few
   * variants of the selectors that are created for specific views that have been
   * omitted, but the ordered steps below give the general picture.
   *
   * 1. _getRawMarkerTable         - Get the RawMarkerTable from the current thread.
   * 2a. _getDerivedMarkers        - Match up start/end markers, and start
   *                                 returning the Marker[] type.
   * 2b. _getDerivedJankMarkers    - Jank markers come from our samples data, and
   *                                 this selector returns Marker structures out of
   *                                 the samples structure.
   * 3. getFullMarkerList          - Concatenates and sorts all markers coming from
   *                                 different origin structures.
   * 4. getFullMarkerListIndexes   - From the full marker list, generates an array
   *                                 containing the sequence of indexes for all markers.
   * 5. getCommittedRangeFilteredMarkerIndexes - Apply the committed range.
   * 6. getSearchFilteredMarkerIndexes         - Apply the search string
   * 7. getPreviewFilteredMarkerIndexes        - Apply the preview range
   *
   * Selectors are commonly written using the utility filterMarkerIndexesCreator
   * (see below for more information about this function).
   */

  const _getThreadId: Selector<Tid> = (state) =>
    threadSelectors.getThread(state).tid;

  /* This selector exposes the result of the processing of the raw marker table
   * into our Marker structure that we use in the rest of our code. This is the
   * very start of our marker pipeline. */
  const getDerivedMarkerInfo: Selector<DerivedMarkerInfo> = createSelector(
    _getRawMarkerTable,
    threadSelectors.getStringTable,
    _getThreadId,
    threadSelectors.getThreadRange,
    ProfileSelectors.getIPCMarkerCorrelations,
    MarkerData.deriveMarkersFromRawMarkerTable
  );

  const _getDerivedMarkers: Selector<Marker[]> = createSelector(
    getDerivedMarkerInfo,
    ({ markers }) => markers
  );

  const getMarkerIndexToRawMarkerIndexes: Selector<
    IndexedArray<MarkerIndex, IndexIntoRawMarkerTable[]>
  > = createSelector(
    getDerivedMarkerInfo,
    ({ markerIndexToRawMarkerIndexes }) => markerIndexToRawMarkerIndexes
  );

  /**
   * This selector constructs jank markers from the responsiveness data.
   */
  const _getDerivedJankMarkers: Selector<Marker[]> = createSelector(
    threadSelectors.getSamplesTable,
    ProfileSelectors.getDefaultCategory,
    (samples, defaultCategory) =>
      MarkerData.deriveJankMarkers(samples, 50, defaultCategory)
  );

  /**
   * This selector returns the list of all markers, this is our reference list
   * that MarkerIndex values refer to.
   */
  const getFullMarkerList: Selector<Marker[]> = createSelector(
    _getDerivedMarkers,
    _getDerivedJankMarkers,
    (derivedMarkers, derivedJankMarkers) =>
      [...derivedMarkers, ...derivedJankMarkers].sort(
        (a, b) => a.start - b.start
      )
  );

  /**
   * This selector returns a function that's used to retrieve a marker object
   * from its MarkerIndex:
   *
   *   const getMarker = selectedThreadSelectors.getMarkerGetter(state);
   *   const marker = getMarker(markerIndex);
   *
   * This is essentially the same as using the full marker list, but it's more
   * encapsulated and handles the case where a marker object isn't found (which
   * means the marker index is incorrect).
   */
  const getMarkerGetter: Selector<(MarkerIndex) => Marker> = createSelector(
    getFullMarkerList,
    (markerList) =>
      (markerIndex: MarkerIndex): Marker => {
        const marker = markerList[markerIndex];
        if (!marker) {
          throw new Error(stripIndent`
          Tried to get marker index ${markerIndex} but it's not in the full list.
          This is a programming error.
        `);
        }
        return marker;
      }
  );

  /**
   * This returns the list of all marker indexes. This is simply a sequence
   * built from the full marker list.
   */
  const getFullMarkerListIndexes: Selector<MarkerIndex[]> = createSelector(
    getFullMarkerList,
    (markers) => markers.map((_, i) => i)
  );

  /**
   * This utility function makes it easy to write selectors that deal with list
   * of marker indexes.
   * It takes a filtering function as parameter. This filtering function takes a
   * marker as parameter and returns a boolean deciding whether this marker
   * should be kept.
   * This function returns a function that does the actual filtering.
   *
   * It is typically used this way:
   *  const filteredMarkerIndexes = createSelector(
   *    getMarkerGetter,
   *    getSourceMarkerIndexesSelector,
   *    filterMarkerIndexesCreator(
   *      marker => MarkerData.isNetworkMarker(marker)
   *    )
   *  );
   */
  const filterMarkerIndexesCreator =
    (filterFunc: (Marker) => boolean) =>
    (
      getMarker: (MarkerIndex) => Marker,
      markerIndexes: MarkerIndex[]
    ): MarkerIndex[] =>
      MarkerData.filterMarkerIndexes(getMarker, markerIndexes, filterFunc);

  /**
   * This selector applies the committed range to the full list of markers.
   */
  const getCommittedRangeFilteredMarkerIndexes: Selector<MarkerIndex[]> =
    createSelector(
      getMarkerGetter,
      getFullMarkerListIndexes,
      ProfileSelectors.getCommittedRange,
      (getMarker, markerIndexes, range): MarkerIndex[] => {
        const { start, end } = range;
        return MarkerData.filterMarkerIndexesToRange(
          getMarker,
          markerIndexes,
          start,
          end
        );
      }
    );

  /**
   * This selector applies the tab filter(if in a single tab view) to the range filtered markers.
   */
  const getCommittedRangeAndTabFilteredMarkerIndexes: Selector<MarkerIndex[]> =
    createSelector(
      getMarkerGetter,
      getCommittedRangeFilteredMarkerIndexes,
      ProfileSelectors.getRelevantInnerWindowIDsForCurrentTab,
      MarkerData.getTabFilteredMarkerIndexes
    );

  /**
   * This selector filters out markers that are usually too long to be displayed
   * in the header, because they would obscure the header, or that are displayed
   * in other tracks already.
   */
  const getTimelineOverviewMarkerIndexes: Selector<MarkerIndex[]> =
    createSelector(
      getMarkerGetter,
      getCommittedRangeAndTabFilteredMarkerIndexes,
      ProfileSelectors.getMarkerSchema,
      ProfileSelectors.getMarkerSchemaByName,
      () => 'timeline-overview',
      MarkerData.filterMarkerByDisplayLocation
    );

  /**
   * This selector applies the tab filter(if in a single tab view) to the full
   * list of markers but excludes the global markers.
   * This selector is useful to determine if a thread is completely empty or not
   * so we can hide it inside active tab view.
   */
  const getActiveTabFilteredMarkerIndexesWithoutGlobals: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getFullMarkerListIndexes,
    ProfileSelectors.getRelevantInnerWindowIDsForActiveTab,
    (markerGetter, markerIndexes, relevantPages) => {
      return MarkerData.getTabFilteredMarkerIndexes(
        markerGetter,
        markerIndexes,
        relevantPages,
        false // exclude global markers
      );
    }
  );

  /**
   * This selector selects only navigation markers.
   */
  const getTimelineVerticalMarkerIndexes: Selector<MarkerIndex[]> =
    createSelector(
      getMarkerGetter,
      getCommittedRangeAndTabFilteredMarkerIndexes,
      filterMarkerIndexesCreator(MarkerData.isNavigationMarker)
    );

  /**
   * This selector selects only jank markers.
   */
  const getTimelineJankMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    _getDerivedJankMarkers,
    (getMarker, markerIndexes, derivedMarkers) => {
      const type = derivedMarkers.length > 0 ? 'Jank' : 'BHR-detected hang';

      return filterMarkerIndexesCreator((marker) =>
        Boolean(marker.data && marker.data.type === type)
      )(getMarker, markerIndexes);
    }
  );

  /**
   * This selector filters markers matching a search string.
   */
  const getSearchFilteredMarkerIndexes: Selector<MarkerIndex[]> =
    createSelector(
      getMarkerGetter,
      getCommittedRangeAndTabFilteredMarkerIndexes,
      UrlState.getMarkersSearchStringsAsRegExp,
      ProfileSelectors.getCategories,
      MarkerData.getSearchFilteredMarkerIndexes
    );

  /**
   * This further filters markers using the preview selection range.
   */
  const getPreviewFilteredMarkerIndexes: Selector<MarkerIndex[]> =
    createSelector(
      getMarkerGetter,
      getSearchFilteredMarkerIndexes,
      ProfileSelectors.getPreviewSelection,
      (getMarker, markerIndexes, previewSelection) => {
        if (!previewSelection.hasSelection) {
          return markerIndexes;
        }
        const { selectionStart, selectionEnd } = previewSelection;
        return MarkerData.filterMarkerIndexesToRange(
          getMarker,
          markerIndexes,
          selectionStart,
          selectionEnd
        );
      }
    );

  /**
   * This selector finds out whether there's any network marker in this thread.
   */
  const getIsNetworkChartEmptyInFullRange: Selector<boolean> = createSelector(
    getFullMarkerList,
    (markers) => markers.every((marker) => !MarkerData.isNetworkMarker(marker))
  );

  /**
   * This selector filters network markers from the range filtered markers.
   */
  const getNetworkMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getCommittedRangeFilteredMarkerIndexes,
    filterMarkerIndexesCreator(MarkerData.isNetworkMarker)
  );

  const getUserTimingMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getCommittedRangeFilteredMarkerIndexes,
    filterMarkerIndexesCreator(MarkerData.isUserTimingMarker)
  );

  /**
   * This filters network markers using a search string.
   */
  const getSearchFilteredNetworkMarkerIndexes: Selector<MarkerIndex[]> =
    createSelector(
      getMarkerGetter,
      getNetworkMarkerIndexes,
      UrlState.getNetworkSearchStringsAsRegExp,
      ProfileSelectors.getCategories,
      MarkerData.getSearchFilteredMarkerIndexes
    );

  /**
   * Returns whether there's any marker besides network markers.
   */
  const getAreMarkerPanelsEmptyInFullRange: Selector<boolean> = createSelector(
    getFullMarkerList,
    (markers) => markers.every((marker) => MarkerData.isNetworkMarker(marker))
  );

  /**
   * For performance reasons, the marker chart ignores the preview selection.
   * It handles its own zooming behavior. It uses the SearchFilteredMarkerIndexes
   * instead. It shows markers that use the "marker-chart" schema location, plus it
   * shows markers that have no schema, in order to be as permissive as possible.
   */
  const getMarkerChartMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getSearchFilteredMarkerIndexes,
    ProfileSelectors.getMarkerSchema,
    ProfileSelectors.getMarkerSchemaByName,
    // Custom filtering in addition to the schema logic:
    (getMarker, markerIndexes, markerSchema, markerSchemaByName) => {
      return MarkerData.filterMarkerByDisplayLocation(
        getMarker,
        markerIndexes,
        markerSchema,
        markerSchemaByName,
        'marker-chart',
        MarkerData.getAllowMarkersWithNoSchema(markerSchemaByName)
      );
    }
  );

  /**
   * The marker table uses only the preview selection filtered markers. It shows markers
   * that use the "marker-table" schema location, plus it shows markers that have
   * no schema, in order to be as permissive as possible.
   */
  const getMarkerTableMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getPreviewFilteredMarkerIndexes,
    ProfileSelectors.getMarkerSchema,
    ProfileSelectors.getMarkerSchemaByName,
    // Custom filtering in addition to the schema logic:
    (getMarker, markerIndexes, markerSchema, markerSchemaByName) => {
      return MarkerData.filterMarkerByDisplayLocation(
        getMarker,
        markerIndexes,
        markerSchema,
        markerSchemaByName,
        'marker-table',
        MarkerData.getAllowMarkersWithNoSchema(markerSchemaByName)
      );
    }
  );

  /**
   * This getter uses the marker schema to decide on the labels for tooltips.
   */
  const getMarkerTooltipLabelGetter: Selector<(MarkerIndex) => string> =
    createSelector(
      getMarkerGetter,
      ProfileSelectors.getMarkerSchema,
      ProfileSelectors.getMarkerSchemaByName,
      ProfileSelectors.getCategories,
      () => 'tooltipLabel',
      getLabelGetter
    );

  /**
   * This getter uses the marker schema to decide on the labels for the marker table.
   */
  const getMarkerTableLabelGetter: Selector<(MarkerIndex) => string> =
    createSelector(
      getMarkerGetter,
      ProfileSelectors.getMarkerSchema,
      ProfileSelectors.getMarkerSchemaByName,
      ProfileSelectors.getCategories,
      () => 'tableLabel',
      getLabelGetter
    );

  /**
   * This getter uses the marker schema to decide on the labels for the marker chart.
   */
  const _getMarkerChartLabelGetter: Selector<(MarkerIndex) => string> =
    createSelector(
      getMarkerGetter,
      ProfileSelectors.getMarkerSchema,
      ProfileSelectors.getMarkerSchemaByName,
      ProfileSelectors.getCategories,
      () => 'chartLabel',
      getLabelGetter
    );

  /**
   * This selector is used by the generic marker context menu to decide what to copy.
   * Currently we want to copy the same thing that is displayed as a description
   * in the marker table.
   */
  const getMarkerLabelToCopyGetter: Selector<(MarkerIndex) => string> =
    getMarkerTableLabelGetter;

  /**
   * This organizes the result of the previous selector in rows to be nicely
   * displayed in the marker chart.
   */
  const getMarkerChartTimingAndBuckets: Selector<MarkerTimingAndBuckets> =
    createSelector(
      getMarkerGetter,
      getMarkerChartMarkerIndexes,
      _getMarkerChartLabelGetter,
      ProfileSelectors.getCategories,
      MarkerTimingLogic.getMarkerTimingAndBuckets
    );

  /**
   * This returns markers for the FileIO timeline. The Marker Schema is obeyed, but
   * there is special handling to ensure that the FileIO markers are displayed
   * only for that thread.
   */
  const getTimelineFileIoMarkerIndexes: Selector<MarkerIndex[]> =
    createSelector(
      getMarkerGetter,
      getCommittedRangeAndTabFilteredMarkerIndexes,
      ProfileSelectors.getMarkerSchema,
      ProfileSelectors.getMarkerSchemaByName,
      () => 'timeline-fileio',
      // Custom filtering in addition to the schema logic:
      () => MarkerData.isOnThreadFileIoMarker,
      MarkerData.filterMarkerByDisplayLocation
    );

  /**
   * This returns only memory markers.
   */
  const getTimelineMemoryMarkerIndexes: Selector<MarkerIndex[]> =
    createSelector(
      getMarkerGetter,
      getCommittedRangeAndTabFilteredMarkerIndexes,
      ProfileSelectors.getMarkerSchema,
      ProfileSelectors.getMarkerSchemaByName,
      () => 'timeline-memory',
      MarkerData.filterMarkerByDisplayLocation
    );

  /**
   * This returns only IPC markers.
   */
  const getTimelineIPCMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    ProfileSelectors.getMarkerSchema,
    ProfileSelectors.getMarkerSchemaByName,
    () => 'timeline-ipc',
    MarkerData.filterMarkerByDisplayLocation
  );

  /**
   * This organizes the network markers in rows so that they're nicely displayed
   * in the header.
   */
  const getNetworkTrackTiming: Selector<MarkerTiming[]> = createSelector(
    getMarkerGetter,
    getNetworkMarkerIndexes,
    _getMarkerChartLabelGetter,
    MarkerTimingLogic.getMarkerTiming
  );

  /**
   * Creates the layout for the UserTiming markers so they can be displayed
   * with the stack chart.
   */
  const getUserTimingMarkerTiming: Selector<MarkerTiming[]> = createSelector(
    getMarkerGetter,
    getUserTimingMarkerIndexes,
    _getMarkerChartLabelGetter,
    MarkerTimingLogic.getMarkerTiming
  );

  /**
   * This groups screenshot markers by their window ID.
   */
  const getRangeFilteredScreenshotsById: Selector<Map<string, Marker[]>> =
    createSelector(
      getMarkerGetter,
      getCommittedRangeFilteredMarkerIndexes,
      MarkerData.groupScreenshotsById
    );

  /**
   * This returns the marker index for the currently selected marker.
   */
  const getSelectedMarkerIndex: Selector<MarkerIndex | null> = (state) =>
    threadSelectors.getViewOptions(state).selectedMarker;

  /**
   * From the previous value, this returns the full marker object for the
   * selected marker.
   */
  const getSelectedMarker: Selector<Marker | null> = (state) => {
    const getMarker = getMarkerGetter(state);
    const selectedMarkerIndex = getSelectedMarkerIndex(state);

    if (selectedMarkerIndex === null) {
      return null;
    }

    return getMarker(selectedMarkerIndex);
  };

  const getSelectedNetworkMarkerIndex: Selector<MarkerIndex | null> = (state) =>
    threadSelectors.getViewOptions(state).selectedNetworkMarker;

  // Do we need this function?
  const getSelectedNetworkMarker: Selector<Marker | null> = (state) => {
    const getMarker = getMarkerGetter(state);
    const selectedNetworkMarkerIndex = getSelectedNetworkMarkerIndex(state);

    if (selectedNetworkMarkerIndex === null) {
      return null;
    }

    return getMarker(selectedNetworkMarkerIndex);
  };

  const getRightClickedMarkerIndex: Selector<null | MarkerIndex> =
    createSelector(getRightClickedMarkerInfo, (rightClickedMarkerInfo) => {
      if (
        rightClickedMarkerInfo !== null &&
        rightClickedMarkerInfo.threadsKey === threadsKey
      ) {
        return rightClickedMarkerInfo.markerIndex;
      }

      return null;
    });

  const getRightClickedMarker: Selector<null | Marker> = createSelector(
    getMarkerGetter,
    getRightClickedMarkerIndex,
    (getMarker, markerIndex) =>
      typeof markerIndex === 'number' ? getMarker(markerIndex) : null
  );

  const getHoveredMarkerIndex: Selector<null | MarkerIndex> = createSelector(
    ProfileSelectors.getProfileViewOptions,
    ({ hoveredMarker }) => {
      if (hoveredMarker !== null && hoveredMarker.threadsKey === threadsKey) {
        return hoveredMarker.markerIndex;
      }

      return null;
    }
  );

  type MarkerTrackSelectors = $ReturnType<typeof _createMarkerTrackSelectors>;
  const _markerTrackSelectors = {};
  const getMarkerTrackSelectors = (name: string): MarkerTrackSelectors => {
    let selectors = _markerTrackSelectors[name];
    if (!selectors) {
      selectors = _createMarkerTrackSelectors(name);
      _markerTrackSelectors[name] = selectors;
    }
    return selectors;
  };

  /**
   * This function creates selectors for each of the trackable markers of a thread. The type
   * signature of each selector is defined in the function body, and inferred in the return
   * type of the function.
   */
  function _createMarkerTrackSelectors(name: string) {
    const _getMarkerSchema: Selector<MarkerSchema> = createSelector(
      ProfileSelectors.getMarkerSchemaByName,
      (schemaByName) => schemaByName[name]
    );

    const _getMarkerTrackConfig: Selector<MarkerTrackConfig> = createSelector(
      _getMarkerSchema,
      (schema) => {
        if (schema.trackConfig === undefined) {
          throw new Error('No trackConfig for marker ' + name);
        }
        return schema.trackConfig;
      }
    );

    const _getTrackKeys: Selector<string[]> = createSelector(
      _getMarkerTrackConfig,
      (trackConfig) => trackConfig.lines.map((lineConfig) => lineConfig.key)
    );

    const getCollectedCustomMarkerSamples: Selector<CollectedCustomMarkerSamples> =
      createSelector(
        getFullMarkerList,
        threadSelectors.getStringTable,
        _getTrackKeys,
        (fullMarkerList, stringTable, trackKeys) => {
          const filteredIndexes = fullMarkerList
            .map((n, i) => [n, i])
            .filter((t) => t[0].name === name)
            .map((t) => t[1]);
          const markers = filteredIndexes.map((i) => fullMarkerList[i]);
          const numbersPerLine: number[][] = trackKeys.map((key) =>
            markers.map((marker) => {
              const markerPayload = marker.data;
              if (
                !(markerPayload instanceof Object) ||
                !(key in markerPayload)
              ) {
                throw new Error('Missing ' + key + ' in marker ' + name);
              }
              return markerPayload[key];
            })
          );
          const minNumber = Math.min(
            ...numbersPerLine.map((x) => Math.min(...x))
          );
          const maxNumber = Math.max(
            ...numbersPerLine.map((x) => Math.max(...x))
          );
          const length = numbersPerLine.length;
          return {
            minNumber,
            maxNumber,
            markers,
            time: markers.map((marker) => marker.start),
            numbersPerLine,
            indexes: filteredIndexes,
            length,
          };
        }
      );

    const getCommittedRangeMarkerSampleRange: Selector<
      [IndexIntoSamplesTable, IndexIntoSamplesTable]
    > = createSelector(
      getCollectedCustomMarkerSamples,
      ProfileSelectors.getCommittedRange,
      (collectedSamples, range) =>
        getInclusiveSampleIndexRangeForSelection(
          collectedSamples,
          range.start,
          range.end
        )
    );

    return {
      getCollectedCustomMarkerSamples,
      getCommittedRangeMarkerSampleRange,
    };
  }

  return {
    getMarkerGetter,
    getTimelineJankMarkerIndexes,
    getDerivedMarkerInfo,
    getMarkerIndexToRawMarkerIndexes,
    getFullMarkerList,
    getFullMarkerListIndexes,
    getNetworkMarkerIndexes,
    getSearchFilteredNetworkMarkerIndexes,
    getAreMarkerPanelsEmptyInFullRange,
    getMarkerTableMarkerIndexes,
    getMarkerChartMarkerIndexes,
    getMarkerTooltipLabelGetter,
    getMarkerTableLabelGetter,
    getMarkerLabelToCopyGetter,
    getMarkerChartTimingAndBuckets,
    getCommittedRangeFilteredMarkerIndexes,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    getTimelineOverviewMarkerIndexes,
    getActiveTabFilteredMarkerIndexesWithoutGlobals,
    getTimelineVerticalMarkerIndexes,
    getTimelineFileIoMarkerIndexes,
    getTimelineMemoryMarkerIndexes,
    getTimelineIPCMarkerIndexes,
    getNetworkTrackTiming,
    getRangeFilteredScreenshotsById,
    getSearchFilteredMarkerIndexes,
    getPreviewFilteredMarkerIndexes,
    getSelectedMarkerIndex,
    getSelectedMarker,
    getSelectedNetworkMarkerIndex,
    getSelectedNetworkMarker,
    getIsNetworkChartEmptyInFullRange,
    getUserTimingMarkerIndexes,
    getUserTimingMarkerTiming,
    getRightClickedMarkerIndex,
    getRightClickedMarker,
    getHoveredMarkerIndex,
    getMarkerTrackSelectors,
  };
}
