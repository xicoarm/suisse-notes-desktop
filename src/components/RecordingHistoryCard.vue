<template>
  <div :class="['history-card', 'status-card', `status-${currentStatus}`]">
    <div class="card-header">
      <div class="card-info">
        <div class="card-title">
          <span class="recording-date">{{ formattedDate }}</span>
          <span :class="['status-badge', currentStatus]">
            {{ statusLabel }}
          </span>
        </div>

        <div class="recording-meta">
          <div class="meta-item">
            <q-icon
              name="schedule"
              size="xs"
            />
            <span>{{ formattedDuration }}</span>
          </div>
          <div
            v-if="recording.fileSize"
            class="meta-item"
          >
            <q-icon
              name="save"
              size="xs"
            />
            <span>{{ formattedSize }}</span>
          </div>
          <div
            v-if="recording.storagePreference === 'delete_after_upload'"
            class="meta-item"
          >
            <q-icon
              name="auto_delete"
              size="xs"
            />
            <span>{{ $t('autoDelete') }}</span>
          </div>
        </div>
      </div>

      <div class="card-actions">
        <!-- Uploading spinner -->
        <q-spinner-dots
          v-if="uploading"
          color="primary"
          size="24px"
        />

        <q-btn
          v-else-if="recording.uploadStatus === 'pending' && recording.filePath"
          flat
          round
          icon="cloud_upload"
          color="primary"
          size="sm"
          @click="$emit('upload', recording)"
        >
          <q-tooltip>{{ $t('upload') }}</q-tooltip>
        </q-btn>

        <q-btn
          v-else-if="recording.uploadStatus === 'failed' && recording.filePath"
          flat
          round
          icon="refresh"
          color="warning"
          size="sm"
          @click="$emit('retry', recording)"
        >
          <q-tooltip>{{ $t('retryUpload') }}</q-tooltip>
        </q-btn>

        <q-btn
          v-if="recording.filePath && !uploading"
          flat
          round
          :icon="expanded ? 'expand_less' : 'expand_more'"
          color="grey-7"
          size="sm"
          :disable="uploading"
          @click="expanded = !expanded"
        >
          <q-tooltip>{{ expanded ? $t('hide') : $t('play') }}</q-tooltip>
        </q-btn>

        <q-btn
          flat
          round
          icon="delete_outline"
          color="grey-7"
          size="sm"
          :disable="uploading"
          @click="onDelete"
        >
          <q-tooltip>{{ $t('delete') }}</q-tooltip>
        </q-btn>
      </div>
    </div>

    <q-slide-transition>
      <div
        v-if="expanded && recording.filePath"
        class="card-player"
      >
        <AudioPlayback :file-path="recording.filePath" />
      </div>
    </q-slide-transition>

    <!-- Delete confirmation dialog -->
    <q-dialog v-model="showDeleteDialog">
      <q-card class="delete-dialog">
        <q-card-section>
          <div class="text-h6">
            {{ $t('deleteRecordingTitle') }}
          </div>
          <div class="text-grey-7 q-mt-sm">
            {{ $t('deleteRecordingMessage') }}
          </div>
        </q-card-section>

        <q-card-section v-if="recording.filePath">
          <q-checkbox
            v-model="deleteFile"
            :label="$t('deleteFileAlso')"
            color="negative"
          />
        </q-card-section>

        <q-card-actions align="right">
          <q-btn
            v-close-popup
            flat
            :label="$t('cancel')"
            color="grey-7"
          />
          <q-btn
            flat
            :label="$t('delete')"
            color="negative"
            @click="confirmDelete"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script>
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import AudioPlayback from './AudioPlayback.vue';

export default {
  name: 'RecordingHistoryCard',

  components: {
    AudioPlayback
  },

  props: {
    recording: {
      type: Object,
      required: true
    },
    uploading: {
      type: Boolean,
      default: false
    }
  },

  emits: ['upload', 'retry', 'deleted'],

  setup(props, { emit }) {
    const { t } = useI18n();
    const historyStore = useRecordingsHistoryStore();

    const expanded = ref(false);
    const showDeleteDialog = ref(false);
    const deleteFile = ref(true);

    const formattedDate = computed(() => {
      const data = historyStore.formatDateData(props.recording.createdAt);
      if (data.type === 'today') {
        return t('dateToday', { time: data.time });
      }
      if (data.type === 'yesterday') {
        return t('dateYesterday', { time: data.time });
      }
      return data.formatted || '';
    });

    const formattedDuration = computed(() =>
      historyStore.formatDuration(props.recording.duration)
    );

    const formattedSize = computed(() =>
      historyStore.formatFileSize(props.recording.fileSize)
    );

    const currentStatus = computed(() =>
      props.uploading ? 'uploading' : props.recording.uploadStatus
    );

    const statusLabel = computed(() => {
      if (props.uploading) return t('statusUploading');
      const statusKeys = {
        pending: 'statusPending',
        uploaded: 'statusUploaded',
        failed: 'statusFailed'
      };
      const key = statusKeys[props.recording.uploadStatus];
      return key ? t(key) : 'Unknown';
    });

    const onDelete = () => {
      showDeleteDialog.value = true;
    };

    const confirmDelete = async () => {
      await historyStore.deleteRecording(props.recording.id, deleteFile.value);
      showDeleteDialog.value = false;
      emit('deleted', props.recording.id);
    };

    return {
      expanded,
      showDeleteDialog,
      deleteFile,
      formattedDate,
      formattedDuration,
      formattedSize,
      currentStatus,
      statusLabel,
      onDelete,
      confirmDelete
    };
  }
};
</script>

<style lang="scss" scoped>
.history-card {
  background: white;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  padding: 10px 12px;
  margin-bottom: 8px;
  transition: all 0.2s ease;

  &:hover {
    box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.08);
  }

  // Status border colors
  &.status-pending {
    border-left: 3px solid #f59e0b;
  }

  &.status-uploaded {
    border-left: 3px solid #22c55e;
  }

  &.status-failed {
    border-left: 3px solid #ef4444;
  }

  &.status-uploading {
    border-left: 3px solid #6366f1;
  }
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.card-info {
  flex: 1;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;

  .recording-date {
    font-weight: 500;
    font-size: 12px;
    color: #1e293b;
  }
}

.status-badge {
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 9px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;

  &.pending {
    background: rgba(245, 158, 11, 0.1);
    color: #d97706;
  }

  &.uploaded {
    background: rgba(34, 197, 94, 0.1);
    color: #16a34a;
  }

  &.failed {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
  }

  &.uploading {
    background: rgba(99, 102, 241, 0.1);
    color: #6366f1;
  }
}

.recording-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #64748b;
  font-size: 10px;

  .meta-item {
    display: flex;
    align-items: center;
    gap: 3px;
  }
}

.card-actions {
  display: flex;
  gap: 2px;
}

.card-player {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #e2e8f0;
}

.delete-dialog {
  min-width: 280px;
  border-radius: 8px;
}
</style>
