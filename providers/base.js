(function initializeStorageProviders(root) {
  'use strict';

  const SCHEMA_VERSION = 2;
  const PROVIDERS = Object.freeze({
    MARKDOWN_FOLDER: 'markdown-folder',
    OBSIDIAN_REST: 'obsidian-rest',
    APPLE_NOTES: 'apple-notes'
  });
  const LEGACY_SETTING_KEYS = Object.freeze([
    'storageMode',
    'apiKey',
    'port',
    'basePath',
    'mediaPath',
    'vaultName'
  ]);
  const factories = new Map();

  /**
   * @typedef {Object} SocialPostData
   * @property {'x'|'threads'} platform
   * @property {string=} content
   * @property {Array<Object>=} thread
   * @property {string=} url
   * @property {string|null=} replyTo
   * @property {Object|null=} quoted
   * @property {Array<{url:string, alt?:string}>=} media
   * @property {string} timestamp
   * @property {string=} postType
   */

  function register(id, factory) {
    if (!Object.values(PROVIDERS).includes(id)) throw new Error(`Unknown storage provider: ${id}`);
    factories.set(id, factory);
  }

  function createRegistry(dependencies) {
    const registry = new Map();
    for (const [id, factory] of factories) registry.set(id, factory(dependencies));
    return registry;
  }

  function providerFromLegacy(settings = {}) {
    if (settings.storageMode === 'rest' || (!settings.storageMode && settings.apiKey)) {
      return PROVIDERS.OBSIDIAN_REST;
    }
    return PROVIDERS.MARKDOWN_FOLDER;
  }

  function resolveProvider(settings = {}) {
    return settings.storageProvider || providerFromLegacy(settings);
  }

  function fileRef(provider, path, title, externalKey) {
    return {
      provider,
      path: String(path || ''),
      title: String(title || ''),
      externalKey: String(externalKey || path || '')
    };
  }

  function notesRef(noteId, title, externalKey) {
    return {
      provider: PROVIDERS.APPLE_NOTES,
      noteId: String(noteId || ''),
      title: String(title || ''),
      externalKey: String(externalKey || noteId || '')
    };
  }

  function normalizeRef(value, provider, title = '', externalKey = '') {
    if (!value) return null;
    if (typeof value === 'object' && value.provider) return { ...value };
    if (provider === PROVIDERS.APPLE_NOTES) return notesRef(value.noteId || value, title, externalKey);
    return fileRef(provider, value.path || value, title, externalKey);
  }

  function refKey(ref) {
    if (!ref) return '';
    return ref.provider === PROVIDERS.APPLE_NOTES
      ? `${ref.provider}:${ref.noteId}`
      : `${ref.provider}:${ref.path}`;
  }

  function migrateEntry(entry, provider) {
    if (!entry || typeof entry !== 'object') return entry;
    const ref = normalizeRef(entry.ref || entry.path, entry.provider || provider, entry.filename || entry.title, entry.url);
    const migrated = { ...entry, ref };
    delete migrated.path;
    delete migrated.provider;
    return migrated;
  }

  function migrateQueueItem(item, provider) {
    const itemProvider = item.provider || item.ref?.provider || provider;
    const migrated = migrateEntry(item, itemProvider);
    migrated.provider = itemProvider;
    if (!migrated.data && typeof item.markdown === 'string') {
      migrated.data = {
        platform: item.platform || 'x',
        timestamp: item.queuedAt || new Date(0).toISOString(),
        rawMarkdown: item.markdown
      };
    }
    delete migrated.markdown;
    return migrated;
  }

  function migrationFor(snapshot = {}) {
    const hasLegacySettings = LEGACY_SETTING_KEYS.some(key => (
      Object.prototype.hasOwnProperty.call(snapshot, key) && snapshot[key] !== undefined
    ));
    if (snapshot.storageSchemaVersion === SCHEMA_VERSION && !hasLegacySettings) {
      return { changed: false, updates: {}, removeKeys: [] };
    }

    const provider = resolveProvider(snapshot);
    const basePath = snapshot.basePath || '個人創作/社群推文';
    const mediaPath = snapshot.mediaPath || '附件/Social Post to Obsidian';
    const updates = {
      storageSchemaVersion: SCHEMA_VERSION,
      storageProvider: provider,
      markdownFolderSettings: snapshot.markdownFolderSettings || {
        basePath,
        mediaPath,
        folderName: snapshot.vaultName || ''
      },
      obsidianRestSettings: snapshot.obsidianRestSettings || {
        apiKey: snapshot.apiKey || '',
        port: Number(snapshot.port) || 27123,
        basePath,
        mediaPath
      },
      appleNotesSettings: snapshot.appleNotesSettings || {
        accountId: '',
        accountName: '',
        folderId: '',
        folderName: ''
      }
    };

    for (const key of ['draftStatus_x', 'draftStatus_threads']) {
      if (snapshot[key]) updates[key] = migrateEntry(snapshot[key], provider);
    }
    if (Array.isArray(snapshot.recentSaves)) {
      updates.recentSaves = snapshot.recentSaves.map(entry => migrateEntry(entry, provider));
    }
    if (Array.isArray(snapshot.recentThreadContexts)) {
      updates.recentThreadContexts = snapshot.recentThreadContexts.map(entry => migrateEntry(entry, provider));
    }
    if (Array.isArray(snapshot.offlineQueue)) {
      updates.offlineQueue = snapshot.offlineQueue.map(item => migrateQueueItem(item, provider));
    }

    return {
      changed: true,
      updates,
      removeKeys: [...LEGACY_SETTING_KEYS]
    };
  }

  root.SP2OStorage = {
    SCHEMA_VERSION,
    PROVIDERS,
    createRegistry,
    fileRef,
    migrationFor,
    normalizeRef,
    notesRef,
    refKey,
    register,
    resolveProvider
  };
})(globalThis);
