<template>
  <q-dialog
    :model-value="!!prepStore.deviceSyncPrompt"
    persistent
    position="bottom"
  >
    <q-card class="prep-dialog">
      <q-card-section class="dialog-header">
        <div class="dialog-title">
          <q-icon
            name="auto_awesome"
            size="20px"
            color="primary"
          />
          {{ $t('deviceSyncPrepTitle') }}
        </div>
        <div class="dialog-subtitle">
          {{ $t('deviceSyncPrepMessage', { title: prepStore.deviceSyncPrompt?.title || prepStore.deviceSyncPrompt?.fileName || '' }) }}
        </div>
      </q-card-section>

      <q-card-section class="dialog-body">
        <!-- Context text -->
        <div class="field-block">
          <div class="field-label">
            {{ $t('prepContextLabel') }}
          </div>
          <q-input
            v-model="contextText"
            :placeholder="$t('prepContextHint')"
            type="textarea"
            autogrow
            outlined
            dense
            :maxlength="20000"
          />
        </div>

        <!-- Context files -->
        <div class="field-block">
          <div class="field-label">
            {{ $t('prepFilesLabel') }}
          </div>
          <div class="file-list">
            <div
              v-for="file in files"
              :key="file.id"
              class="file-chip"
            >
              <q-spinner
                v-if="file.extractionStatus === 'uploading'"
                size="14px"
                color="grey-6"
              />
              <q-icon
                v-else-if="file.extractionStatus === 'failed'"
                name="warning"
                size="14px"
                color="orange"
              />
              <q-icon
                v-else
                name="description"
                size="14px"
                color="primary"
              />
              <span class="file-name">{{ file.fileName }}</span>
              <q-btn
                flat
                dense
                round
                size="xs"
                icon="close"
                color="grey-6"
                @click="removeFile(file)"
              />
            </div>
            <q-btn
              v-if="files.length < MAX_CONTEXT_FILES"
              outline
              dense
              no-caps
              size="sm"
              icon="attach_file"
              :label="$t('prepAddFile')"
              color="grey-7"
              @click="fileInput?.click()"
            />
            <input
              ref="fileInput"
              type="file"
              multiple
              :accept="CONTEXT_FILE_EXTENSIONS.join(',')"
              class="hidden-input"
              @change="onFilesPicked"
            >
          </div>
        </div>

        <!-- Template -->
        <div class="field-block">
          <div class="field-label">
            {{ $t('prepTemplateLabel') }}
          </div>
          <q-select
            v-model="templateId"
            :options="templateOptions"
            emit-value
            map-options
            outlined
            dense
            @update:model-value="onTemplateChange"
          />
        </div>

        <!-- Pre-fill -->
        <div
          v-if="templateId && sections.length > 0"
          class="field-block prefill-block"
        >
          <div class="field-label">
            {{ $t('prepPrefillTitle') }}
          </div>
          <div
            v-for="section in sections"
            :key="section.key"
            class="prefill-row"
          >
            <div class="prefill-label">
              {{ section.label }}
            </div>
            <q-input
              :model-value="prefill[section.key] || ''"
              :placeholder="$t('prepPrefillPlaceholder')"
              type="textarea"
              autogrow
              outlined
              dense
              :maxlength="8000"
              @update:model-value="(v) => { prefill = { ...prefill, [section.key]: v }; }"
            />
          </div>
        </div>

        <q-checkbox
          v-if="prepStore.deviceSyncRunActive"
          v-model="applyToAll"
          :label="$t('deviceSyncApplyAll')"
          dense
          size="sm"
          class="apply-all"
        />
      </q-card-section>

      <q-card-actions
        align="right"
        class="dialog-actions"
      >
        <q-btn
          flat
          no-caps
          color="grey-7"
          :label="$t('deviceSyncSkip')"
          :disable="uploading"
          @click="answer(null)"
        />
        <q-btn
          unelevated
          no-caps
          color="primary"
          :label="$t('deviceSyncContinue')"
          :loading="uploading"
          :disable="uploading"
          @click="answer(buildFields())"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import {
  useMeetingPrepStore,
  buildPrepFields,
  MAX_CONTEXT_FILES,
  CONTEXT_FILE_EXTENSIONS
} from '../stores/meeting-prep';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { useRecordingStore } from '../stores/recording';

const $q = useQuasar();
const { t } = useI18n();
const prepStore = useMeetingPrepStore();
const recordingStore = useRecordingStore();

// Prompts are held while the user records in-app - drain when it ends.
watch(
  () => recordingStore.isBlocking,
  (blocking) => {
    if (!blocking) prepStore._maybeShowNextPrompt();
  }
);

// --- Stranded-record scanner -------------------------------------------------
// If the app was killed while a prompt was waiting, device records stay at
// uploadStatus 'pending_prep' (excluded from every upload path). Re-prompt for
// them here. Interval-based (not a watcher) so we never race the LIVE sync
// flow, which registers its recordId as in-flight in the same tick it flips
// the status.
let strandedTimer = null;

