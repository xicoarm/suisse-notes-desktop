/**
 * Meeting preparation store (pre-recording context + template pre-selection +
 * template pre-fill) — the native-app counterpart of the web PreMeetingPrepCard.
 *
 * - Session state resets after each successful upload start (same lifecycle as
 *   transcription-settings sessionTitle/sessionVocabulary).
 * - The template list and per-template sections are cached locally so the
 *   picker works offline (selection + free text + pre-fill always work offline;
 *   only NEW context-file uploads need connectivity — the bytes go straight to
 *   POST /api/context-files).
 * - `metadataFields` yields exactly the wire fields the backend ingest accepts
 *   (contextText / templateId / templatePrefill / contextFileIds). The same
 *   object is persisted on the history record (`prep`) so offline retries and
 *   crash recovery re-send it — see LOCAL_ONLY_FIELDS in recordings-history.
 * - Suisse Meets Pro recordings are uploaded without asking (Areg, 10.10.2026:
 *   the context/template prompt between transfer and upload broke the flow).
 */

import { defineStore } from 'pinia';
import { getApiUrlSync, fetchWithTimeout, readJson, parseJsonSafe } from '../services/api';
import { useAuthStore } from './auth';

const TEMPLATE_CACHE_KEY = 'meeting_prep_templates_cache_v1';
const TEMPLATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // refetch after 6h (stale cache still usable offline)

export const MAX_CONTEXT_FILES = 5;
export const MAX_CONTEXT_FILE_BYTES = 20 * 1024 * 1024;
export const CONTEXT_FILE_EXTENSIONS = [
  '.pdf', '.docx', '.txt', '.md', '.csv', '.png', '.jpg', '.jpeg', '.webp'
];

/**
 * Pure builder: turn prep UI state into the wire fields the backend ingest
 * accepts. Used by the session getter.
 */
export function buildPrepFields({ contextText, templateId, prefill, files, sections }) {
  const fields = {};
  if ((contextText || '').trim()) fields.contextText = contextText.trim();
  if (templateId) fields.templateId = templateId;
  const readyFiles = (files || []).filter((f) => f.extractionStatus !== 'uploading');
  if (readyFiles.length > 0) fields.contextFileIds = readyFiles.map((f) => f.id);
  if (templateId) {
    const labelByKey = new Map((sections || []).map((s) => [s.key, s.label]));
    const entries = Object.entries(prefill || {})
      .map(([key, content]) => ({ key, content: (content || '').trim() }))
      .filter((e) => e.content)
      .map((e) => {
        const label = labelByKey.get(e.key);
        return { key: e.key, ...(label ? { label: String(label).slice(0, 200) } : {}), content: e.content };
      });
    if (entries.length > 0) fields.templatePrefill = { entries };
  }
  return fields;
}

