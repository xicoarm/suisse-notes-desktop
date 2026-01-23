<template>
  <div class="vocabulary-input">
    <div class="input-row">
      <q-input
        v-model="newWord"
        :placeholder="$t('addWord')"
        outlined
        dense
        class="word-input"
        @keyup.enter="addWord"
      >
        <template #append>
          <q-btn
            flat
            round
            dense
            icon="add"
            color="primary"
            size="sm"
            :disable="!newWord.trim()"
            @click="addWord"
          >
            <q-tooltip>{{ $t('addWord') }}</q-tooltip>
          </q-btn>
        </template>
      </q-input>
    </div>

    <div
      v-if="allWords.length > 0"
      class="chips-container"
    >
      <!-- Session words (removable) -->
      <q-chip
        v-for="word in sessionWords"
        :key="'session-' + word"
        removable
        color="primary"
        text-color="white"
        size="sm"
        class="word-chip"
        @remove="removeSessionWord(word)"
      >
        {{ word }}
      </q-chip>

      <!-- Global words (non-removable, different style) -->
      <q-chip
        v-for="word in globalWords"
        :key="'global-' + word"
        color="grey-3"
        text-color="grey-8"
        size="sm"
        class="word-chip global-chip"
      >
        <q-icon
          name="language"
          size="12px"
          class="q-mr-xs"
        />
        {{ word }}
        <q-tooltip>{{ $t('globalVocabulary') }}</q-tooltip>
      </q-chip>
    </div>

    <div
      v-if="showHelp"
      class="help-text"
    >
      <q-icon
        name="info"
        size="12px"
        color="grey-6"
      />
      <span>{{ $t('customSpellingHint') }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  sessionWords: {
    type: Array,
    default: () => []
  },
  globalWords: {
    type: Array,
    default: () => []
  },
  showHelp: {
    type: Boolean,
    default: true
  }
});

const emit = defineEmits(['add-word', 'remove-word']);

const newWord = ref('');

const allWords = computed(() => {
  return [...props.sessionWords, ...props.globalWords];
});

const addWord = () => {
  const trimmed = newWord.value.trim();
  if (trimmed && !props.sessionWords.includes(trimmed) && !props.globalWords.includes(trimmed)) {
    emit('add-word', trimmed);
    newWord.value = '';
  }
};

const removeSessionWord = (word) => {
  emit('remove-word', word);
};
</script>

<style lang="scss" scoped>
.vocabulary-input {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.input-row {
  display: flex;
  gap: 8px;
}

.word-input {
  flex: 1;

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
}

.chips-container {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.word-chip {
  font-size: 12px;
  height: 26px;

  &.global-chip {
    border: 1px dashed #94a3b8;
  }
}

.help-text {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.4;
}
</style>
