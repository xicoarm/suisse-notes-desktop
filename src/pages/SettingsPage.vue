<template>
  <q-page class="settings-page">
    <div class="settings-container">
      <div class="page-header">
        <h1>{{ $t('settingsTitle') }}</h1>
        <p class="text-subtitle">
          {{ $t('settingsSubtitle') }}
        </p>
      </div>

      <!-- Account Section -->
      <div
        v-if="authStore.isAuthenticated"
        class="settings-section"
      >
        <div class="section-title">
          {{ $t('accountSection') }}
        </div>

        <div class="setting-row">
          <div class="setting-label">
            {{ $t('signedInAs') }}
          </div>
          <div class="setting-value">
            {{ authStore.user?.email }}
          </div>
        </div>

        <div
          v-if="authStore.user?.name"
          class="setting-row"
        >
          <div class="setting-label">
            {{ $t('nameLabel') }}
          </div>
          <div class="setting-value">
            {{ authStore.user?.name }}
          </div>
        </div>

        <div
          v-if="authStore.user?.organizationName"
          class="setting-row"
        >
          <div class="setting-label">
            {{ $t('organizationLabel') }}
          </div>
          <div class="setting-value">
            {{ authStore.user.organizationName }}
          </div>
        </div>

        <!-- Credits / Minutes -->
        <div class="setting-row">
          <div class="setting-label">
            {{ $t('remainingCredits') }}
          </div>
          <div class="setting-value">
            <template v-if="minutesStore.loading">
              <q-spinner-dots
                size="16px"
                color="grey-5"
              />
            </template>
            <template v-else-if="minutesStore.unlimited">
              {{ $t('unlimited') }}
            </template>
            <template v-else>
              {{ Math.round(minutesStore.remainingMinutes) }} {{ $t('minutesUnit') }}
            </template>
          </div>
        </div>

        <div class="section-actions">
          <q-btn
            flat
            color="negative"
            :label="$t('signOut')"
            icon="logout"
            class="btn-danger"
            @click="handleLogout"
          />
        </div>
      </div>

      <!-- Recording Device Section (Mobile only) -->
      <div
        v-if="isMobileApp"
        class="settings-section"
      >
        <div class="section-title">
          {{ $t('deviceTitle') }}
        </div>

        <!-- Paired device card -->
        <div
          v-if="deviceStore.hasPairedDevice"
          class="device-setting-card"
        >
          <div class="device-setting-row">
            <div class="device-setting-icon">
              <q-icon
                name="bluetooth"
                size="20px"
                color="white"
              />
            </div>
            <div class="device-setting-info">
              <div class="device-setting-name">
                {{ deviceStore.deviceName || deviceStore.pairedDevice?.name }}
              </div>
              <div class="device-setting-status">
                <span
                  class="status-dot-small"
                  :class="{ connected: deviceStore.isConnected }"
                />
                {{ deviceStore.isConnected ? $t('connected') : $t('disconnected') }}
              </div>
            </div>
            <div class="device-setting-actions">
              <q-btn
                v-if="!deviceStore.isConnected && !deviceStore.isConnecting"
                flat
                dense
                color="primary"
                icon="bluetooth"
                :label="$t('connectDevice')"
                no-caps
                @click="reconnectDevice"
              />
              <q-spinner-dots
                v-if="deviceStore.isConnecting"
                color="primary"
                size="20px"
              />
              <q-btn
                v-if="deviceStore.isConnected"
                flat
                dense
                color="grey-6"
                icon="bluetooth_disabled"
                :label="$t('disconnectDevice')"
                no-caps
                @click="disconnectDevice"
              />
            </div>
          </div>
          <!-- Device files & sync page -->
          <q-btn
            v-if="deviceStore.isConnected"
            unelevated
            class="gradient-btn full-width q-mt-md"
            icon="folder_open"
            :label="$t('manageDevice')"
            no-caps
            @click="$router.push('/device')"
          />
          <div class="device-setting-footer">
            <q-btn
              flat
              dense
              color="negative"
              icon="delete_outline"
              :label="$t('forgetDevice')"
              no-caps
              size="sm"
              @click="confirmForgetDevice"
            />
          </div>
        </div>

        <!-- No paired device — scan UI -->
        <div
          v-else
          class="device-scan-section"
        >
          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">
                {{ $t('connectRecorder') }}
              </div>
              <div class="setting-description">
                {{ $t('connectRecorderDesc') }}
              </div>
            </div>
          </div>
          <q-btn
            unelevated
            class="gradient-btn full-width q-mt-sm"
            :icon="deviceStore.isScanning ? undefined : 'bluetooth_searching'"
            :label="deviceStore.isScanning ? $t('scanning') : $t('scanForDevices')"
            :loading="deviceStore.isScanning"
            @click="deviceStore.isScanning ? deviceStore.stopScan() : startDeviceScan()"
          />

          <!-- Scan Results -->
          <div
            v-if="deviceStore.scanResults.length > 0"
            class="scan-results-settings"
          >
            <div class="scan-results-title">
              {{ $t('devicesFound') }}
            </div>
            <div
              v-for="device in deviceStore.scanResults"
              :key="device.deviceId"
              class="scan-result-row"
              @click="pairDevice(device)"
            >
              <q-icon
                name="bluetooth"
                color="primary"
                size="18px"
              />
              <div class="scan-result-info">
                <span class="scan-result-name">{{ device.name || $t('unknownDevice') }}</span>
                <span class="scan-result-rssi">{{ device.rssi ? `${device.rssi} dBm` : '' }}</span>
              </div>
              <q-icon
                name="chevron_right"
                color="grey-5"
                size="18px"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Language Section -->
      <div class="settings-section">
        <div class="section-title">
          {{ $t('language') }}
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">
              {{ $t('appLanguage') }}
            </div>
            <div class="setting-description">
              {{ $t('appLanguageDesc') }}
            </div>
          </div>
          <q-select
            :model-value="languages.find(l => l.value === currentLang)"
            :options="languages"
            option-value="value"
            option-label="label"
            emit-value
            map-options
            outlined
            dense
            class="preference-select"
            @update:model-value="setLanguage"
          />
        </div>
      </div>

      <!-- Storage Preferences Section -->
      <div class="settings-section">
        <div class="section-title">
          {{ $t('storageSection') }}
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">
              {{ $t('storagePreference') }}
            </div>
            <div class="setting-description">
              {{ $t('storagePreferenceDesc') }}
            </div>
          </div>
          <q-select
            v-model="storagePreference"
            :options="storageOptions"
            emit-value
            map-options
            outlined
            dense
            class="preference-select"
            @update:model-value="updateStoragePreference"
          />
        </div>

        <div class="setting-row">
          <div class="setting-label">
            {{ $t('dataLocation') }}
          </div>
          <div class="setting-value path-value">
            {{ userDataPath }}
          </div>
        </div>
      </div>

      <!-- Transcription Section -->
      <div class="settings-section">
        <div class="section-title">
          {{ $t('transcriptionOptions') }}
        </div>

        <div class="setting-row vocabulary-setting">
          <div class="setting-info">
            <div class="setting-label">
              {{ $t('globalVocabulary') }}
            </div>
            <div class="setting-description">
              {{ $t('globalVocabularyDesc') }}
            </div>
          </div>
        </div>

        <div class="vocabulary-container">
          <CustomVocabularyInput
            :session-words="globalVocabulary"
            :global-words="[]"
            :show-help="false"
            @add-word="addGlobalWord"
            @remove-word="removeGlobalWord"
          />
        </div>
      </div>

      <!-- Suisse Notes Pro: context prompt on device sync (mobile only) -->
      <div
        v-if="isMobileApp"
        class="settings-section"
      >
        <div class="section-title">
          {{ $t('settingsDeviceSyncTitle') }}
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">
              {{ $t('settingsAskOnDeviceSync') }}
            </div>
            <div class="setting-description">
              {{ $t('settingsAskOnDeviceSyncDesc') }}
            </div>
          </div>
          <q-toggle
            :model-value="prepStore.askOnDeviceSync"
            color="primary"
            @update:model-value="(v) => { prepStore.askOnDeviceSync = v; prepStore.saveSettings(); }"
          />
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">
              {{ $t('settingsDeviceSyncDefaultTemplate') }}
            </div>
          </div>
        </div>
        <q-select
          :model-value="prepStore.deviceSyncDefaultTemplateId"
          :options="prepTemplateOptions"
          emit-value
          map-options
          outlined
          dense
          class="device-sync-input"
          @update:model-value="(v) => { prepStore.deviceSyncDefaultTemplateId = v; prepStore.saveSettings(); }"
        />

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">
              {{ $t('settingsDeviceSyncDefaultContext') }}
            </div>
          </div>
        </div>
        <q-input
          :model-value="prepStore.deviceSyncDefaultContext"
          :placeholder="$t('prepContextHint')"
          type="textarea"
          autogrow
          outlined
          dense
          class="device-sync-input"
          :maxlength="20000"
          @update:model-value="(v) => { prepStore.deviceSyncDefaultContext = v; }"
          @blur="prepStore.saveSettings()"
        />
      </div>

      <!-- Delete Confirmation Dialog -->
      <q-dialog
        v-model="showDeleteConfirmation"
        persistent
      >
        <q-card class="delete-dialog">
          <q-card-section class="dialog-header">
            <q-icon
              name="warning"
              color="negative"
              size="48px"
            />
            <div class="dialog-title">
              {{ $t('deleteAllRecordingsTitle') }}
            </div>
          </q-card-section>

          <q-card-section class="dialog-content">
            <p><strong>{{ $t('actionIrreversible') }}</strong></p>
            <p>{{ $t('deleteAllRecordingsMessage', { count: recordingsCount }) }}</p>
            <p class="warning-text">
              {{ $t('deleteAllRecordingsWarning') }}
            </p>

            <div class="confirm-input">
              <p>{{ $t('typeDeleteToConfirm') }}</p>
              <q-input
                v-model="deleteConfirmText"
                outlined
                dense
                placeholder="DELETE"
                :error="deleteConfirmText.length > 0 && deleteConfirmText !== 'DELETE'"
              />
            </div>
          </q-card-section>

          <q-card-actions
            align="right"
            class="dialog-actions"
          >
            <q-btn
              v-close-popup
              flat
              :label="$t('cancel')"
              color="primary"
            />
            <q-btn
              flat
              :label="$t('deleteAllRecordings')"
              color="negative"
              :disable="deleteConfirmText !== 'DELETE'"
              :loading="isDeleting"
              @click="handleDeleteAll"
            />
          </q-card-actions>
        </q-card>
      </q-dialog>

      <!-- Delete Account Confirmation Dialog -->
      <q-dialog
        v-model="showDeleteAccountConfirmation"
        persistent
      >
        <q-card class="delete-dialog">
          <q-card-section class="dialog-header">
            <q-icon
              name="warning"
              color="negative"
              size="48px"
            />
            <div class="dialog-title">
              {{ $t('deleteAccountTitle') }}
            </div>
          </q-card-section>

          <q-card-section class="dialog-content">
            <p><strong>{{ $t('deleteAccountWarning') }}</strong></p>
            <p>{{ $t('deleteAccountMessage') }}</p>

            <div class="confirm-input">
              <p>{{ $t('deleteAccountConfirm') }}</p>
              <q-input
                v-model="deleteAccountConfirmText"
                outlined
                dense
                placeholder="DELETE"
                :error="deleteAccountConfirmText.length > 0 && deleteAccountConfirmText !== 'DELETE'"
              />
            </div>
          </q-card-section>

          <q-card-actions
            align="right"
            class="dialog-actions"
          >
            <q-btn
              v-close-popup
              flat
              :label="$t('cancel')"
              color="primary"
              @click="deleteAccountConfirmText = ''"
            />
            <q-btn
              flat
              :label="$t('deleteAccountButton')"
              color="negative"
              :disable="deleteAccountConfirmText !== 'DELETE'"
              :loading="isDeletingAccount"
              @click="handleDeleteAccount"
            />
          </q-card-actions>
        </q-card>
      </q-dialog>

      <!-- Danger Zone — destructive actions at the bottom -->
      <div
        v-if="authStore.isAuthenticated"
        class="settings-section danger-section"
      >
        <div class="section-title text-negative">
          {{ $t('dangerZone') }}
        </div>

        <div class="setting-row danger-zone">
          <div class="setting-info">
            <div class="setting-label danger-label">
              {{ $t('deleteAllRecordings') }}
            </div>
            <div class="setting-description">
              {{ $t('deleteAllRecordingsDesc') }}
            </div>
          </div>
          <q-btn
            flat
            color="negative"
            :label="$t('deleteAll')"
            icon="delete_forever"
            :loading="isDeleting"
            @click="showDeleteConfirmation = true"
          />
        </div>

        <div class="setting-row danger-zone">
          <div class="setting-info">
            <div class="setting-label danger-label">
              {{ $t('deleteAccount') }}
            </div>
            <div class="setting-description">
              {{ $t('deleteAccountWarning') }}
            </div>
          </div>
          <q-btn
            flat
            color="negative"
            :label="$t('deleteAccount')"
            icon="person_remove"
            :loading="isDeletingAccount"
            @click="showDeleteAccountConfirmation = true"
          />
        </div>
      </div>

      <!-- About Section -->
      <div class="settings-section">
        <div class="section-title">
          {{ $t('aboutSection') }}
        </div>

        <div class="setting-row">
          <div class="setting-label">
            {{ $t('appVersion') }}
          </div>
          <div class="setting-value">
            {{ appVersion }}
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            {{ $t('connectedServer') }}
          </div>
          <div class="setting-value">
            {{ configStore.apiUrl }}
          </div>
        </div>
      </div>

      <!-- Back Link -->
      <div class="back-section">
        <q-btn
          flat
          color="primary"
          :label="$t('backToRecording')"
          icon="arrow_back"
          to="/record"
        />
      </div>
    </div>
  </q-page>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { useConfigStore } from '../stores/config';
