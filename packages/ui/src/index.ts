export { AppShell, type AppShellProps } from './components/AppShell'
export {
  BrowserPane,
  BROWSER_WIDTHS,
  type BrowserPaneProps,
  type BrowserPaneState
} from './components/BrowserPane'
export { Chip, type ChipProps, type ChipTone } from './components/Chip'
export {
  ConsolePanel,
  type ConsoleEntry,
  type ConsoleFilter,
  type ConsolePanelProps
} from './components/ConsolePanel'
export {
  ConfigConsole,
  ConfigNothingSelected,
  type ConfigConsoleProps,
  type ConfigViewKind
} from './components/ConfigConsole'
export {
  CodeEditor,
  type CodeEditorHandle,
  type CodeEditorProps,
  type EditorStatus
} from './components/CodeEditor'
export { ConfigEditor, type ConfigEditorProps } from './components/ConfigEditor'
export {
  ConfigDeleteDialog,
  ConfigDeletedNotice,
  ConfigNewDialog,
  ConfigRenameDialog,
  type ConfigDeleteDialogProps,
  type ConfigDeletedNoticeProps,
  type ConfigNewDialogProps,
  type ConfigRenameDialogProps
} from './components/ConfigFileDialogs'
export {
  ContentViewer,
  ContentNothingSelected,
  type ContentViewerProps
} from './components/ContentViewer'
export { ContentTreeList, type ContentTreeListProps } from './components/ContentTreeList'
export {
  ContentDocumentPane,
  type ArtifactConsoleEntry,
  type ContentDocumentPaneProps,
  type ContentMode
} from './components/ContentDocumentPane'
export {
  EffectiveViewPane,
  type EffectiveViewPaneProps
} from './components/EffectiveViewPane'
export { HealthPanel, type HealthPanelProps } from './components/HealthPanel'
export { McpPanel, type McpPanelProps } from './components/McpPanel'
export { NewHarnessDialog, type NewHarnessDialogProps } from './components/NewHarnessDialog'
export {
  SaveAsTemplateDialog,
  type SaveAsTemplateDialogProps
} from './components/SaveAsTemplateDialog'
export { TemplateManager, type TemplateManagerProps } from './components/TemplateManager'
export { Overlay, type OverlayProps } from './components/Overlay'
export {
  ConfirmSessionDialog,
  type ConfirmSessionDialogProps
} from './components/ConfirmSessionDialog'
export {
  SetupPane,
  type SetupClaudeStatus,
  type SetupPaneProps
} from './components/SetupPane'
export {
  SettingsPane,
  pullRepoChoices,
  updateOutcome,
  type PrRepoChoice,
  type SettingsPaneProps,
  type TerminalSettings,
  type UpdateCheckResult,
  type UpdateOutcome,
  type UpdateOutcomeState,
  type WslSettingsState
} from './components/SettingsPane'
export {
  WslShutdownDialog,
  type WslShutdownDialogProps
} from './components/WslShutdownDialog'
export { VersionBanner, type VersionBannerProps } from './components/VersionBanner'
export { GitChip, type GitChipProps } from './components/GitChip'
export { InventoryChips, type InventoryChipsProps } from './components/InventoryChips'
export {
  ProfileEditor,
  type ProfileEditorProps,
  type ProfilePrediction
} from './components/ProfileEditor'
export { ProfileList, type ProfileListProps } from './components/ProfileList'
export { ProjectPane, projectPulls, type ProjectPaneProps } from './components/ProjectPane'
export { PullRow, useNow, type PullRowProps } from './components/PullRow'
export { ProjectRow, type ProjectRowProps } from './components/ProjectRow'
export {
  PullsPane,
  fetchedCaption,
  pullsSummaryLine,
  type PullsPaneProps
} from './components/PullsPane'
export {
  PullRequestPane,
  pullState,
  type LaunchedReviewNote,
  type PullRequestPaneProps,
  type PullView
} from './components/PullRequestPane'
export {
  SessionEndedBar,
  formatDuration,
  type SessionEndedBarProps
} from './components/SessionEndedBar'
export {
  SessionHistory,
  type HistoryGrouping,
  type SessionHistoryProps
} from './components/SessionHistory'
export { SessionsPane, type SessionsPaneProps } from './components/SessionsPane'
export { Sidebar, type SidebarProps } from './components/Sidebar'
export { StatusBar, type StatusBarProps } from './components/StatusBar'
export { TabBar, type Tab, type TabBarProps, type TabIndicator } from './components/TabBar'
export { UsageStatus, type UsageStatusProps } from './components/UsageStatus'
export { ThemeToggle, type ThemeToggleProps } from './components/ThemeToggle'
export { TitleBar, type TitleBarProps } from './components/TitleBar'
export { WelcomePane, type WelcomePaneProps } from './components/WelcomePane'
export * from './components/icons'
export { cn } from './lib/cn'
// Whether a dialog is up, for anything that has to get out of its way - the
// browser pane's `WebContentsView` first. `Overlay` is the only writer.
export { overlayOpen, subscribeOverlay, useOverlayOpen } from './lib/overlay'
export { formatAge, formatBytes, formatMoment, formatResetsIn } from './lib/time'
