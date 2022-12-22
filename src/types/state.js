/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import type {
  Action,
  DataSource,
  PreviewSelection,
  ImplementationFilter,
  CallTreeSummaryStrategy,
  RequestedLib,
  TrackReference,
  TimelineType,
  CheckedSharingOptions,
  Localization,
  LastNonShiftClickInformation,
} from './actions';
import type { TabSlug } from '../app-logic/tabs-handling';
import type { StartEndRange, CssPixels, Milliseconds } from './units';
import type { Profile, ThreadIndex, Pid, TabID } from './profile';

import type {
  CallNodePath,
  GlobalTrack,
  LocalTrack,
  TrackIndex,
  MarkerIndex,
  ActiveTabTimeline,
  OriginsTimeline,
  ThreadsKey,
} from './profile-derived';
import type { Attempt } from '../utils/errors';
import type { TransformStacksPerThread } from './transforms';
import type JSZip from 'jszip';
import type { IndexIntoZipFileTable } from '../profile-logic/zip-files';
import type { PathSet } from '../utils/path.js';
import type { UploadedProfileInformation as ImportedUploadedProfileInformation } from 'firefox-profiler/app-logic/uploaded-profiles-db';
import type { BrowserConnectionStatus } from 'firefox-profiler/app-logic/browser-connection';

export type Reducer<T> = (T | void, Action) => T;

// This type is defined in uploaded-profiles-db.js because it is very tied to
// the data stored in our local IndexedDB, and we don't want to change it
// lightly, without changing the DB code.
// We reexport this type here mostly for easier access.
export type UploadedProfileInformation = ImportedUploadedProfileInformation;

export type SymbolicationStatus = 'DONE' | 'SYMBOLICATING';
export type ThreadViewOptions = {|
  +selectedCallNodePath: CallNodePath,
  +expandedCallNodePaths: PathSet,
  +selectedMarker: MarkerIndex | null,
  +selectedNetworkMarker: MarkerIndex | null,
|};

export type ThreadViewOptionsPerThreads = { [ThreadsKey]: ThreadViewOptions };

export type TableViewOptions = {|
  +fixedColumnWidths: Array<CssPixels> | null,
|};

export type TableViewOptionsPerTab = { [TabSlug]: TableViewOptions };

export type RightClickedCallNode = {|
  +threadsKey: ThreadsKey,
  +callNodePath: CallNodePath,
|};

export type MarkerReference = {|
  +threadsKey: ThreadsKey,
  +markerIndex: MarkerIndex,
|};

/**
 * Full profile view state
 * They should not be used from the active tab view.
 * NOTE: This state is empty for now, but will be used later, do not remove.
 * globalTracks and localTracksByPid states will be here in the future.
 */
export type FullProfileViewState = {|
  globalTracks: GlobalTrack[],
  localTracksByPid: Map<Pid, LocalTrack[]>,
|};

export type OriginsViewState = {|
  originsTimeline: OriginsTimeline,
|};

/**
 * Active tab profile view state
 * They should not be used from the full view.
 */
export type ActiveTabProfileViewState = {|
  activeTabTimeline: ActiveTabTimeline,
|};

/**
 * Profile view state
 */
export type ProfileViewState = {
  +viewOptions: {|
    perThread: ThreadViewOptionsPerThreads,
    symbolicationStatus: SymbolicationStatus,
    waitingForLibs: Set<RequestedLib>,
    previewSelection: PreviewSelection,
    scrollToSelectionGeneration: number,
    focusCallTreeGeneration: number,
    rootRange: StartEndRange,
    lastNonShiftClick: LastNonShiftClickInformation | null,
    rightClickedTrack: TrackReference | null,
    rightClickedCallNode: RightClickedCallNode | null,
    rightClickedMarker: MarkerReference | null,
    hoveredMarker: MarkerReference | null,
    mouseTimePosition: Milliseconds | null,
    perTab: TableViewOptionsPerTab,
  |},
  +profile: Profile | null,
  +full: FullProfileViewState,
  +activeTab: ActiveTabProfileViewState,
  +origins: OriginsViewState,
};

