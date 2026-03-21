<template>
  <router-view />
</template>

<script setup>
import { onMounted, onUnmounted, watch, ref } from 'vue';
import { useConfigStore } from './stores/config';
import { useRecordingStore } from './stores/recording';
import { isMobile } from './utils/platform';

const configStore = useConfigStore();
const recordingStore = useRecordingStore();
const mobileRetryInterval = ref(null);
const failedRetryInterval = ref(null);

onMounted(async () => {
  // Load configuration on app start
  await configStore.loadConfig();
  // Session check is now handled by router guard (prevents race condition)

  // Initialize mobile lifecycle callbacks (background/foreground/online/offline)
  if (isMobile()) {
    recordingStore.initializeLifecycle();

    // Initialize BLE device store early so auto-reconnect works app-wide
    try {
      const { useDeviceStore } = await import('./stores/device');
      const deviceStore = useDeviceStore();
      await deviceStore.initialize();
      // Auto-connect to paired device on app startup
      if (deviceStore.hasPairedDevice && !deviceStore.isConnected) {
        deviceStore.autoConnect().catch(() => {});
      }
    } catch (e) {
      console.warn('Device store init failed:', e);
    }

    // Run startup recovery for orphaned recordings
    try {
      const recovery = await recordingStore.checkRecoveryState();
      if (recovery.recovered && recovery.recordings?.length > 0) {
        const { useRecordingsHistoryStore } = await import('./stores/recordings-history');
        const { addToMobileUploadQueue } = await import('./services/upload');
        const historyStore = useRecordingsHistoryStore();
        for (const rec of recovery.recordings) {
          await historyStore.addRecording(rec);
          // Auto-queue recovered recordings for upload
          if (rec.filePath) {
            addToMobileUploadQueue(rec.id, rec.filePath, {
              duration: (rec.duration || 0).toString(),
              title: '',
              customVocabulary: []
            });
          }
        }
        console.log(`Startup: recovered ${recovery.recordings.length} recording(s) and queued for upload`);
      }
    } catch (e) {
      console.warn('Startup recovery failed:', e);
    }

    // Process persistent upload queue once auth is ready
    const processQueue = async (authStore) => {
      try {
        const { processMobileUploadQueue, getMobileUploadQueue } = await import('./services/upload');
        const { getApiUrlSync } = await import('./services/api');
        processMobileUploadQueue(authStore, getApiUrlSync).catch(e => {
          console.warn('Startup upload queue processing failed:', e);
        });

        // Periodic retry every 60 seconds for failed mobile uploads
        mobileRetryInterval.value = setInterval(() => {
          // Only retry when authenticated and app is in foreground
          if (!authStore.isAuthenticated || document.hidden) return;
          const queue = getMobileUploadQueue();
          if (queue.length > 0) {
            processMobileUploadQueue(authStore, getApiUrlSync).catch(e => {
              console.warn('Periodic mobile upload retry failed:', e);
            });
          }
        }, 60000);
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

  // Auto-retry failed/pending uploads (works on both desktop and mobile)
  const startFailedRetry = async (authStore) => {
    try {
      const { useRecordingsHistoryStore } = await import('./stores/recordings-history');
      const historyStore = useRecordingsHistoryStore();

      // Ensure recordings are loaded before retrying
      if (!historyStore.loaded) {
        await historyStore.loadRecordings();
      }

      // Initial retry attempt after 30s
      setTimeout(() => {
        if (authStore.isAuthenticated && !document.hidden) {
          historyStore.retryFailedUploads().catch(e => {
            console.warn('Initial failed upload retry failed:', e);
          });
        }
      }, 30000);

      // Periodic retry every 60 seconds
      failedRetryInterval.value = setInterval(() => {
        if (!authStore.isAuthenticated || document.hidden) return;
        historyStore.retryFailedUploads().catch(e => {
          console.warn('Periodic failed upload retry failed:', e);
        });
      }, 60000);
    } catch (e) {
      console.warn('Could not set up failed upload retry:', e);
    }
  };

  try {
    const { useAuthStore } = await import('./stores/auth');
    const authStore = useAuthStore();

    if (authStore.isAuthenticated) {
      startFailedRetry(authStore);
    } else {
      let unwatch = null;
      const timeout = setTimeout(() => { if (unwatch) unwatch(); }, 15000);
      unwatch = watch(() => authStore.isAuthenticated, (isAuth) => {
        if (isAuth) {
          unwatch();
          clearTimeout(timeout);
          startFailedRetry(authStore);
        }
      });
    }
  } catch (e) {
    console.warn('Could not set up failed upload retry:', e);
  }
});

onUnmounted(() => {
  if (isMobile()) {
    recordingStore.cleanupLifecycle();
  }
  if (mobileRetryInterval.value) {
    clearInterval(mobileRetryInterval.value);
    mobileRetryInterval.value = null;
  }
  if (failedRetryInterval.value) {
    clearInterval(failedRetryInterval.value);
    failedRetryInterval.value = null;
  }
});
</script>
