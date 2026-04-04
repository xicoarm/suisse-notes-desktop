<template>
  <div :class="['history-card', 'status-card', `status-${currentStatus}`, { 'clickable-card': isUploaded }]">
    <div class="card-header">
      <div
        class="card-info"
        :class="{ clickable: isUploaded }"
        @click="onCardClick"
      >
        <div class="card-title">
          <span class="recording-date">{{ formattedDate }}</span>
          <span :class="['status-badge', currentStatus]">
            {{ statusLabel }}
          </span>
          <span
            v-if="recording.source === 'device'"
            class="source-badge device"
          >
            <q-icon
              name="bluetooth"
              size="10px"
            />
            {{ $t('device') }}
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

        <!-- Visible "View transcript" link for uploaded recordings -->
        <div
          v-if="isUploaded"
          class="view-transcript-link"
        >
          <q-icon
            name="open_in_new"
            size="12px"
          />
          <span>{{ $t('viewTranscript') }}</span>
        </div>
      </div>

      <div class="card-actions">
        <!-- Loading spinner while generating link -->
        <q-spinner-dots
          v-if="linkLoading"
          color="primary"
          size="24px"
        />

        <!-- Transferring from device: spinner + cancel -->
        <template v-if="recording.uploadStatus === 'transferring'">
          <q-spinner-dots
            color="primary"
            size="24px"
          />
          <q-btn
            flat
            round
            icon="close"
            color="negative"
            size="sm"
            @click="onCancelTransfer"
          >
            <q-tooltip>{{ $t('cancelSync') }}</q-tooltip>
          </q-btn>
        </template>

        <!-- Uploading spinner + cancel -->
        <template v-else-if="uploading || recording.uploadStatus === 'uploading'">
          <q-spinner-dots
            color="primary"
            size="24px"
          />
          <q-btn
            flat
            round
            icon="close"
            color="negative"
            size="sm"
            @click="onCancelTransfer"
          >
            <q-tooltip>{{ $t('cancel') }}</q-tooltip>
          </q-btn>
        </template>

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

        <!-- Pending without file: resync from device or delete -->
        <q-btn
          v-else-if="recording.uploadStatus === 'pending' && !recording.filePath && recording.source === 'device'"
          flat
          round
          icon="sync"
          color="primary"
          size="sm"
          @click="$emit('resync', recording)"
        >
          <q-tooltip>{{ $t('resyncFromDevice') }}</q-tooltip>
        </q-btn>

        <!-- Cancelled or Skipped: re-upload (has local file) or re-sync (needs device) -->
        <q-btn
          v-else-if="(recording.uploadStatus === 'cancelled' || recording.uploadStatus === 'skipped') && recording.filePath"
          flat
          round
          icon="cloud_upload"
          color="primary"
          size="sm"
          @click="$emit('upload', recording)"
        >
          <q-tooltip>{{ $t('reUpload') }}</q-tooltip>
        </q-btn>
        <q-btn
          v-else-if="(recording.uploadStatus === 'cancelled' || recording.uploadStatus === 'skipped') && !recording.filePath"
          flat
          round
          icon="sync"
          color="primary"
          size="sm"
          @click="$emit('resync', recording)"
        >
          <q-tooltip>{{ $t('resyncFromDevice') }}</q-tooltip>
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

        <!-- Failed without file: resync from device -->
        <q-btn
          v-else-if="recording.uploadStatus === 'failed' && !recording.filePath && recording.source === 'device'"
          flat
          round
          icon="sync"
          color="warning"
          size="sm"
          @click="$emit('resync', recording)"
        >
          <q-tooltip>{{ $t('resyncFromDevice') }}</q-tooltip>
        </q-btn>

        <!-- Failed without file and not from device: allow delete -->
        <q-btn
          v-else-if="recording.uploadStatus === 'failed' && !recording.filePath"
          flat
          round
          icon="delete_outline"
          color="negative"
          size="sm"
          @click="onDelete"
        >
          <q-tooltip>{{ $t('delete') }}</q-tooltip>
        </q-btn>

        <!-- Copy link button for uploaded recordings -->
        <q-btn
          v-if="isUploaded && !linkLoading"
          flat
          round
          icon="content_copy"
          color="grey-7"
          size="sm"
          @click="onCopyLink"
        >
          <q-tooltip>{{ $t('copyLinkTooltip') }}</q-tooltip>
        </q-btn>

        <!-- Open file location (desktop only) -->
        <q-btn
          v-if="isDesktop && recording.filePath && !uploading"
          flat
          round
          icon="folder_open"
          color="grey-7"
          size="sm"
          @click="openFileLocation"
        >
          <q-tooltip>{{ $t('openFileLocation') }}</q-tooltip>
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
import { useQuasar } from 'quasar';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { useShareLink } from '../composables/useShareLink';
import { isElectron } from '../utils/platform';
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

  emits: ['upload', 'retry', 'deleted', 'cancel-transfer', 'resync'],

  setup(props, { emit }) {
    const { t } = useI18n();
    const $q = useQuasar();
    const historyStore = useRecordingsHistoryStore();
    const { openInBrowser, copyLink } = useShareLink();

    const expanded = ref(false);
    const showDeleteDialog = ref(false);
    const deleteFile = ref(true);
    const linkLoading = ref(false);
    const isDesktop = isElectron();

    const formattedDate = computed(() => {
      const data = historyStore.formatDateData(props.recording.createdAt);
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

    const isUploaded = computed(() =>
      props.recording.uploadStatus === 'uploaded' && !!props.recording.audioFileId
    );

    const statusLabel = computed(() => {
      if (props.uploading) return t('statusUploading');
      const statusKeys = {
        pending: 'statusPending',
        uploading: 'statusUploading',
        uploaded: 'statusUploaded',
        failed: 'statusFailed',
        recording: 'statusRecording',
        cancelled: 'statusCancelled',
        skipped: 'statusSkipped',
        transferring: 'statusTransferring'
      };
      const key = statusKeys[props.recording.uploadStatus];
      return key ? t(key) : 'Unknown';
    });

    const onCardClick = async () => {
      if (!isUploaded.value || linkLoading.value) return;
      linkLoading.value = true;
      try {
        await openInBrowser(props.recording.audioFileId);
      } finally {
        linkLoading.value = false;
      }
    };

    const onCopyLink = async () => {
      if (!isUploaded.value || linkLoading.value) return;
      linkLoading.value = true;
      try {
        await copyLink(props.recording.audioFileId);
      } finally {
        linkLoading.value = false;
      }
    };

    const onCancelTransfer = () => {
      $q.dialog({
        title: t('cancelSyncTitle'),
        message: t('cancelSyncMessage'),
        cancel: { flat: true, label: t('cancel'), color: 'grey-7' },
        ok: { flat: true, label: t('cancelSync'), color: 'negative' }
      }).onOk(() => {
        emit('cancel-transfer', props.recording);
      });
    };

    const openFileLocation = () => {
      if (isDesktop && props.recording.filePath) {
        window.electronAPI.shell.showItemInFolder(props.recording.filePath);
      }
    };

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
      linkLoading,
      formattedDate,
      formattedDuration,
      formattedSize,
      currentStatus,
      isUploaded,
      statusLabel,
      onCardClick,
      onCopyLink,
      onCancelTransfer,
      openFileLocation,
      isDesktop,
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

  &.clickable-card:hover {
    box-shadow: 0 2px 8px -2px rgba(0, 0, 0, 0.12);
    border-color: #cbd5e1;
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

  &.status-recording {
    border-left: 3px solid #ef4444;
  }

  &.status-cancelled {
    border-left: 3px solid #94a3b8;
  }

  &.status-skipped {
    border-left: 3px dashed #a1a1aa;
  }

  &.status-transferring {
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

  &.clickable {
    cursor: pointer;
    border-radius: 6px;
    padding: 2px 4px;
    margin: -2px -4px;
    transition: background-color 0.15s ease;

    &:hover {
      background-color: rgba(99, 102, 241, 0.04);
    }

    &:active {
      background-color: rgba(99, 102, 241, 0.08);
    }
  }
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

.view-transcript-link {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #6366f1;
  transition: color 0.15s ease;

  .clickable:hover & {
    color: #4f46e5;
    text-decoration: underline;
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

  &.recording {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
  }

  &.cancelled {
    background: rgba(148, 163, 184, 0.1);
    color: #64748b;
  }

  &.skipped {
    background: rgba(161, 161, 170, 0.1);
    color: #78716c;
  }

  &.transferring {
    background: rgba(99, 102, 241, 0.1);
    color: #6366f1;
  }
}

.source-badge {
  padding: 2px 6px;
  border-radius: 9999px;
  font-size: 9px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  display: inline-flex;
  align-items: center;
  gap: 3px;

  &.device {
    background: rgba(59, 130, 246, 0.1);
    color: #2563eb;
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

@media (max-width: 600px) {
  .history-card {
    padding: 14px 16px;
  }

  .status-badge {
    font-size: 12px;
    padding: 3px 10px;
  }

  .card-title .recording-date {
    font-size: 15px;
  }

  .recording-meta {
    font-size: 13px;
    gap: 14px;

    .meta-item {
      gap: 5px;
    }
  }

  .card-actions {
    gap: 4px;

    :deep(.q-btn--round.q-btn--sm) {
      min-width: 44px;
      min-height: 44px;
    }
  }
}
</style>
