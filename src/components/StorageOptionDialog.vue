<template>
  <q-dialog v-model="dialogVisible" persistent>
    <q-card class="storage-dialog">
      <q-card-section class="dialog-header">
        <div class="text-h6">Storage Options</div>
        <div class="text-subtitle text-grey-6">
          What should happen to recordings after upload?
        </div>
      </q-card-section>

      <q-card-section>
        <q-option-group
          v-model="selectedOption"
          :options="storageOptions"
          color="primary"
          class="storage-options"
        >
          <template v-slot:label="opt">
            <div class="option-content">
              <div class="option-label">{{ opt.label }}</div>
              <div class="option-description">{{ opt.description }}</div>
            </div>
          </template>
        </q-option-group>

        <q-separator class="q-my-md" />

        <q-checkbox
          v-model="rememberChoice"
          label="Remember my choice for future recordings"
          color="primary"
        />
      </q-card-section>

      <q-card-actions align="right" class="dialog-actions">
        <q-btn
          flat
          label="Cancel"
          color="grey-7"
          v-close-popup
          @click="onCancel"
        />
        <q-btn
          unelevated
          label="Start Recording"
          class="gradient-btn"
          @click="onConfirm"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script>
import { ref, watch } from 'vue';
import { useRecordingsHistoryStore } from '../stores/recordings-history';

export default {
  name: 'StorageOptionDialog',

  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },

  emits: ['update:modelValue', 'confirm', 'cancel'],

  setup(props, { emit }) {
    const historyStore = useRecordingsHistoryStore();

    const dialogVisible = ref(props.modelValue);
    const selectedOption = ref('keep');
    const rememberChoice = ref(false);

    const storageOptions = [
      {
        value: 'keep',
        label: 'Keep locally',
        description: 'Recording files stay on your device after upload'
      },
      {
        value: 'delete_after_upload',
        label: 'Delete after upload',
        description: 'Automatically delete files once successfully uploaded'
      }
    ];

    // Sync dialog visibility with prop
    watch(() => props.modelValue, (val) => {
      dialogVisible.value = val;
    });

    watch(dialogVisible, (val) => {
      emit('update:modelValue', val);
    });

    const onConfirm = async () => {
      // Save preference if remember is checked
      if (rememberChoice.value) {
        await historyStore.setDefaultStoragePreference(selectedOption.value);
      }

      emit('confirm', {
        storagePreference: selectedOption.value,
        rememberChoice: rememberChoice.value
      });

      dialogVisible.value = false;
    };

    const onCancel = () => {
      emit('cancel');
    };

    return {
      dialogVisible,
      selectedOption,
      rememberChoice,
      storageOptions,
      onConfirm,
      onCancel
    };
  }
};
</script>

<style lang="scss" scoped>
.storage-dialog {
  min-width: 400px;
  border-radius: 12px;
}

.dialog-header {
  padding-bottom: 8px;

  .text-h6 {
    font-weight: 600;
    margin-bottom: 4px;
  }

  .text-subtitle {
    font-size: 14px;
  }
}

.storage-options {
  .q-radio {
    padding: 12px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    margin-bottom: 8px;
    transition: all 0.2s ease;

    &:hover {
      background: #f8fafc;
    }

    &.q-radio--active {
      border-color: #6366F1;
      background: rgba(99, 102, 241, 0.05);
    }
  }

  .option-content {
    margin-left: 8px;

    .option-label {
      font-weight: 500;
      color: #1e293b;
    }

    .option-description {
      font-size: 13px;
      color: #64748b;
      margin-top: 2px;
    }
  }
}

.dialog-actions {
  padding: 16px 24px;
  gap: 8px;
}
</style>
