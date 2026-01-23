<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="modern-header">
      <q-toolbar class="header-toolbar">
        <!-- Left Section: Brand Logo -->
        <div class="header-left">
          <div
            class="brand-logo"
            @click="goTo('/about')"
          >
            <div class="logo-icon">
              <q-icon
                name="mic"
                size="18px"
              />
            </div>
            <span class="logo-text">Suisse Notes</span>
          </div>

          <!-- Global Upload Progress Indicator -->
          <div
            v-if="recordingStore.hasActiveUpload"
            class="upload-indicator"
            @click="goTo('/record')"
          >
            <q-spinner-dots
              size="12px"
              color="primary"
            />
            <span>{{ Math.min(recordingStore.activeUploadProgress, 99) }}%</span>
          </div>
        </div>

        <!-- Center Section: Pill Navigation -->
        <div class="header-center">
          <nav
            v-if="authStore.isAuthenticated"
            class="pill-nav"
          >
            <button
              :class="['nav-pill', { active: currentTab === 'about' }]"
              @click="goTo('/about')"
            >
              <q-icon
                name="home"
                size="16px"
              />
              <span>{{ $t('home') }}</span>
            </button>
            <button
              :class="['nav-pill', { active: currentTab === 'record' || currentTab === 'upload' }]"
              @click="goTo('/record')"
            >
              <q-icon
                name="mic"
                size="16px"
              />
              <span>{{ $t('record') }}</span>
            </button>
            <button
              :class="['nav-pill', { active: currentTab === 'history' }]"
              @click="goTo('/history')"
            >
              <q-icon
                name="history"
                size="16px"
              />
              <span>{{ $t('history') }}</span>
            </button>
          </nav>
        </div>

        <!-- Right Section: Language + User Menu -->
        <div class="header-right">
          <template v-if="authStore.isAuthenticated">
            <!-- Language Switcher - Compact Dropdown -->
            <q-btn-dropdown
              flat
              no-caps
              dense
              class="lang-dropdown"
              dropdown-icon="none"
            >
              <template #label>
                <div class="lang-current">
                  <q-icon
                    name="language"
                    size="14px"
                  />
                  <span>{{ currentLangShort }}</span>
                  <q-icon
                    name="expand_more"
                    size="14px"
                    class="expand-icon"
                  />
                </div>
              </template>

              <q-list class="lang-list">
                <q-item
                  v-for="lang in languages"
                  :key="lang.value"
                  v-close-popup
                  clickable
                  :class="{ 'lang-active': currentLang === lang.value }"
                  @click="setLanguage(lang.value)"
                >
                  <q-item-section>
                    <div class="lang-option">
                      <span class="lang-short">{{ lang.short }}</span>
                      <span class="lang-label">{{ lang.label }}</span>
                    </div>
                  </q-item-section>
                  <q-item-section
                    v-if="currentLang === lang.value"
                    side
                  >
                    <q-icon
                      name="check"
                      size="16px"
                      color="primary"
                    />
                  </q-item-section>
                </q-item>
              </q-list>
            </q-btn-dropdown>

            <!-- User Menu -->
            <q-btn-dropdown
              flat
              no-caps
              class="user-menu"
              dropdown-icon="none"
            >
              <template #label>
                <div class="user-avatar">
                  <q-icon
                    name="person"
                    size="16px"
                  />
                </div>
              </template>

              <q-list class="user-dropdown">
                <q-item-label
                  header
                  class="user-header"
                >
                  <span class="user-email">{{ authStore.user?.email }}</span>
                </q-item-label>

                <q-separator />

                <q-item
                  v-close-popup
                  clickable
                  @click="goTo('/settings')"
                >
                  <q-item-section avatar>
                    <q-icon
                      name="settings"
                      size="18px"
                      color="grey-7"
                    />
                  </q-item-section>
                  <q-item-section>{{ $t('settings') }}</q-item-section>
                </q-item>

                <q-item
                  v-close-popup
                  clickable
                  @click="toggleMaximize"
                >
                  <q-item-section avatar>
                    <q-icon
                      :name="isMaximized ? 'fullscreen_exit' : 'fullscreen'"
                      size="18px"
                      color="grey-7"
                    />
                  </q-item-section>
                  <q-item-section>{{ isMaximized ? $t('restore') : $t('maximize') }}</q-item-section>
                </q-item>

                <q-separator />

                <q-item
                  v-close-popup
                  clickable
                  @click="handleLogout"
                >
                  <q-item-section avatar>
                    <q-icon
                      name="logout"
                      size="18px"
                      color="negative"
                    />
                  </q-item-section>
                  <q-item-section class="text-negative">
                    {{ $t('signOut') }}
                  </q-item-section>
                </q-item>
              </q-list>
            </q-btn-dropdown>
          </template>
        </div>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <router-view />
    </q-page-container>

    <q-footer class="app-footer">
      <div class="footer-content">
        <span>© 2026</span>
        <a
          href="https://suisse-ai.ch"
          target="_blank"
          rel="noopener"
          class="footer-link"
        >Suisse AI Group GmbH</a>
        <span class="footer-separator">·</span>
        <span class="footer-address">Kirchstrasse 3, 8304 Wallisellen, Schweiz</span>
      </div>
    </q-footer>
  </q-layout>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
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
  { label: 'English', short: 'EN', value: 'en' },
  { label: 'Deutsch', short: 'DE', value: 'de' },
  { label: 'Français', short: 'FR', value: 'fr' },
  { label: 'Italiano', short: 'IT', value: 'it' }
];

