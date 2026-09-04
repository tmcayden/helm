export { hasClaudeDir, readClaudeInventory } from './claude-inventory'
export { isGitRepo, parseGitStatus, readGitBranch, readGitState, readGitStates, repoCommand } from './git'
export {
  claudeHome,
  directoryExists,
  historyFileIn,
  isTranscriptName,
  projectsDirIn,
  readHistoryTail,
  recordTranscript,
  scanProjectDir,
  scanTranscripts,
  type HistoryLine,
  type HistoryTail,
  type TranscriptFile
} from './history'
export { createExistenceCache, type ExistenceCache, type ExistenceCacheDeps } from './existence'
export { createLiveTranscripts, type LiveTranscripts } from './transcripts-live'
export {
  countTopLevelFolders,
  createHarness,
  harnessNameProblems,
  HARNESS_FORMAT_VERSION,
  type CreateHarnessRequest,
  type CreateHarnessResult
} from './harness'
export {
  applyTemplate,
  listTemplates,
  previewTemplate,
  seedTemplates,
  substituteTemplate,
  templateIdProblems,
  MINIMAL_CHOICE,
  MINIMAL_TEMPLATE,
  SHIPPED_TEMPLATES,
  TEMPLATE_MANIFEST,
  type ApplyTemplateRequest,
  type ApplyTemplateResult,
  type PreviewTemplateRequest,
  type SeedResult,
  type TemplateChoice,
  type TemplateListing,
  type TemplatePreview,
  type TemplateValues
} from './templates'
export {
  assertTemplateWritable,
  createTemplate,
  deleteTemplate,
  importIntoTemplate,
  makeSubstitutable,
  previewFolderAsTemplate,
  readTemplateDetail,
  renameTemplate,
  saveFolderAsTemplate,
  templateNameProblems,
  writeTemplateMetadata,
  DOT_CLAUDE,
  TEMPLATE_VARIABLES,
  type FolderEntry,
  type FolderTemplateKind,
  type FolderTemplatePreview,
  type SaveFolderAsTemplateResult,
  type TemplateDeleteResult,
  type TemplateDetail,
  type TemplateFile,
  type TemplateImportFile,
  type TemplateImportResult,
  type TemplateWriteResult
} from './template-authoring'
export { findEnclosingHarness, suggestRoots } from './roots'
export {
  TITLE_MAX,
  cleanPrompt,
  deriveSessionTitle,
  sessionTitleFrom,
  titleRank,
  type SessionTitle
} from './title'
export {
  disprovedProjectPaths,
  isWithin,
  orphanedProjectPaths,
  scan,
  type ScanOptions
} from './scan'