export type AppViewState =
  | {| +phase: 'ROUTE_NOT_FOUND' |}
  | {| +phase: 'TRANSITIONING_FROM_STALE_PROFILE' |}
  | {| +phase: 'PROFILE_LOADED' |}
  | {| +phase: 'DATA_LOADED' |}
  | {| +phase: 'DATA_RELOAD' |}
  | {| +phase: 'FATAL_ERROR', +error: Error |}
  | {|
      +phase: 'INITIALIZING',
      +additionalData?: {| +attempt: Attempt | null, +message: string |},
    |};

export type Phase = $PropertyType<AppViewState, 'phase'>;

/**
 * This represents the finite state machine for loading zip files. The phase represents
 * where the state is now.
 */
export type ZipFileState =
  | {|
      +phase: 'NO_ZIP_FILE',
      +zip: null,
      +pathInZipFile: null,
    |}
  | {|
      +phase: 'LIST_FILES_IN_ZIP_FILE',
      +zip: JSZip,
      +pathInZipFile: null,
    |}
  | {|
      +phase: 'PROCESS_PROFILE_FROM_ZIP_FILE',
      +zip: JSZip,
      +pathInZipFile: string,
    |}
  | {|
      +phase: 'FAILED_TO_PROCESS_PROFILE_FROM_ZIP_FILE',
      +zip: JSZip,
      +pathInZipFile: string,
    |}
  | {|
      +phase: 'FILE_NOT_FOUND_IN_ZIP_FILE',
      +zip: JSZip,
      +pathInZipFile: string,
    |}
  | {|
      +phase: 'VIEW_PROFILE_IN_ZIP_FILE',
      +zip: JSZip,
      +pathInZipFile: string,
    |};

export type IsOpenPerPanelState = { [TabSlug]: boolean };

export type UrlSetupPhase = 'initial-load' | 'loading-profile' | 'done';

/*
 * Experimental features that are mostly disabled by default. You need to enable
 * them from the DevTools console with `experimental.enable<feature-camel-case>()`,
 * e.g. `experimental.enableEventDelayTracks()`.
 */
export type ExperimentalFlags = {|
  +eventDelayTracks: boolean,
  +cpuGraphs: boolean,
  +processCPUTracks: boolean,
|};

export type AppState = {|
  +view: AppViewState,
  +urlSetupPhase: UrlSetupPhase,
  +hasZoomedViaMousewheel: boolean,
  +isSidebarOpenPerPanel: IsOpenPerPanelState,
  +sidebarOpenCategories: Map<string, Set<number>>,
  +panelLayoutGeneration: number,
  +lastVisibleThreadTabSlug: TabSlug,
  +trackThreadHeights: {
    [key: ThreadsKey]: CssPixels,
  },
  +isNewlyPublished: boolean,
  +isDragAndDropDragging: boolean,
  +isDragAndDropOverlayRegistered: boolean,
  +experimental: ExperimentalFlags,
  +currentProfileUploadedInformation: UploadedProfileInformation | null,
  +browserConnectionStatus: BrowserConnectionStatus,
|};

export type UploadPhase =
  | 'local'
  | 'compressing'
  | 'uploading'
  | 'uploaded'
  | 'error';

export type UploadState = {|
  phase: UploadPhase,
  uploadProgress: number,
  error: Error | mixed,
  abortFunction: () => void,
  generation: number,
|};

export type PublishState = {|
  +checkedSharingOptions: CheckedSharingOptions,
  +upload: UploadState,
  +isHidingStaleProfile: boolean,
  +hasSanitizedProfile: boolean,
  +prePublishedState: State | null,
|};

export type ZippedProfilesState = {
  zipFile: ZipFileState,
  error: Error | null,
  selectedZipFileIndex: IndexIntoZipFileTable | null,
  // In practice this should never contain null, but needs to support the
  // TreeView interface.
  expandedZipFileIndexes: Array<IndexIntoZipFileTable | null>,
};

export type SourceViewState = {|
  activationGeneration: number,
  file: string | null,
|};

export type FileSourceStatus =
  | {| type: 'LOADING', source: FileSourceLoadingSource |}
  | {| type: 'ERROR', errors: SourceLoadingError[] |}
  | {| type: 'AVAILABLE', source: string |};