import { useAuthStore } from '../stores/auth';
import { useMinutesStore } from '../stores/minutes';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { useTranscriptionSettingsStore } from '../stores/transcription-settings';
import { useMeetingPrepStore } from '../stores/meeting-prep';
import { useDeviceStore } from '../stores/device';
import { useLanguage } from '../composables/useLanguage';
import { isCapacitor, isElectron } from '../utils/platform';
import CustomVocabularyInput from '../components/CustomVocabularyInput.vue';

const $q = useQuasar();
const { t } = useI18n();
const router = useRouter();
const configStore = useConfigStore();
const authStore = useAuthStore();
const minutesStore = useMinutesStore();
const historyStore = useRecordingsHistoryStore();
const transcriptionStore = useTranscriptionSettingsStore();
const prepStore = useMeetingPrepStore();
prepStore.initialize();
const prepTemplateOptions = computed(() => [
  { label: t('prepTemplateAuto'), value: null },
  ...prepStore.templates.map((tpl) => ({
    label: tpl.isBuiltIn ? `${tpl.name} · Suisse Meets` : tpl.name,
    value: tpl.id
  }))
]);
const { languages, currentLang, setLanguage, initLanguage } = useLanguage();
const deviceStore = useDeviceStore();
const isMobileApp = isCapacitor();

