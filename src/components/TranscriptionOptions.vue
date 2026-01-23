<template>
  <q-expansion-item
    v-model="expanded"
    icon="tune"
    :label="$t('transcriptionOptions')"
    header-class="options-header"
    class="transcription-options"
  >
    <div class="options-content">
      <!-- Transcript Title -->
      <div class="option-row">
        <div class="option-label">
          {{ $t('transcriptTitle') }}
        </div>
        <q-input
          :model-value="title"
          :placeholder="$t('transcriptTitleHint')"
          outlined
          dense
          class="option-input"
          @update:model-value="updateTitle"
        />
      </div>

      <!-- Custom Vocabulary -->
      <div class="option-row vocabulary-row">
        <div class="option-label">
          {{ $t('customSpellingWords') }}
        </div>
        <CustomVocabularyInput
          :session-words="sessionVocabulary"
          :global-words="globalVocabulary"
          :show-help="true"
          @add-word="addWord"
          @remove-word="removeWord"
        />
      </div>
    </div>
  </q-expansion-item>
</template>

<script setup>
import { ref } from 'vue';
import CustomVocabularyInput from './CustomVocabularyInput.vue';

const props = defineProps({
  title: {
    type: String,
    default: ''
  },
  sessionVocabulary: {
    type: Array,
    default: () => []
  },
  globalVocabulary: {
    type: Array,
    default: () => []
  },
  defaultExpanded: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits([
  'update:title',
  'add-word',
  'remove-word'
]);

const expanded = ref(props.defaultExpanded);

const updateTitle = (value) => {
  emit('update:title', value);
};

const addWord = (word) => {
  emit('add-word', word);
};

const removeWord = (word) => {
  emit('remove-word', word);
};
</script>

<style lang="scss" scoped>
.transcription-options {
  background: #f8fafc;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  margin-top: 20px;

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

  &.vocabulary-row {
    gap: 10px;
  }
}

.option-label {
  font-size: 12px;
  font-weight: 500;
  color: #475569;
}

.option-input {
  :deep(.q-field__control) {
    border-radius: 8px;
    min-height: 36px;
  }

  :deep(.q-field--dense .q-field__control) {
    height: 36px;
  }

  :deep(.q-field__native) {
    font-size: 13px;
  }

  :deep(.q-field--outlined.q-field--focused .q-field__control:before) {
    border-color: #6366F1;
  }
}
</style>
