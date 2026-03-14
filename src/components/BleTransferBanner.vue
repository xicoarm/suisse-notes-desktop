<template>
  <div
    v-if="deviceStore.isSyncing"
    class="mobile-sync-indicator"
    @click="goToDevice"
  >
    <q-spinner-dots
      color="white"
      size="12px"
    />
    <span>{{ pillText }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useDeviceStore } from '../stores/device';

const { t } = useI18n();
const router = useRouter();
const deviceStore = useDeviceStore();

const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

const pillText = computed(() => {
  if (deviceStore.syncPhase === 'uploading') {
    return t('bleTransferUploading');
  }
  // During download, show bytes progress
  if (deviceStore.syncPhase === 'downloading' && deviceStore.syncBytesTotal > 0) {
    return `${formatBytes(deviceStore.syncBytesReceived)} / ${formatBytes(deviceStore.syncBytesTotal)}`;
  }
  // Fallback: percentage
  return `${deviceStore.syncProgress}%`;
});

const goToDevice = () => {
  router.push('/device');
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
  background: rgba(99, 102, 241, 0.95);
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  color: white;
  cursor: pointer;
  z-index: 9997;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
}
</style>