const appVersion = ref('1.0.0');
const userDataPath = ref('');
const storagePreference = ref('keep');

// Delete all recordings state
const showDeleteConfirmation = ref(false);
const deleteConfirmText = ref('');
const isDeleting = ref(false);

// Delete account state
const showDeleteAccountConfirmation = ref(false);
const deleteAccountConfirmText = ref('');
const isDeletingAccount = ref(false);

const recordingsCount = computed(() => historyStore.recordings.length);

const storageOptions = computed(() => [
  { value: 'keep', label: t('keepLocally') },
  { value: 'delete_after_upload', label: t('deleteAfterUpload') }
]);

const globalVocabulary = computed(() => transcriptionStore.globalVocabulary);

const addGlobalWord = (word) => {
  transcriptionStore.addGlobalWord(word);
};

const removeGlobalWord = (word) => {
  transcriptionStore.removeGlobalWord(word);
};

onMounted(async () => {
  initLanguage();

  // Get app info
  try {
    if (isElectron()) {
      appVersion.value = await window.electronAPI.app.getVersion();
      userDataPath.value = await window.electronAPI.app.getUserDataPath();
    } else if (isCapacitor()) {
      const { App: CapApp } = await import('@capacitor/app');
      const appInfo = await CapApp.getInfo();
      appVersion.value = appInfo.version || '1.0.0';
    }
  } catch (e) {
    console.warn('Could not get app info:', e);
  }

  // Load history store to get storage preference
  if (!historyStore.loaded) {
    await historyStore.loadRecordings();
  }
  storagePreference.value = historyStore.defaultStoragePreference;

  // Load transcription settings
  await transcriptionStore.loadGlobalSettings();

  // Initialize BLE device store on mobile
  if (isMobileApp) {
    try {
      await deviceStore.initialize();
    } catch (e) {
      console.warn('BLE initialization failed:', e);
    }
  }
});