export type FileSourceLoadingSource =
  | {| type: 'URL', url: string |}
  | {| type: 'BROWSER_CONNECTION' |};

export type SourceLoadingError =
  | {| type: 'NO_KNOWN_CORS_URL' |}
  | {|
      type: 'NETWORK_ERROR',
      url: string,
      networkErrorMessage: string,
    |}
  | {|
      type: 'NOT_PRESENT_IN_ARCHIVE',
      url: string,
      pathInArchive: string,
    |}
  | {|
      type: 'ARCHIVE_PARSING_ERROR',
      url: string,
      parsingErrorMessage: string,
    |}
  | {|
      type: 'SYMBOL_SERVER_API_ERROR',
      apiErrorMessage: string,
    |}
  | {|
      type: 'BROWSER_CONNECTION_ERROR',
      browserConnectionErrorMessage: string,
    |}
  | {|
      type: 'BROWSER_API_ERROR',
      apiErrorMessage: string,
    |};

/**
 * Full profile specific url state
 * They should not be used from the active tab view.
 */
export type FullProfileSpecificUrlState = {|
  globalTrackOrder: TrackIndex[],
  hiddenGlobalTracks: Set<TrackIndex>,
  hiddenLocalTracksByPid: Map<Pid, Set<TrackIndex>>,
  localTrackOrderByPid: Map<Pid, TrackIndex[]>,
  localTrackOrderChangedPids: Set<Pid>,
  showJsTracerSummary: boolean,
  legacyThreadOrder: ThreadIndex[] | null,
  legacyHiddenThreads: ThreadIndex[] | null,
|};

/**
 * Active tab profile specific url state
 * They should not be used from the full view.
 */
export type ActiveTabSpecificProfileUrlState = {|
  isResourcesPanelOpen: boolean,
|};

export type ProfileSpecificUrlState = {|
  selectedThreads: Set<ThreadIndex> | null,
  implementation: ImplementationFilter,
  lastSelectedCallTreeSummaryStrategy: CallTreeSummaryStrategy,
  invertCallstack: boolean,
  showUserTimings: boolean,
  committedRanges: StartEndRange[],
  callTreeSearchString: string,
  markersSearchString: string,
  networkSearchString: string,
  transforms: TransformStacksPerThread,
  timelineType: TimelineType,
  sourceView: SourceViewState,
  isBottomBoxOpenPerPanel: IsOpenPerPanelState,
  full: FullProfileSpecificUrlState,
  activeTab: ActiveTabSpecificProfileUrlState,
|};

/**
 * Determines how the timeline's tracks are organized.
 */
export type TimelineTrackOrganization =
  | {| +type: 'full' |}
  | {| +type: 'active-tab', +tabID: TabID | null |}
  | {| +type: 'origins' |};

export type UrlState = {|
  +dataSource: DataSource,
  // This is used for the "public" dataSource".
  +hash: string,
  // This is used for the "from-url" dataSource.
  +profileUrl: string,
  // This is used for the "compare" dataSource, to compare 2 profiles.
  +profilesToCompare: string[] | null,
  +selectedTab: TabSlug,
  +pathInZipFile: string | null,
  +profileName: string | null,
  +timelineTrackOrganization: TimelineTrackOrganization,
  +profileSpecific: ProfileSpecificUrlState,
  +symbolServerUrl: string | null,
|};

/**
 * Localization State
 */
export type PseudoStrategy = null | 'bidi' | 'accented';
export type L10nState = {|
  +requestedLocales: string[] | null,
  +pseudoStrategy: PseudoStrategy,
  +localization: Localization,
  +primaryLocale: string | null,
  +direction: 'ltr' | 'rtl',
|};

export type IconState = Set<string>;

export type State = {|
  +app: AppState,
  +profileView: ProfileViewState,
  +urlState: UrlState,
  +icons: IconState,
  +zippedProfiles: ZippedProfilesState,
  +publish: PublishState,
  +l10n: L10nState,
  +sources: Map<string, FileSourceStatus>,
|};

export type IconWithClassName = {|
  +icon: string,
  +className: string,
|};