const currentLang = ref(localStorage.getItem('lang') || 'de');

const currentLangShort = computed(() => {
  const lang = languages.find(l => l.value === currentLang.value);
  return lang ? lang.short : 'DE';
});

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
  } else if (path.includes('/upload')) {
    currentTab.value = 'upload';
  } else if (path.includes('/about')) {
    currentTab.value = 'about';
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
.modern-header {
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.header-toolbar {
  min-height: 56px;
  padding: 0 24px;
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
  flex: 2;
}

.header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex: 1;
}

// Brand Logo
.brand-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 6px 10px;
  margin: -6px -10px;
  border-radius: 10px;
  transition: background 0.2s ease;

  &:hover {
    background: rgba(99, 102, 241, 0.08);
  }

  .logo-icon {
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
  }

  .logo-text {
    font-weight: 600;
    font-size: 15px;
    color: #1e293b;
    letter-spacing: -0.3px;
  }
}

// Pill Navigation
.pill-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #f1f5f9;
  padding: 4px;
  border-radius: 12px;
}

.nav-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  color: #64748b;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover:not(.active) {
    color: #475569;
    background: rgba(255, 255, 255, 0.6);
  }

  &.active {
    background: white;
    color: #6366F1;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }

  .q-icon {
    opacity: 0.85;
  }
}

// Language Dropdown
.lang-dropdown {
  padding: 0;
  min-height: auto;

  :deep(.q-btn__content) {
    padding: 0;
  }
}

.lang-current {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: #f1f5f9;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  transition: all 0.2s ease;

  &:hover {
    background: #e2e8f0;
    color: #475569;
  }

  .expand-icon {
    margin-left: 2px;
    opacity: 0.6;
  }
}

.lang-list {
  min-width: 160px;
  padding: 6px;

  :deep(.q-item) {
    min-height: 36px;
    padding: 8px 12px;
    border-radius: 6px;
    margin-bottom: 2px;

    &:last-child {
      margin-bottom: 0;
    }

    &:hover {
      background: #f8fafc;
    }

    &.lang-active {
      background: rgba(99, 102, 241, 0.08);
    }
  }
}

.lang-option {
  display: flex;
  align-items: center;
  gap: 10px;

  .lang-short {
    font-size: 11px;
    font-weight: 700;
    color: #6366F1;
    min-width: 22px;
  }

  .lang-label {
    font-size: 13px;
    color: #475569;
  }
}

// User Menu
.user-menu {
  padding: 0;
  min-height: auto;

  :deep(.q-btn__content) {
    padding: 0;
  }
}

.user-avatar {
  width: 36px;
  height: 36px;
  background: linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6366F1;
  transition: all 0.2s ease;

  &:hover {
    background: linear-gradient(135deg, #c7d2fe 0%, #a5b4fc 100%);
  }
}

.user-dropdown {
  min-width: 200px;
  padding: 8px 0;

  .user-header {
    padding: 12px 16px;
  }

  .user-email {
    font-size: 13px;
    font-weight: 500;
    color: #1e293b;
  }

  :deep(.q-item) {
    min-height: 40px;
    padding: 8px 16px;

    &:hover {
      background: #f8fafc;
    }
  }

  :deep(.q-item__section--avatar) {
    min-width: 32px;
  }
}

// Upload Indicator
.upload-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.1) 100%);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  color: #6366F1;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(139, 92, 246, 0.15) 100%);
  }
}

// Footer
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
