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
 * - Device-sync settings (ask on Suisse Notes Pro sync / defaults) live here
 *   too and are persisted like transcription settings.
 */

import { defineStore } from 'pinia';
import { isElectron, isCapacitor } from '../utils/platform';
import { getApiUrlSync } from '../services/api';
import { useAuthStore } from './auth';

// Capacitor Preferences (lazy loaded)
let Preferences = null;
const initPreferences = async () => {
  if (isCapacitor() && !Preferences) {
    const module = await import('@capacitor/preferences');
    Preferences = module.Preferences;
  }
};

const TEMPLATE_CACHE_KEY = 'meeting_prep_templates_cache_v1';
const SETTINGS_KEY = 'meeting_prep_settings_v1';
const TEMPLATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // refetch after 6h (stale cache still usable offline)

export const MAX_CONTEXT_FILES = 5;
export const MAX_CONTEXT_FILE_BYTES = 20 * 1024 * 1024;
export const CONTEXT_FILE_EXTENSIONS = [
  '.pdf', '.docx', '.txt', '.md', '.csv', '.png', '.jpg', '.jpeg', '.webp'
];

/**
 * Pure builder: turn prep UI state into the wire fields the backend ingest
 * accepts. Used by the session getter AND the device-sync dialog (own state).
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

    // --- device-sync (Suisse Notes Pro) settings, persisted ---
    askOnDeviceSync: true,
    deviceSyncDefaultTemplateId: null,
    deviceSyncDefaultContext: '',

    // --- device-sync prompt runtime state (not persisted) ---
    deviceSyncPrompt: null,        // { recordId, title, fileName } currently shown
    _deviceSyncResolve: null,      // resolver of the shown prompt
    _deviceSyncQueue: [],          // [{ info, resolve }]
    _deviceSyncInFlight: [],       // recordIds currently awaiting an answer
    // While a sync run is active and the user ticked "apply to all":
    // undefined = not set; null = skip all; object = fields for all.
    deviceSyncApplyToAll: undefined,

    loaded: false,
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

    async initialize() {
      if (this.loaded) return;
      this.loaded = true;
      try {
        // Template/section cache: localStorage on all platforms (fast, non-critical)
        const cached = localStorage.getItem(TEMPLATE_CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          this.templates = Array.isArray(parsed.templates) ? parsed.templates : [];
          this.templatesFetchedAt = parsed.fetchedAt || 0;
          this.sectionsByTemplate = parsed.sectionsByTemplate || {};
        }
      } catch (e) {
        console.warn('[MeetingPrep] cache load failed:', e?.message);
      }
      try {
        if (isElectron() && window.electronAPI?.config?.getMeetingPrepSettings) {
          const s = await window.electronAPI.config.getMeetingPrepSettings();
          if (s) this._applySettings(s);
        } else if (isCapacitor()) {
          await initPreferences();
          if (Preferences) {
            const { value } = await Preferences.get({ key: SETTINGS_KEY });
            if (value) this._applySettings(JSON.parse(value));
          }
        } else {
          const raw = localStorage.getItem(SETTINGS_KEY);
          if (raw) this._applySettings(JSON.parse(raw));
        }
      } catch (e) {
        console.warn('[MeetingPrep] settings load failed:', e?.message);
      }
      // Refresh templates in the background (cache remains usable offline)
      this.fetchTemplates().catch(() => {});
    },

    _applySettings(s) {
      if (typeof s.askOnDeviceSync === 'boolean') this.askOnDeviceSync = s.askOnDeviceSync;
      if (s.deviceSyncDefaultTemplateId !== undefined) this.deviceSyncDefaultTemplateId = s.deviceSyncDefaultTemplateId;
      if (typeof s.deviceSyncDefaultContext === 'string') this.deviceSyncDefaultContext = s.deviceSyncDefaultContext;
    },

    async saveSettings() {
      const settings = {
        askOnDeviceSync: this.askOnDeviceSync,
        deviceSyncDefaultTemplateId: this.deviceSyncDefaultTemplateId,
        deviceSyncDefaultContext: this.deviceSyncDefaultContext
      };
      try {
        if (isElectron() && window.electronAPI?.config?.setMeetingPrepSettings) {
          await window.electronAPI.config.setMeetingPrepSettings(settings);
        } else if (isCapacitor()) {
          await initPreferences();
          if (Preferences) {
            await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(settings) });
          }
        } else {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        }
      } catch (e) {
        console.error('[MeetingPrep] settings save failed:', e);
      }
    },

    _persistCache() {
      try {
        localStorage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify({
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
        const res = await fetch(`${getApiUrlSync()}/api/desktop/templates`, {
          headers: this._authHeaders()
        });
        if (!res.ok) throw new Error(`templates ${res.status}`);
        const data = await res.json();
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
        const res = await fetch(`${getApiUrlSync()}/api/desktop/templates/${templateId}/sections`, {
          headers: this._authHeaders()
        });
        if (!res.ok) throw new Error(`sections ${res.status}`);
        const data = await res.json();
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
     * action below and by the device-sync dialog (which owns its file list).
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
        const res = await fetch(`${getApiUrlSync()}/api/context-files`, {
          method: 'POST',
          headers: this._authHeaders(),
          body: formData
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Upload failed (${res.status})`);
        }
        const data = await res.json();
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
        await fetch(`${getApiUrlSync()}/api/context-files/${fileId}`, {
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

    /** Reset the per-session preparation (after a successful upload start). */
    resetSession() {
      this.contextText = '';
      this.contextFiles = [];
      this.templateId = null;
      this.prefill = {};
    },

    // ------------------------------------------------------------------
    // Suisse Notes Pro device-sync prompt ("context? template?" before the
    // upload of a device recording). The pipeline WAITS until answered —
    // skipping is always possible, and with askOnDeviceSync=false the saved
    // defaults are applied fully automatically.
    // ------------------------------------------------------------------

    /** Fields derived from the saved device-sync defaults (may be empty). */
    deviceSyncDefaultFields() {
      const fields = {};
      if ((this.deviceSyncDefaultContext || '').trim()) {
        fields.contextText = this.deviceSyncDefaultContext.trim();
      }
      if (this.deviceSyncDefaultTemplateId) {
        fields.templateId = this.deviceSyncDefaultTemplateId;
      }
      return fields;
    },

    /** Called by device.js around a sync run so "apply to all" scopes to it. */
    endDeviceSyncRun() {
      this.deviceSyncApplyToAll = undefined;
    },

    /**
     * Ask the user for prep fields for one device recording. Resolves with the
     * wire fields ({} / null = none) once answered. Resolves immediately when
     * prompting is disabled (defaults are applied automatically) or the user
     * chose "apply to all" earlier in this sync run.
     */
    requestDeviceSyncPrep(info) {
      if (!this.askOnDeviceSync) {
        const defaults = this.deviceSyncDefaultFields();
        return Promise.resolve(Object.keys(defaults).length > 0 ? defaults : null);
      }
      if (this.deviceSyncApplyToAll !== undefined) {
        return Promise.resolve(this.deviceSyncApplyToAll);
      }
      if (this._deviceSyncInFlight.includes(info.recordId)) {
        // Already queued/shown for this record (e.g. watcher + sync overlap).
        return Promise.resolve(null);
      }
      this._deviceSyncInFlight.push(info.recordId);
      return new Promise((resolve) => {
        this._deviceSyncQueue.push({ info, resolve });
        this._maybeShowNextPrompt();
      });
    },

    /** True when this record is already queued or being answered. */
    isDeviceSyncPrepPending(recordId) {
      return this._deviceSyncInFlight.includes(recordId);
    },

    _maybeShowNextPrompt() {
      if (this.deviceSyncPrompt || this._deviceSyncQueue.length === 0) return;
      const next = this._deviceSyncQueue.shift();
      this.deviceSyncPrompt = next.info;
      this._deviceSyncResolve = next.resolve;
    },

    /**
     * Dialog answer. `fields` = wire fields or null for skip; `applyToAll`
     * repeats this answer for every further prompt of the current sync run.
     */
    answerDeviceSyncPrompt(fields, applyToAll = false) {
      const resolve = this._deviceSyncResolve;
      const current = this.deviceSyncPrompt;
      this.deviceSyncPrompt = null;
      this._deviceSyncResolve = null;
      if (current) {
        this._deviceSyncInFlight = this._deviceSyncInFlight.filter((id) => id !== current.recordId);
      }
      if (applyToAll) {
        this.deviceSyncApplyToAll = fields;
        // Answer everything already queued with the same result.
        const queued = this._deviceSyncQueue.splice(0);
        for (const item of queued) {
          this._deviceSyncInFlight = this._deviceSyncInFlight.filter((id) => id !== item.info.recordId);
          item.resolve(fields);
        }
      }
      resolve?.(fields);
      this._maybeShowNextPrompt();
    }
  }
});
