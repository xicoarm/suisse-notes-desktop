<template>
  <q-page class="settings-page">
    <div class="settings-container">
      <div class="page-header">
        <h1>Settings</h1>
        <p class="text-subtitle">Manage your app preferences</p>
      </div>

      <!-- Account Section -->
      <div class="settings-section" v-if="authStore.isAuthenticated">
        <div class="section-title">Account</div>

        <div class="setting-row">
          <div class="setting-label">Signed in as</div>
          <div class="setting-value">{{ authStore.user?.email }}</div>
        </div>

        <div class="setting-row" v-if="authStore.user?.name">
          <div class="setting-label">Name</div>
          <div class="setting-value">{{ authStore.user?.name }}</div>
        </div>

        <div class="setting-row" v-if="authStore.user?.organizationName">
          <div class="setting-label">Organization</div>
          <div class="setting-value">{{ authStore.user.organizationName }}</div>
        </div>

        <div class="section-actions">
          <q-btn
            flat
            color="negative"
            label="Sign Out"
            icon="logout"
            @click="handleLogout"
            class="btn-danger"
          />
        </div>
      </div>

      <!-- Storage Preferences Section -->
      <div class="settings-section">
        <div class="section-title">Storage</div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Default storage preference</div>
            <div class="setting-description">Choose what happens to recordings after upload</div>
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
          <div class="setting-label">Data location</div>
          <div class="setting-value path-value">{{ userDataPath }}</div>
        </div>
      </div>

      <!-- About Section -->
      <div class="settings-section">
        <div class="section-title">About</div>

        <div class="setting-row">
          <div class="setting-label">App version</div>
          <div class="setting-value">{{ appVersion }}</div>
        </div>

        <div class="setting-row">
          <div class="setting-label">Connected server</div>
          <div class="setting-value">{{ configStore.apiUrl }}</div>
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
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useConfigStore } from '../stores/config';
import { useAuthStore } from '../stores/auth';
import { useRecordingsHistoryStore } from '../stores/recordings-history';

const router = useRouter();
const configStore = useConfigStore();
const authStore = useAuthStore();
const historyStore = useRecordingsHistoryStore();

const appVersion = ref('1.0.0');
const userDataPath = ref('');
const storagePreference = ref('keep');

const storageOptions = [
  { value: 'keep', label: 'Keep locally' },
  { value: 'delete_after_upload', label: 'Delete after upload' }
];

onMounted(async () => {
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
});

const updateStoragePreference = async (value) => {
  await historyStore.setDefaultStoragePreference(value);
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

.back-section {
  margin-top: 32px;
}

// Override Quasar select styling
:deep(.q-field--outlined .q-field__control) {
  border-radius: 8px;
}
</style>