const updateStoragePreference = async (value) => {
  await historyStore.setDefaultStoragePreference(value);
};

const handleDeleteAll = async () => {
  if (deleteConfirmText.value !== 'DELETE') return;

  isDeleting.value = true;
  try {
    const userId = authStore.user?.id;
    if (!userId) {
      $q.notify({
        type: 'negative',
        message: 'You must be logged in to delete recordings'
      });
      return;
    }

    let result;
    if (isElectron()) {
      result = await window.electronAPI.history.deleteAll(userId);
    } else {
      // Mobile: clear via history store
      await historyStore.deleteAll();
      result = { success: true, deletedCount: recordingsCount.value };
    }

    if (result.success) {
      // Reload the history store to reflect changes
      await historyStore.loadRecordings();

      showDeleteConfirmation.value = false;
      deleteConfirmText.value = '';

      $q.notify({
        type: 'positive',
        message: `Successfully deleted ${result.deletedCount} recording(s)`,
        icon: 'check_circle'
      });
    } else {
      $q.notify({
        type: 'negative',
        message: result.error || 'Failed to delete recordings'
      });
    }
  } catch (error) {
    console.error('Error deleting all recordings:', error);
    $q.notify({
      type: 'negative',
      message: 'An error occurred while deleting recordings'
    });
  } finally {
    isDeleting.value = false;
  }
};

