<template>
  <q-dialog
    v-model="showDialog"
    persistent
  >
    <q-card class="update-dialog-card">
      <q-card-section class="row items-center q-pb-none">
        <q-avatar
          icon="system_update_alt"
          color="primary"
          text-color="white"
        />
        <div class="text-h6 q-ml-md">
          {{ t('updateReadyTitle') }}
        </div>
      </q-card-section>

      <q-card-section class="q-pt-md">
        {{ t('updateReadyMessage', { version: updateVersion }) }}
      </q-card-section>

      <q-card-section class="q-pt-none text-caption text-grey-7">
        {{ t('updateReadyLaterHint') }}
      </q-card-section>

      <q-card-actions
        align="right"
        class="q-px-md q-pb-md"
      >
        <q-btn
          flat
          :label="t('updateReadyLater')"
          color="grey-7"
          @click="dismiss"
        />
        <q-btn
          unelevated
          :label="t('updateReadyNow')"
          color="primary"
          icon="system_update_alt"
          :loading="installing"
          @click="installNow"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuasar } from 'quasar';
import { useRecordingStore } from '../stores/recording';
import { isElectron } from '../utils/platform';
import { useUpdateDownloadNotice } from '../composables/useUpdateDownloadNotice';

const { t } = useI18n();
const $q = useQuasar();
const recordingStore = useRecordingStore();

const showDialog = ref(false);
const updateVersion = ref('');
const installing = ref(false);
// Versions the user dismissed this session — don't nag again until the next
// app launch (the launch-time getStatus pull re-prompts, which is the point:
// every fresh app open with a pending update asks once).
const dismissedVersions = new Set();
// An update became ready while the user was recording/uploading — hold the
// dialog and show it as soon as the app is idle again.
const pendingVersion = ref(null);

let removeListeners = [];
const downloadNotice = useUpdateDownloadNotice({
  notify: options => $q.notify(options), t, isBlocking: () => recordingStore.isBlocking
});

const maybeShow = (version) => {
  if (!version || dismissedVersions.has(version)) return;
  if (recordingStore.isBlocking) {
    // Never interrupt an active recording/processing/upload.
    pendingVersion.value = version;
    return;
  }
  updateVersion.value = version;
  showDialog.value = true;
};

watch(() => recordingStore.isBlocking, (blocking) => {
  downloadNotice.refresh();
  if (!blocking && pendingVersion.value) {
    const v = pendingVersion.value;
    pendingVersion.value = null;
    maybeShow(v);
  }
});

const dismiss = () => {
  dismissedVersions.add(updateVersion.value);
  showDialog.value = false;
};

const installNow = async () => {
  installing.value = true;
  try {
    const result = await window.electronAPI.updater.quitAndInstall();
    if (!result?.success) {
      installing.value = false;
      showDialog.value = false;
      $q.notify({
        type: 'warning',
        message: result?.error || 'Could not install the update right now',
        timeout: 5000
      });
    }
    // On success the app quits and relaunches into the new version.
  } catch (e) {
    installing.value = false;
    console.warn('quitAndInstall failed:', e);
  }
};

onMounted(async () => {
  if (!isElectron() || !window.electronAPI?.updater) return;

  const updater = window.electronAPI.updater;
  // Live event for updates downloaded while the app is running.
  removeListeners.push(updater.onUpdateDownloaded((info) => {
    downloadNotice.done();
    maybeShow(info?.version);
  }));
  // Found and still downloading: say so right away (older preloads lack these).
  if (updater.onUpdateAvailable) removeListeners.push(updater.onUpdateAvailable(info => downloadNotice.downloading(info?.version)));
  if (updater.onUpdateProgress) removeListeners.push(updater.onUpdateProgress(info => downloadNotice.downloading(info?.version, info?.percent)));
  if (updater.onUpdateFailed) removeListeners.push(updater.onUpdateFailed(() => downloadNotice.done()));

  // Pull on launch — the update usually finishes downloading before the
  // renderer (or the user's login) is ready, so the event alone is not enough.
  try {
    const status = await updater.getStatus();
    if (status?.updateDownloaded) {
      maybeShow(status.version);
    } else if (status?.downloading) {
      downloadNotice.downloading(status.downloading.version, status.downloading.percent);
    }
  } catch (e) {
    console.warn('updater.getStatus failed:', e);
  }
});

onUnmounted(() => {
  for (const remove of removeListeners.splice(0)) remove?.();
  downloadNotice.done();
});
</script>

<style scoped>
.update-dialog-card {
  min-width: 380px;
  max-width: 480px;
}
</style>
