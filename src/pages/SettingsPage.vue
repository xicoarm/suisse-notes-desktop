<template>
  <q-page class="settings-page">
    <div class="settings-container">
      <div class="page-header">
        <h1>Settings</h1>
        <p class="text-subtitle">
          Manage your app preferences
        </p>
      </div>

      <!-- Account Section -->
      <div
        v-if="authStore.isAuthenticated"
        class="settings-section"
      >
        <div class="section-title">
          Account
        </div>

        <div class="setting-row">
          <div class="setting-label">
            Signed in as
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
            Name
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
            Organization
          </div>
          <div class="setting-value">
            {{ authStore.user.organizationName }}
          </div>
        </div>

        <div class="section-actions">
          <q-btn
            flat
            color="negative"
            label="Sign Out"
            icon="logout"
            class="btn-danger"
            @click="handleLogout"
          />
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
          Storage
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">
              Default storage preference
            </div>
            <div class="setting-description">
              Choose what happens to recordings after upload
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
            Data location
          </div>
          <div class="setting-value path-value">
            {{ userDataPath }}
          </div>
        </div>

        <div class="setting-row danger-zone">
          <div class="setting-info">
            <div class="setting-label danger-label">
              Delete all recordings
            </div>
            <div class="setting-description">
              Permanently delete all local recordings. This cannot be undone.
            </div>
          </div>
          <q-btn
            flat
            color="negative"
            label="Delete All"
            icon="delete_forever"
            :loading="isDeleting"
            @click="showDeleteConfirmation = true"
          />
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
              Delete All Recordings?
            </div>
          </q-card-section>

          <q-card-section class="dialog-content">
            <p><strong>This action is irreversible.</strong></p>
            <p>All {{ recordingsCount }} local recording(s) will be permanently deleted from this device.</p>
            <p class="warning-text">
              Recordings that have been uploaded to Suisse Notes will still be available in the web app.
            </p>

            <div class="confirm-input">
              <p>Type <strong>DELETE</strong> to confirm:</p>
              <q-input
                v-model="deleteConfirmText"
                outlined
                dense
                placeholder="Type DELETE"
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
              label="Cancel"
              color="primary"
            />
            <q-btn
              flat
              label="Delete All Recordings"
              color="negative"
              :disable="deleteConfirmText !== 'DELETE'"
              :loading="isDeleting"
              @click="handleDeleteAll"
            />
          </q-card-actions>
        </q-card>
      </q-dialog>

      <!-- About Section -->
      <div class="settings-section">
        <div class="section-title">
          About
        </div>

        <div class="setting-row">
          <div class="setting-label">
            App version
          </div>
          <div class="setting-value">
            {{ appVersion }}
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label">
            Connected server
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
          label="Back to Recording"
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
import { useConfigStore } from '../stores/config';
import { useAuthStore } from '../stores/auth';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { useTranscriptionSettingsStore } from '../stores/transcription-settings';
import { useLanguage } from '../composables/useLanguage';
import CustomVocabularyInput from '../components/CustomVocabularyInput.vue';

const $q = useQuasar();
const router = useRouter();
const configStore = useConfigStore();
const authStore = useAuthStore();
const historyStore = useRecordingsHistoryStore();
const transcriptionStore = useTranscriptionSettingsStore();
const { languages, currentLang, setLanguage, initLanguage } = useLanguage();

const appVersion = ref('1.0.0');
const userDataPath = ref('');
const storagePreference = ref('keep');

// Delete all recordings state
const showDeleteConfirmation = ref(false);
const deleteConfirmText = ref('');
const isDeleting = ref(false);

const recordingsCount = computed(() => historyStore.recordings.length);

const storageOptions = [
  { value: 'keep', label: 'Keep locally' },
  { value: 'delete_after_upload', label: 'Delete after upload' }
];

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
    appVersion.value = await window.electronAPI.app.getVersion();
    userDataPath.value = await window.electronAPI.app.getUserDataPath();
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

    const result = await window.electronAPI.history.deleteAll(userId);

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

// Override Quasar select styling
:deep(.q-field--outlined .q-field__control) {
  border-radius: 8px;
}

// Danger zone styling
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