const scanStrandedRecords = () => {
  try {
    const historyStore = useRecordingsHistoryStore();
    for (const rec of historyStore.recordings) {
      if (rec.uploadStatus !== 'pending_prep') continue;
      if (prepStore.isDeviceSyncPrepPending(rec.id)) continue;
      prepStore
        .requestDeviceSyncPrep({ recordId: rec.id, title: rec.title, fileName: rec.deviceFilename })
        .then(async (fields) => {
          const updates = { prepAnswered: true };
          if (fields && Object.keys(fields).length > 0) {
            updates.prep = fields;
          }
          await historyStore.updateRecording(rec.id, updates);
          const current = historyStore.recordings.find((r) => r.id === rec.id);
          if (current?.uploadStatus === 'pending_prep') {
            await historyStore.updateRecording(rec.id, { uploadStatus: 'pending' });
          }
        })
        .catch(() => {});
    }
  } catch (e) {
    console.warn('[DeviceSyncPrep] stranded scan failed:', e?.message);
  }
};

onMounted(() => {
  prepStore.initialize();
  setTimeout(scanStrandedRecords, 8000);
  strandedTimer = setInterval(scanStrandedRecords, 30000);
});

onUnmounted(() => {
  if (strandedTimer) clearInterval(strandedTimer);
});

// Local per-prompt state — deliberately NOT the session prep (a recording
// session may be configured while a device sync prompt appears).
const contextText = ref('');
const templateId = ref(null);
const prefill = ref({});
const files = ref([]);
const applyToAll = ref(false);
const fileInput = ref(null);

const uploading = computed(() => files.value.some((f) => f.extractionStatus === 'uploading'));
const sections = computed(() => prepStore.sectionsByTemplate[templateId.value] || []);

const templateOptions = computed(() => [
  { label: t('prepTemplateAuto'), value: null },
  ...prepStore.templates.map((tpl) => ({
    label: tpl.isBuiltIn ? `${tpl.name} · Suisse Meets` : tpl.name,
    value: tpl.id
  }))
]);

// Seed fresh local state for every new prompt.
watch(
  () => prepStore.deviceSyncPrompt,
  (prompt) => {
    if (!prompt) return;
    prepStore.initialize();
    contextText.value = prepStore.deviceSyncDefaultContext || '';
    templateId.value = prepStore.deviceSyncDefaultTemplateId || null;
    prefill.value = {};
    files.value = [];
    applyToAll.value = false;
    if (templateId.value) prepStore.fetchSections(templateId.value);
  },
  { immediate: true }
);

const onTemplateChange = (value) => {
  prefill.value = {};
  if (value && !prepStore.sectionsByTemplate[value]) {
    prepStore.fetchSections(value);
  }
};

const onFilesPicked = async (event) => {
  const picked = Array.from(event.target.files || []);
  if (fileInput.value) fileInput.value.value = '';
  for (const file of picked) {
    if (files.value.length >= MAX_CONTEXT_FILES) {
      $q.notify({ type: 'negative', message: t('prepMaxFiles') });
      break;
    }
    const tempId = `uploading-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    files.value.push({ id: tempId, fileName: file.name, sizeBytes: file.size, extractionStatus: 'uploading' });
    const result = await prepStore.uploadContextFileRaw(file, 0);
    if (result.success) {
      files.value = files.value.map((f) => (f.id === tempId ? result.file : f));
    } else {
      files.value = files.value.filter((f) => f.id !== tempId);
      const message =
        result.error === 'too_large' ? t('prepFileTooLarge')
          : result.error === 'unsupported' ? t('prepFileUnsupported')
            : `${t('prepUploadFailed')}${result.error ? ` (${result.error})` : ''}`;
      $q.notify({ type: 'negative', message: `${file.name}: ${message}` });
    }
  }
};

const removeFile = (file) => {
  files.value = files.value.filter((f) => f.id !== file.id);
  if (file.extractionStatus !== 'uploading') {
    prepStore.deleteContextFileRaw(file.id);
  }
};

const buildFields = () => {
  const fields = buildPrepFields({
    contextText: contextText.value,
    templateId: templateId.value,
    prefill: prefill.value,
    files: files.value,
    sections: sections.value
  });
  return Object.keys(fields).length > 0 ? fields : null;
};

const answer = (fields) => {
  prepStore.answerDeviceSyncPrompt(fields, applyToAll.value);
};
</script>

<style lang="scss" scoped>
.prep-dialog {
  width: 100%;
  max-width: 560px;
  border-radius: 16px 16px 0 0;
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--android-nav-bar-height, 0px));
}

.dialog-header {
  padding-bottom: 8px;
}

.dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: #1e293b;
}

.dialog-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: #64748b;
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 55vh;
  overflow-y: auto;
  padding-top: 0;
}

.field-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  font-weight: 500;
  color: #475569;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.file-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #ffffff;
  max-width: 100%;
}

.file-name {
  font-size: 12px;
  color: #1e293b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hidden-input {
  display: none;
}

.prefill-block {
  border-top: 1px solid #e2e8f0;
  padding-top: 10px;
}

.prefill-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.prefill-label {
  font-size: 11px;
  font-weight: 500;
  color: #64748b;
}

.apply-all {
  margin-top: 4px;
  font-size: 12px;
  color: #475569;
}

.dialog-actions {
  padding: 8px 16px 16px;
}
</style>
