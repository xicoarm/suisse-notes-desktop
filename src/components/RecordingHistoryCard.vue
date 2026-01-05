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
            <q-icon name="schedule" size="xs" />
            <span>{{ formattedDuration }}</span>
          </div>
          <div class="meta-item" v-if="recording.fileSize">
            <q-icon name="save" size="xs" />
            <span>{{ formattedSize }}</span>
          </div>
          <div class="meta-item" v-if="recording.storagePreference === 'delete_after_upload'">
            <q-icon name="auto_delete" size="xs" />
            <span>Auto-delete</span>
          </div>
        </div>
      </div>

      <div class="card-actions">
        <!-- Uploading spinner -->
        <q-spinner-dots v-if="uploading" color="primary" size="24px" />

        <q-btn
          v-else-if="recording.uploadStatus === 'pending' && recording.filePath"
          flat
          round
          icon="cloud_upload"
          color="primary"
          size="sm"
          @click="$emit('upload', recording)"
        >
          <q-tooltip>Upload</q-tooltip>
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
          <q-tooltip>Retry Upload</q-tooltip>
        </q-btn>

        <q-btn
          flat
          round
          :icon="expanded ? 'expand_less' : 'expand_more'"
          color="grey-7"
          size="sm"
          @click="expanded = !expanded"
          v-if="recording.filePath && !uploading"
          :disable="uploading"
        >
          <q-tooltip>{{ expanded ? 'Hide' : 'Play' }}</q-tooltip>
        </q-btn>

        <q-btn
          flat
          round
          icon="delete_outline"
          color="grey-7"
          size="sm"
          @click="onDelete"
          :disable="uploading"
        >
          <q-tooltip>Delete</q-tooltip>
        </q-btn>
      </div>
    </div>

    <q-slide-transition>
      <div v-if="expanded && recording.filePath" class="card-player">
        <AudioPlayback :file-path="recording.filePath" />
      </div>
    </q-slide-transition>

    <!-- Delete confirmation dialog -->
    <q-dialog v-model="showDeleteDialog">
      <q-card class="delete-dialog">
        <q-card-section>
          <div class="text-h6">Delete Recording?</div>
          <div class="text-grey-7 q-mt-sm">
            This will remove the recording from your history.
          </div>
        </q-card-section>

        <q-card-section v-if="recording.filePath">
          <q-checkbox
            v-model="deleteFile"
            label="Also delete the audio file from disk"
            color="negative"
          />
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat label="Cancel" color="grey-7" v-close-popup />
          <q-btn
            flat
            label="Delete"
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
    const historyStore = useRecordingsHistoryStore();

    const expanded = ref(false);
    const showDeleteDialog = ref(false);
    const deleteFile = ref(true);

    const formattedDate = computed(() =>
      historyStore.formatDate(props.recording.createdAt)
    );

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
      if (props.uploading) return 'Uploading';
      const labels = {
        pending: 'Pending',
        uploaded: 'Uploaded',
        failed: 'Failed'
      };
      return labels[props.recording.uploadStatus] || 'Unknown';
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
