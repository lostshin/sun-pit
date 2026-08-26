(function registerMarkdownFolderProvider(root) {
  'use strict';

  root.SP2OStorage.register(root.SP2OStorage.PROVIDERS.MARKDOWN_FOLDER, (deps) => ({
    id: root.SP2OStorage.PROVIDERS.MARKDOWN_FOLDER,
    capabilities: Object.freeze({ remoteDraft: true, append: true, archive: true, attachments: true }),
    check: (settings) => deps.nativeCheck(settings),
    saveDraft: (data, previousRef, settings) => deps.saveMarkdownDraft(data, previousRef, settings),
    savePublished: (data, context, settings) => deps.saveMarkdownPublished(data, context, settings),
    findBySource: (data, settings) => deps.findMarkdownBySource(data, settings),
    exists: (ref, settings) => deps.fileExists(ref, settings),
    delete: (ref, settings, strict) => deps.deleteFile(ref, settings, strict),
    open: (ref) => deps.nativeOpen(ref),
    scanPublished: (settings) => deps.scanFilePublished(settings),
    mergeDuplicateGroup: (group, settings) => deps.mergeFileDuplicateGroup(group, settings),
    archive: (cutoff, settings) => deps.nativeArchive(cutoff, settings)
  }));
})(globalThis);
