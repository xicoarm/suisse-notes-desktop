<template>
  <router-view />
</template>

<script setup>
import { onMounted, onUnmounted, watch } from 'vue';
import { useConfigStore } from './stores/config';
import { useRecordingStore } from './stores/recording';
import { isMobile } from './utils/platform';

const configStore = useConfigStore();
const recordingStore = useRecordingStore();

onMounted(async () => {
  // Load configuration on app start
  await configStore.loadConfig();
  // Session check is now handled by router guard (prevents race condition)

  // Initialize mobile lifecycle callbacks (background/foreground/online/offline)
  if (isMobile()) {
    recordingStore.initializeLifecycle();

    // Run startup recovery for orphaned recordings
    try {
      const recovery = await recordingStore.checkRecoveryState();
      if (recovery.recovered && recovery.recordings?.length > 0) {
        const { useRecordingsHistoryStore } = await import('./stores/recordings-history');
        const historyStore = useRecordingsHistoryStore();
        for (const rec of recovery.recordings) {
          await historyStore.addRecording(rec);
        }
        console.log(`Startup: recovered ${recovery.recordings.length} recording(s)`);
      }
    } catch (e) {
      console.warn('Startup recovery failed:', e);
    }

    // Process persistent upload queue once auth is ready
    const processQueue = async (authStore) => {
      try {
        const { processMobileUploadQueue } = await import('./services/upload');
        const { getApiUrlSync } = await import('./services/api');
        processMobileUploadQueue(authStore, getApiUrlSync).catch(e => {
          console.warn('Startup upload queue processing failed:', e);
        });
      } catch (e) {
        console.warn('Could not process upload queue:', e);
      }
    };

    try {
      const { useAuthStore } = await import('./stores/auth');
      const authStore = useAuthStore();

      if (authStore.isAuthenticated) {
        processQueue(authStore);
      } else {
        // Wait for auth to become ready, with a 15s timeout safety net
        let unwatch = null;
        const timeout = setTimeout(() => { if (unwatch) unwatch(); }, 15000);
        unwatch = watch(() => authStore.isAuthenticated, (isAuth) => {
          if (isAuth) {
            unwatch();
            clearTimeout(timeout);
            processQueue(authStore);
          }
        });
      }
    } catch (e) {
      console.warn('Could not set up upload queue processing:', e);
    }
  }
});

onUnmounted(() => {
  if (isMobile()) {
    recordingStore.cleanupLifecycle();
  }
});
</script>