export const useMeetingPrepStore = defineStore('meeting-prep', {
  state: () => ({
    // --- per-session preparation (reset after each upload start) ---
    contextText: '',
    contextFiles: [],   // [{ id, fileName, sizeBytes, extractionStatus, ocrUsed }]
    templateId: null,
    prefill: {},        // { sectionKey: content }

    // --- caches (persisted) ---
    templates: [],            // [{ id, name, description, templateType, isBuiltIn, isStarred }]
    templatesFetchedAt: 0,
    sectionsByTemplate: {},   // { templateId: [{ key, label, kind }] }

    loaded: false,
    _loadedForUserId: null,
    uploadingCount: 0
  }),

  getters: {
    sections: (state) => state.sectionsByTemplate[state.templateId] || [],

    hasPrepData: (state) => {
      return !!(
        state.contextText.trim() ||
        state.templateId ||
        state.contextFiles.length > 0 ||
        Object.values(state.prefill).some((v) => (v || '').trim())
      );
    },

    /**
     * Wire fields for upload metadata — only non-empty fields are included so
     * plain `...spread` into metadata stays clean for old servers.
     */
    metadataFields: (state) => {
      return buildPrepFields({
        contextText: state.contextText,
        templateId: state.templateId,
        prefill: state.prefill,
        files: state.contextFiles,
        sections: state.sectionsByTemplate[state.templateId] || []
      });
    },

    /** Snapshot persisted on the history record (null when nothing set). */
    historySnapshot() {
      const fields = this.metadataFields;
      return Object.keys(fields).length > 0 ? fields : null;
    }
  },

  actions: {
    _authHeaders() {
      const authStore = useAuthStore();
      return authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {};
    },

    _cacheKey() {
      return `${TEMPLATE_CACHE_KEY}_${this._loadedForUserId || 'anon'}`;
    },

    async initialize() {
      const authStore = useAuthStore();
      const userId = authStore.user?.id || 'anon';
      if (this.loaded && this._loadedForUserId === userId) return;
      // User changed (shared device) - never leak the previous user's
      // templates, sections or session prep to the new account.
      if (this.loaded && this._loadedForUserId !== userId) {
        this.templates = [];
        this.templatesFetchedAt = 0;
        this.sectionsByTemplate = {};
        this.resetSession();
      }
      this.loaded = true;
      this._loadedForUserId = userId;
      try {
        // Template/section cache: localStorage on all platforms (fast, non-critical)
        const cached = localStorage.getItem(this._cacheKey());
        if (cached) {
          const parsed = JSON.parse(cached);
          this.templates = Array.isArray(parsed.templates) ? parsed.templates : [];
          this.templatesFetchedAt = parsed.fetchedAt || 0;
          this.sectionsByTemplate = parsed.sectionsByTemplate || {};
        }
      } catch (e) {
        console.warn('[MeetingPrep] cache load failed:', e?.message);
      }
      // Refresh templates in the background (cache remains usable offline)
      this.fetchTemplates().catch(() => {});
    },

    _persistCache() {
      try {
        localStorage.setItem(this._cacheKey(), JSON.stringify({
          templates: this.templates,
          fetchedAt: this.templatesFetchedAt,
          sectionsByTemplate: this.sectionsByTemplate
        }));
      } catch (e) {
        console.warn('[MeetingPrep] cache persist failed:', e?.message);
      }
    },

    async fetchTemplates(force = false) {
      const authStore = useAuthStore();
      if (!authStore.token) return;
      if (!force && this.templatesFetchedAt && Date.now() - this.templatesFetchedAt < TEMPLATE_CACHE_TTL_MS) return;
      try {
        const res = await fetchWithTimeout(`${getApiUrlSync()}/api/desktop/templates`, {
          headers: this._authHeaders()
        });
        if (!res.ok) throw new Error(`templates ${res.status}`);
        const data = await readJson(res);
        if (Array.isArray(data.templates)) {
          this.templates = data.templates;
          this.templatesFetchedAt = Date.now();
          this._persistCache();
        }
      } catch (e) {
        console.warn('[MeetingPrep] template fetch failed (cache stays):', e?.message);
      }
    },

    async fetchSections(templateId) {
      if (!templateId) return [];
      try {
        const res = await fetchWithTimeout(`${getApiUrlSync()}/api/desktop/templates/${templateId}/sections`, {
          headers: this._authHeaders()
        });
        if (!res.ok) throw new Error(`sections ${res.status}`);
        const data = await readJson(res);
        const sections = Array.isArray(data.sections) ? data.sections : [];
        this.sectionsByTemplate = { ...this.sectionsByTemplate, [templateId]: sections };
        this._persistCache();
        return sections;
      } catch (e) {
        console.warn('[MeetingPrep] sections fetch failed (cache stays):', e?.message);
        return this.sectionsByTemplate[templateId] || [];
      }
    },

    async selectTemplate(templateId) {
      this.templateId = templateId || null;
      this.prefill = {};
      if (this.templateId && !this.sectionsByTemplate[this.templateId]) {
        await this.fetchSections(this.templateId);
      }
    },

    setContextText(text) {
      this.contextText = text || '';
    },

    setPrefill(key, content) {
      this.prefill = { ...this.prefill, [key]: content };
    },

    /**
     * Validate + upload one context file to the backend WITHOUT touching the
     * session state. Returns { success, file? , error? }. Used by the session
     * action below.
     */
    async uploadContextFileRaw(file, currentCount = 0) {
      if (currentCount >= MAX_CONTEXT_FILES) {
        return { success: false, error: 'max_files' };
      }
      const ext = `.${(file.name || '').split('.').pop()?.toLowerCase() || ''}`;
      if (!CONTEXT_FILE_EXTENSIONS.includes(ext)) {
        return { success: false, error: 'unsupported' };
      }
      if (file.size > MAX_CONTEXT_FILE_BYTES) {
        return { success: false, error: 'too_large' };
      }
      try {
        const formData = new FormData();
        formData.append('file', file, file.name);
        const res = await fetchWithTimeout(`${getApiUrlSync()}/api/context-files`, {
          method: 'POST',
          headers: this._authHeaders(),
          body: formData,
          timeoutMs: 0 // no deadline: server-side text extraction/OCR can be slow
        });
        if (!res.ok) {
          const err = await parseJsonSafe(res);
          throw new Error(err.error || `Upload failed (${res.status})`);
        }
        const data = await readJson(res);
        return {
          success: true,
          file: {
            id: data.id,
            fileName: data.fileName,
            sizeBytes: data.sizeBytes,
            extractionStatus: data.extractionStatus,
            ocrUsed: data.ocrUsed
          }
        };
      } catch (e) {
        return { success: false, error: e?.message || 'upload_failed' };
      }
    },

    /**
     * Upload one context file into the SESSION prep. Returns { success, error? }.
     */
    async uploadContextFile(file) {
      if (this.contextFiles.length >= MAX_CONTEXT_FILES) {
        return { success: false, error: 'max_files' };
      }
      const tempId = `uploading-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.contextFiles.push({
        id: tempId,
        fileName: file.name,
        sizeBytes: file.size,
        extractionStatus: 'uploading'
      });
      this.uploadingCount++;
      try {
        const result = await this.uploadContextFileRaw(file, 0);
        if (!result.success) {
          this.contextFiles = this.contextFiles.filter((f) => f.id !== tempId);
          return { success: false, error: result.error };
        }
        this.contextFiles = this.contextFiles.map((f) => (f.id === tempId ? result.file : f));
        return { success: true };
      } finally {
        this.uploadingCount--;
      }
    },

    /** Best-effort delete of an uploaded-but-unattached context file. */
    async deleteContextFileRaw(fileId) {
      try {
        await fetchWithTimeout(`${getApiUrlSync()}/api/context-files/${fileId}`, {
          method: 'DELETE',
          headers: this._authHeaders()
        });
      } catch {
        // Orphaned server-side file is harmless (never attached to a meeting).
      }
    },

    async removeContextFile(fileId) {
      const file = this.contextFiles.find((f) => f.id === fileId);
      this.contextFiles = this.contextFiles.filter((f) => f.id !== fileId);
      if (!file || file.extractionStatus === 'uploading') return;
      await this.deleteContextFileRaw(fileId);
    },

    /**
     * Wait until in-flight context-file uploads settle (bounded). Callers gate
     * upload starts on this so an attached file is never silently dropped.
     */
    async waitForContextUploads(maxMs = 60000) {
      const start = Date.now();
      while (this.uploadingCount > 0 && Date.now() - start < maxMs) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return this.uploadingCount === 0;
    },

    /** Reset the per-session preparation (after a successful upload start). */
    resetSession() {
      this.contextText = '';
      this.contextFiles = [];
      this.templateId = null;
      this.prefill = {};
    }
  }
});
