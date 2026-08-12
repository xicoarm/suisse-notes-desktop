<template>
  <q-expansion-item
    v-model="expanded"
    icon="auto_awesome"
    :label="$t('prepOptions')"
    header-class="options-header"
    class="prep-options"
  >
    <div class="options-content">
      <!-- Context free text -->
      <div class="option-row">
        <div class="option-label">
          {{ $t('prepContextLabel') }}
        </div>
        <q-input
          :model-value="prepStore.contextText"
          :placeholder="$t('prepContextHint')"
          type="textarea"
          autogrow
          outlined
          dense
          class="option-input"
          :maxlength="20000"
          @update:model-value="prepStore.setContextText"
        />
      </div>

      <!-- Context documents -->
      <div class="option-row">
        <div class="option-label">
          {{ $t('prepFilesLabel') }}
        </div>
        <div class="file-list">
          <div
            v-for="file in prepStore.contextFiles"
            :key="file.id"
            class="file-chip"
          >
            <q-spinner
              v-if="file.extractionStatus === 'uploading'"
              size="16px"
              color="grey-6"
            />
            <q-icon
              v-else-if="file.extractionStatus === 'failed'"
              name="warning"
              size="16px"
              color="orange"
            />
            <q-icon
              v-else
              name="description"
              size="16px"
              color="primary"
            />
            <div class="file-info">
              <div class="file-name">
                {{ file.fileName }}
              </div>
              <div class="file-meta">
                {{ formatBytes(file.sizeBytes) }}<span v-if="file.ocrUsed"> · OCR</span><span v-if="file.extractionStatus === 'failed'"> · {{ $t('prepFileNoText') }}</span>
              </div>
            </div>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="close"
              color="grey-6"
              @click="prepStore.removeContextFile(file.id)"
            />
          </div>
          <q-btn
            v-if="prepStore.contextFiles.length < MAX_CONTEXT_FILES"
            outline
            dense
            no-caps
            icon="attach_file"
            :label="$t('prepAddFile')"
            color="grey-7"
            class="add-file-btn"
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

      <!-- Template pre-selection -->
      <div class="option-row">
        <div class="option-label">
          {{ $t('prepTemplateLabel') }}
        </div>
        <q-select
          :model-value="prepStore.templateId"
          :options="templateOptions"
          emit-value
          map-options
          outlined
          dense
          class="option-input"
          @update:model-value="prepStore.selectTemplate"
        />
      </div>

      <!-- Per-section pre-fill -->
      <div
        v-if="prepStore.templateId && prepStore.sections.length > 0"
        class="option-row prefill-block"
      >
        <div class="option-label">
          {{ $t('prepPrefillTitle') }}
        </div>
        <div class="prefill-hint">
          {{ $t('prepPrefillHint') }}
        </div>
        <div
          v-for="section in prepStore.sections"
          :key="section.key"
          class="prefill-row"
        >
          <div
            class="prefill-label"
            :title="section.label"
          >
            {{ section.label }}
          </div>
          <q-input
            :model-value="prepStore.prefill[section.key] || ''"
            :placeholder="$t('prepPrefillPlaceholder')"
            type="textarea"
            autogrow
            outlined
            dense
            class="option-input"
            :maxlength="8000"
            @update:model-value="(v) => prepStore.setPrefill(section.key, v)"
          />
        </div>
      </div>
    </div>
  </q-expansion-item>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import {
  useMeetingPrepStore,
  MAX_CONTEXT_FILES,
  CONTEXT_FILE_EXTENSIONS
} from '../stores/meeting-prep';

const $q = useQuasar();
const { t } = useI18n();
const prepStore = useMeetingPrepStore();
const expanded = ref(false);
const fileInput = ref(null);

onMounted(() => {
  prepStore.initialize();
});

const templateOptions = computed(() => [
  { label: t('prepTemplateAuto'), value: null },
  ...prepStore.templates.map((tpl) => ({
    label: tpl.isBuiltIn ? `${tpl.name} · Suisse Meets` : tpl.name,
    value: tpl.id
  }))
]);

const formatBytes = (bytes) => {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const onFilesPicked = async (event) => {
  const files = Array.from(event.target.files || []);
  if (fileInput.value) fileInput.value.value = '';
  for (const file of files) {
    const result = await prepStore.uploadContextFile(file);
    if (!result.success) {
      const message =
        result.error === 'too_large' ? t('prepFileTooLarge')
          : result.error === 'unsupported' ? t('prepFileUnsupported')
            : result.error === 'max_files' ? t('prepMaxFiles')
              : `${t('prepUploadFailed')}${result.error ? ` (${result.error})` : ''}`;
      $q.notify({ type: 'negative', message: `${file.name}: ${message}` });
      if (result.error === 'max_files') break;
    }
  }
};
</script>

<style lang="scss" scoped>
.prep-options {
  background: #f8fafc;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  margin-top: 12px;

  :deep(.options-header) {
    font-size: 13px;
    font-weight: 500;
    color: #475569;
    padding: 14px 18px;
    min-height: 48px;

    .q-item__section--avatar {
      min-width: 32px;
    }

    .q-icon {
      font-size: 18px;
      color: #64748b;
    }
  }

  :deep(.q-expansion-item__content) {
    padding: 0;
  }
}

.options-content {
  padding: 4px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.option-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.option-label {
  font-size: 12px;
  font-weight: 500;
  color: #475569;
}

.option-input {
  :deep(.q-field__control) {
    border-radius: 8px;
  }

  :deep(.q-field__native) {
    font-size: 13px;
  }

  :deep(.q-field--outlined.q-field--focused .q-field__control:before) {
    border-color: #6366F1;
  }
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #ffffff;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 13px;
  color: #1e293b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-meta {
  font-size: 11px;
  color: #94a3b8;
}

.add-file-btn {
  align-self: flex-start;
  font-size: 12px;
}

.hidden-input {
  display: none;
}

.prefill-block {
  border-top: 1px solid #e2e8f0;
  padding-top: 12px;
}

.prefill-hint {
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 4px;
}

.prefill-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.prefill-label {
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
</style>
