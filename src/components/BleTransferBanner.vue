<template>
  <div
    v-if="visible"
    class="mobile-sync-indicator"
    :class="[pillClass]"
    @click="onTap"
  >
    <q-spinner-dots
      v-if="deviceStore.isSyncing"
      color="white"
      size="12px"
    />
    <q-icon
      v-else-if="deviceStore.syncState === 'complete'"
      name="check_circle"
      color="white"
      size="14px"
    />
    <q-icon
      v-else-if="deviceStore.syncState === 'error'"
      name="error_outline"
      color="white"
      size="14px"
    />
    <span>{{ pillText }}</span>
    <!-- Manual dismiss for the sticky error state -->
    <q-icon
      v-if="deviceStore.syncState === 'error'"
      name="close"
      size="14px"
      color="white"
      class="dismiss-x"
      @click.stop="dismiss"
    />
  </div>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useDeviceStore } from '../stores/device';

const { t } = useI18n();
const router = useRouter();
const deviceStore = useDeviceStore();

// Local dismiss flag so user can close the pill (esp. in error state).
// Resets whenever syncState transitions back to 'syncing' so the user sees
// the next run's banner.
const dismissed = ref(false);

// Auto-dismiss timer for the 'complete' state.
// Success needs no user action — hide after 5s. Failure stays until
// the user taps the close X (so they can't miss it).
let autoDismissTimer = null;
const clearAutoDismiss = () => {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
};

watch(() => deviceStore.syncState, (newState, oldState) => {
  // Fresh sync → forget any prior dismiss decision
  if (newState === 'syncing' && oldState !== 'syncing') {
    dismissed.value = false;
    clearAutoDismiss();
    return;
  }
  if (newState === 'complete') {
    clearAutoDismiss();
    autoDismissTimer = setTimeout(() => {
      // Flip store back to idle so the pill disappears app-wide.
      // Keeps this component stateless beyond the dismiss flag.
      if (deviceStore.syncState === 'complete') {
        deviceStore.syncState = 'idle';
      }
    }, 5000);
  }
  if (newState === 'idle' || newState === 'error') {
    clearAutoDismiss();
  }
});

onBeforeUnmount(clearAutoDismiss);

// Banner is visible while any of: syncing, success-just-happened, error-not-dismissed
const visible = computed(() => {
  if (dismissed.value) return false;
  return deviceStore.isSyncing ||
    deviceStore.syncState === 'complete' ||
    deviceStore.syncState === 'error';
});

const pillClass = computed(() => ({
  'sync-pill-syncing': deviceStore.isSyncing,
  'sync-pill-complete': deviceStore.syncState === 'complete',
  'sync-pill-error': deviceStore.syncState === 'error'
}));

const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

const pillText = computed(() => {
  if (deviceStore.syncState === 'complete') return t('bleBannerComplete');
  if (deviceStore.syncState === 'error') return t('bleBannerFailed');
  if (deviceStore.syncPhase === 'uploading') return t('bleTransferUploading');
  if (deviceStore.syncPhase === 'downloading' && deviceStore.syncBytesTotal > 0) {
    return `${formatBytes(deviceStore.syncBytesReceived)} / ${formatBytes(deviceStore.syncBytesTotal)}`;
  }
  return `${deviceStore.syncProgress}%`;
});

const onTap = () => {
  router.push('/device');
  // Tapping a terminal-state pill implies "I've seen it" → dismiss
  if (deviceStore.syncState === 'complete' || deviceStore.syncState === 'error') {
    dismiss();
  }
};

const dismiss = () => {
  dismissed.value = true;
  clearAutoDismiss();
  if (deviceStore.syncState === 'complete') {
    deviceStore.syncState = 'idle';
  }
};
</script>

<style lang="scss" scoped>
.mobile-sync-indicator {
  position: fixed;
  top: calc(env(safe-area-inset-top, 8px) + 8px);
  right: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  color: white;
  cursor: pointer;
  z-index: 9997;
  transition: background 0.25s ease, box-shadow 0.25s ease;
}

.sync-pill-syncing {
  background: rgba(99, 102, 241, 0.95);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
}

.sync-pill-complete {
  background: rgba(34, 197, 94, 0.95);
  box-shadow: 0 4px 12px rgba(34, 197, 94, 0.4);
}

.sync-pill-error {
  background: rgba(239, 68, 68, 0.95);
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
}

.dismiss-x {
  margin-left: 4px;
  opacity: 0.85;
  cursor: pointer;

  &:hover { opacity: 1; }
}
</style>