const handleDeleteAccount = async () => {
  if (deleteAccountConfirmText.value !== 'DELETE') return;

  isDeletingAccount.value = true;
  try {
    const result = await authStore.deleteAccount();

    if (result.success) {
      showDeleteAccountConfirmation.value = false;
      deleteAccountConfirmText.value = '';

      $q.notify({
        type: 'positive',
        message: t('deleteAccountSuccess'),
        icon: 'check_circle'
      });

      router.push('/login');
    } else {
      $q.notify({
        type: 'negative',
        message: result.error || t('deleteAccountError')
      });
    }
  } catch (error) {
    console.error('Error deleting account:', error);
    $q.notify({
      type: 'negative',
      message: t('deleteAccountError')
    });
  } finally {
    isDeletingAccount.value = false;
  }
};

// ========== Device Methods ==========
const startDeviceScan = async () => {
  try {
    await deviceStore.startScan();
  } catch (e) {
    $q.notify({ type: 'warning', message: e.message });
  }
};

const pairDevice = async (device) => {
  try {
    await deviceStore.connectAndPair(device.deviceId);
    $q.notify({ type: 'positive', message: t('deviceConnected') });
  } catch (e) {
    $q.notify({ type: 'negative', message: t('pairingFailed'), caption: e.message, timeout: 5000 });
  }
};

const reconnectDevice = async () => {
  try {
    await deviceStore.autoConnect();
  } catch (e) {
    $q.notify({ type: 'negative', message: t('connectionFailed'), caption: e.message, timeout: 5000 });
  }
};

const disconnectDevice = async () => {
  await deviceStore.disconnect();
};

const confirmForgetDevice = () => {
  $q.dialog({
    title: t('forgetDeviceTitle'),
    message: t('forgetDeviceMessage'),
    cancel: { flat: true, label: t('cancel') },
    ok: { color: 'negative', label: t('forgetDevice'), flat: true }
  }).onOk(async () => {
    await deviceStore.forgetDevice();
  });
};

const handleLogout = async () => {
  await authStore.logout();
  router.push('/login');
};
</script>

<style lang="scss" scoped>
.settings-page {
  padding: 32px;
}

.settings-container {
  max-width: 800px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 32px;

  h1 {
    font-size: 28px;
    font-weight: 600;
    margin: 0 0 8px 0;
    color: #1e293b;
  }

  .text-subtitle {
    color: #64748b;
    font-size: 15px;
    margin: 0;
  }
}

.settings-section {
  background: white;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  padding: 24px;
  margin-bottom: 20px;

  .section-title {
    font-weight: 600;
    font-size: 18px;
    margin-bottom: 20px;
    color: #1e293b;
  }

  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 0;
    border-bottom: 1px solid #e2e8f0;

    &:last-child {
      border-bottom: none;
    }

    .setting-info {
      flex: 1;

      .setting-description {
        font-size: 13px;
        color: #94a3b8;
        margin-top: 4px;
      }
    }

    .setting-label {
      color: #64748b;
      font-size: 15px;
    }

    .setting-value {
      color: #1e293b;
      font-weight: 500;
      font-size: 15px;

      &.path-value {
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        word-break: break-all;
        text-align: right;
        max-width: 400px;
      }
    }
  }

  .section-actions {
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid #e2e8f0;
  }
}

