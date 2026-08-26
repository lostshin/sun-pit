(function registerAppleNotesProvider(root) {
  'use strict';

  root.SP2OStorage.register(root.SP2OStorage.PROVIDERS.APPLE_NOTES, (deps) => ({
    id: root.SP2OStorage.PROVIDERS.APPLE_NOTES,
    capabilities: Object.freeze({ remoteDraft: false, append: true, archive: false, attachments: true }),
    check: (settings) => deps.notesCheck(settings),
    saveDraft: (data, previousRef, settings) => deps.saveLocalDraft(data, previousRef, settings),
    savePublished: (data, context, settings) => deps.saveNotesPublished(data, context, settings),
    findBySource: (data, settings) => deps.findNotesBySource(data, settings),
    exists: (ref, settings) => deps.notesExists(ref, settings),
    delete: (ref, settings) => deps.notesDelete(ref, settings),
    open: (ref, settings) => deps.notesOpen(ref, settings),
    scanPublished: (settings) => deps.scanNotesPublished(settings),
    mergeDuplicateGroup: (group, settings) => deps.mergeNotesDuplicateGroup(group, settings),
    archive: null
  }));
})(globalThis);
