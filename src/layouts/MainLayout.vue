<template>
  <q-layout view="hHh lpR fFf">
    <q-header elevated class="gradient-header">
      <q-toolbar class="compact-toolbar">
        <!-- Left Section: Brand Logo -->
        <div class="header-left">
          <div class="brand-logo">
            <q-icon name="mic" size="sm" />
            <span>Suisse Notes</span>
          </div>
          <!-- Global Upload Progress Indicator -->
          <div class="upload-indicator" v-if="recordingStore.hasActiveUpload" @click="goTo('/record')">
            <q-spinner-dots size="14px" color="white" />
            <span>Uploading {{ Math.min(recordingStore.activeUploadProgress, 99) }}%</span>
          </div>
        </div>

        <!-- Center Section: Navigation Tabs -->
        <div class="header-center">
          <q-tabs
            v-if="authStore.isAuthenticated"
            v-model="currentTab"
            class="nav-tabs"
            shrink
            dense
            indicator-color="white"
          >
            <q-tab name="record" icon="mic" :label="$t('record')" @click="goTo('/record')" />
            <q-tab name="history" icon="history" :label="$t('history')" @click="goTo('/history')" />
          </q-tabs>
        </div>

        <!-- Right Section: Action Buttons -->
        <div class="header-right" v-if="authStore.isAuthenticated">
          <!-- Language Switcher -->
          <q-btn-dropdown
            flat
            dense
            no-caps
            class="lang-dropdown"
            :label="currentLang.toUpperCase()"
          >
            <q-list dense>
              <q-item
                v-for="lang in languages"
                :key="lang.value"
                clickable
                v-close-popup
                @click="setLanguage(lang.value)"
                :active="currentLang === lang.value"
              >
                <q-item-section>
                  <q-item-label>{{ lang.label }}</q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </q-btn-dropdown>

          <q-btn
            flat
            round
            dense
            :icon="isMaximized ? 'fullscreen_exit' : 'fullscreen'"
            size="sm"
            @click="toggleMaximize"
          >
            <q-tooltip>{{ isMaximized ? $t('restore') : $t('maximize') }}</q-tooltip>
          </q-btn>

          <q-btn
            flat
            round
            dense
            icon="settings"
            size="sm"
            @click="goTo('/settings')"
          >
            <q-tooltip>{{ $t('settings') }}</q-tooltip>
          </q-btn>

          <q-btn
            flat
            round
            dense
            icon="logout"
            size="sm"
            @click="handleLogout"
          >
            <q-tooltip>{{ $t('signOut') }}</q-tooltip>
          </q-btn>
        </div>
        <div class="header-right" v-else></div>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <router-view />
    </q-page-container>

    <q-footer class="app-footer">
      <div class="footer-content">
        <span>Powered by</span>
        <a href="https://suisse-ai.ch" target="_blank" rel="noopener" class="footer-link">Suisse AI Group GmbH</a>
        <span class="footer-separator">·</span>
        <span class="footer-address">Kirchstrasse 3, 8304 Wallisellen, Schweiz</span>
      </div>
    </q-footer>
  </q-layout>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { useRecordingStore } from '../stores/recording';
import { useRouter, useRoute } from 'vue-router';

const { locale } = useI18n();
const authStore = useAuthStore();
const recordingStore = useRecordingStore();
const router = useRouter();
const route = useRoute();

const currentTab = ref('record');
const isMaximized = ref(false);

// Language switcher
const languages = [
  { label: 'English', value: 'en' },
  { label: 'Deutsch', value: 'de' },
  { label: 'Français', value: 'fr' },
  { label: 'Italiano', value: 'it' }
];

const currentLang = ref(localStorage.getItem('lang') || 'de');

const setLanguage = (lang) => {
  currentLang.value = lang;
  locale.value = lang;
  localStorage.setItem('lang', lang);
};

// Load saved language on mount
onMounted(() => {
  const savedLang = localStorage.getItem('lang');
  if (savedLang) {
    locale.value = savedLang;
    currentLang.value = savedLang;
  }
});

// Check initial maximize state
const checkMaximizeState = async () => {
  if (window.electronAPI?.window) {
    isMaximized.value = await window.electronAPI.window.isMaximized();
  }
};

const toggleMaximize = async () => {
  if (window.electronAPI?.window) {
    const result = await window.electronAPI.window.toggleMaximize();
    isMaximized.value = result.isMaximized;
  }
};

// Sync tab with current route
watch(() => route.path, (path) => {
  if (path.includes('/history')) {
    currentTab.value = 'history';
  } else if (path.includes('/record')) {
    currentTab.value = 'record';
  }
}, { immediate: true });

const goTo = (path) => {
  router.push(path);
};

const handleLogout = async () => {
  await authStore.logout();
  router.push('/login');
};

// Global upload progress listeners (persist across page navigation)
onMounted(() => {
  checkMaximizeState();

  window.electronAPI.upload.onProgress((data) => {
    // Update current upload
    if (data.recordId === recordingStore.recordId) {
      recordingStore.updateUploadProgress(data.progress, data.bytesUploaded, data.bytesTotal);
    }
    // Update background upload
    if (recordingStore.backgroundUpload.active && data.recordId === recordingStore.backgroundUpload.recordId) {
      recordingStore.updateBackgroundUploadProgress(data.recordId, data.progress, data.bytesUploaded, data.bytesTotal);
    }
  });
});

onUnmounted(() => {
  window.electronAPI.upload.removeAllListeners();
});
</script>

<style lang="scss" scoped>
.gradient-header {
  background: linear-gradient(90deg, #6366F1 0%, #8B5CF6 100%);
}

.compact-toolbar {
  min-height: 48px;
  padding: 0 32px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 1;
}

.header-center {
  display: flex;
  justify-content: center;
  flex: 1;
}

.header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex: 1;
}

.brand-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
  color: white;
}

.nav-tabs {
  :deep(.q-tab) {
    text-transform: none;
    font-weight: 500;
    letter-spacing: 0;
    min-width: 80px;
    padding: 0 14px;
    font-size: 12px;
  }

  :deep(.q-tab__icon) {
    font-size: 16px;
  }
}


.lang-dropdown {
  font-size: 11px;
  font-weight: 600;
  min-height: 32px;
  padding: 0 10px;

  :deep(.q-btn__content) {
    color: white;
  }

  :deep(.q-icon) {
    color: white;
  }
}

.upload-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 14px;
  font-size: 11px;
  color: white;
  cursor: pointer;
  transition: background 0.2s;

  &:hover {
    background: rgba(255, 255, 255, 0.3);
  }
}

.app-footer {
  background: #f8fafc;
  border-top: 1px solid #e2e8f0;
  padding: 12px 40px;
}

.footer-content {
  text-align: center;
  font-size: 11px;
  color: #64748b;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.footer-link {
  color: #6366F1;
  text-decoration: none;
  font-weight: 500;
  transition: color 0.2s;

  &:hover {
    color: #4f46e5;
    text-decoration: underline;
  }
}

.footer-separator {
  margin: 0 10px;
  color: #cbd5e1;
}

.footer-address {
  color: #94a3b8;
}
</style>