.preference-select {
  min-width: 200px;

  :deep(.q-field--dense .q-field__control) {
    height: 44px;
  }

  :deep(.q-field__native) {
    font-size: 14px;
  }
}

.vocabulary-setting {
  border-bottom: none !important;
  padding-bottom: 8px !important;
}

.vocabulary-container {
  padding: 0 0 16px 0;
  border-bottom: 1px solid #e2e8f0;
}

.back-section {
  margin-top: 32px;
}

@media (max-width: 600px) {
  .settings-page {
    padding: 16px;
  }

  .page-header {
    margin-bottom: 20px;

    h1 {
      font-size: 22px;
    }
  }

  .settings-section {
    padding: 16px;

    .setting-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
  }

  .preference-select {
    min-width: unset;
    width: 100%;
  }

  .settings-section .setting-row.danger-zone {
    margin: 16px -16px -16px -16px;
    padding: 20px 16px;
  }
}

// ========== Device Settings ==========
.device-setting-card {
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 16px;
  background: #f8fafc;
}

.device-setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.device-setting-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, #6366F1, #8B5CF6);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.device-setting-info {
  flex: 1;
  min-width: 0;

  .device-setting-name {
    font-size: 15px;
    font-weight: 600;
    color: #1e293b;
  }

  .device-setting-status {
    font-size: 12px;
    color: #64748b;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
  }
}

.status-dot-small {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #94a3b8;
  display: inline-block;

  &.connected {
    background: #22c55e;
  }
}

.device-setting-actions {
  flex-shrink: 0;
}

.device-setting-footer {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e2e8f0;
  display: flex;
  justify-content: flex-end;
}

.scan-results-settings {
  margin-top: 16px;

  .scan-results-title {
    font-size: 13px;
    font-weight: 600;
    color: #64748b;
    margin-bottom: 8px;
  }
}

.scan-result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover, &:active {
    background: #f8fafc;
    border-color: #6366F1;
  }

  .scan-result-info {
    flex: 1;
    min-width: 0;

    .scan-result-name {
      font-size: 14px;
      font-weight: 500;
      color: #1e293b;
      display: block;
    }

    .scan-result-rssi {
      font-size: 11px;
      color: #94a3b8;
    }
  }
}

// Override Quasar select styling
:deep(.q-field--outlined .q-field__control) {
  border-radius: 8px;
}

// Danger zone styling
.settings-section .setting-row.account-danger-zone {
  margin: 0 -24px -24px -24px;
  border-top: 1px solid #fecaca;

  @media (max-width: 600px) {
    margin: 0 -16px -16px -16px;
  }
}

.settings-section .setting-row.danger-zone {
  border-top: 1px solid #fecaca;
  border-bottom: none;
  background: #fef2f2;
  margin: 16px -24px -24px -24px;
  padding: 20px 24px;
  border-radius: 0 0 12px 12px;

  .danger-label {
    color: #dc2626;
    font-weight: 500;
  }
}

// Danger section: multiple danger rows stacked
.danger-section .setting-row.danger-zone {
  margin: 0 -24px;
  border-radius: 0;

  &:first-of-type {
    margin-top: 8px;
  }
  &:last-of-type {
    margin-bottom: -24px;
    border-radius: 0 0 12px 12px;
  }

  @media (max-width: 600px) {
    margin: 0 -16px;
    &:last-of-type {
      margin-bottom: -16px;
    }
  }
}

// Delete confirmation dialog
.delete-dialog {
  min-width: 400px;
  max-width: 500px;

  @media (max-width: 600px) {
    min-width: unset;
    max-width: calc(100vw - 32px);
  }

  .dialog-header {
    text-align: center;
    padding-bottom: 8px;

    .dialog-title {
      font-size: 20px;
      font-weight: 600;
      margin-top: 16px;
      color: #1e293b;
    }
  }

  .dialog-content {
    p {
      margin-bottom: 12px;
      color: #475569;
    }

    .warning-text {
      background: #f0fdf4;
      border: 1px solid #86efac;
      border-radius: 8px;
      padding: 12px;
      font-size: 13px;
      color: #166534;
    }

    .confirm-input {
      margin-top: 20px;

      p {
        margin-bottom: 8px;
        font-size: 14px;
      }
    }
  }

  .dialog-actions {
    padding: 16px 24px;
    border-top: 1px solid #e2e8f0;
  }
}
</style>
