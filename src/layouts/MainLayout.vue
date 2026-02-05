<template>
  <q-layout view="hHh lpR fFf">
    <!-- Unauthenticated Header: Desktop only (mobile login/register pages handle their own layout) -->
    <q-header
      v-if="!authStore.isAuthenticated && !isMobile()"
      class="modern-header unauth-header"
    >
      <q-toolbar class="header-toolbar">
        <!-- Left: Brand Logo -->
        <div class="header-left">
          <div
            class="brand-logo"
            @click="goTo('/about')"
          >
            <img
              src="../assets/logo.png"
              alt="Suisse Notes"
              class="logo-image"
            >
            <span class="logo-text">Suisse Notes</span>
          </div>
        </div>

        <!-- Right: Language + Auth Buttons -->
        <div class="header-right">
          <!-- Language Switcher -->
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

          <!-- Sign In Button (hidden on /login) -->
          <q-btn
            v-if="route.name !== 'login'"
            flat
            no-caps
            class="auth-btn signin-btn"
            @click="goTo('/login')"
          >
            {{ $t('signIn') }}
          </q-btn>

          <!-- Register Button (hidden on /register) -->
          <q-btn
            v-if="route.name !== 'register'"
            unelevated
            no-caps
            class="auth-btn register-btn"
            @click="goTo('/register')"
          >
            {{ $t('createAccount') }}
          </q-btn>
        </div>
      </q-toolbar>
    </q-header>

    <!-- Desktop Header: Only show when authenticated AND on desktop (mobile uses bottom nav only) -->
    <q-header
      v-if="authStore.isAuthenticated && !isMobile()"
      class="modern-header"
    >
      <q-toolbar class="header-toolbar">
        <!-- Left Section: Brand Logo -->
        <div class="header-left">
          <div
            class="brand-logo"
            @click="goTo('/about')"
          >
            <img
              src="../assets/logo.png"
              alt="Suisse Notes"
              class="logo-image"
            >
            <span class="logo-text">Suisse Notes</span>
          </div>

          <!-- Global Recording Indicator -->
          <div
            v-if="recordingStore.isRecording || recordingStore.isPaused"
            class="recording-indicator"
            @click="goTo('/record')"
          >
            <span
              class="recording-dot"
              :class="{ paused: recordingStore.isPaused }"
            />
            <span>{{ recordingStore.formattedDuration }}</span>
          </div>

          <!-- Global Upload Progress Indicator -->
          <div
            v-if="recordingStore.hasActiveUpload && !recordingStore.isRecording && !recordingStore.isPaused"
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

        <!-- Center Section: Pill Navigation (hidden on mobile) -->
        <div class="header-center">
          <nav
            v-if="authStore.isAuthenticated && !isMobile()"
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
            <!-- Trial Credits / Minutes Display -->
            <div
              v-if="!minutesStore.loading"
              class="minutes-chip"
              :class="{ 'low-minutes': minutesStore.remainingMinutes <= 10, 'no-minutes': minutesStore.remainingMinutes <= 0 }"
              @click="goTo('/record')"
            >
              <q-icon
                name="schedule"
                size="14px"
              />
              <span class="minutes-value">{{ formattedRemainingTime }}</span>
            </div>

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

                <!-- Only show maximize option on desktop -->
                <q-item
                  v-if="isElectron()"
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

                <q-separator v-if="isElectron()" />

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

    <!-- Mobile Recording Indicator (floating) -->
    <div
      v-if="isMobile() && authStore.isAuthenticated && (recordingStore.isRecording || recordingStore.isPaused)"
      class="mobile-recording-indicator"
      @click="goTo('/record')"
    >
      <span
        class="recording-dot"
        :class="{ paused: recordingStore.isPaused }"
      />
      <span>{{ recordingStore.formattedDuration }}</span>
    </div>

    <!-- Mobile Minutes Indicator (floating, only when not recording) -->
    <div
      v-if="isMobile() && authStore.isAuthenticated && !recordingStore.isRecording && !recordingStore.isPaused && !minutesStore.loading"
      class="mobile-minutes-indicator"
      :class="{ 'low-minutes': minutesStore.remainingMinutes <= 10, 'no-minutes': minutesStore.remainingMinutes <= 0 }"
      @click="goTo('/record')"
    >
      <q-icon
        name="schedule"
        size="14px"
      />
      <span>{{ formattedRemainingTime }}</span>
    </div>

    <q-page-container :class="{ 'mobile-safe-top': isMobile() && authStore.isAuthenticated }">
      <router-view />
    </q-page-container>

    <!-- Desktop Footer (hidden on mobile) -->
    <q-footer
      v-if="!isMobile()"
      class="app-footer"
    >
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

    <!-- Mobile Bottom Navigation -->
    <q-footer
      v-if="isMobile() && authStore.isAuthenticated"
      class="mobile-bottom-nav"
    >
      <q-tabs
        v-model="currentTab"
        class="mobile-nav-tabs"
        switch-indicator
      >
        <q-tab
          name="about"
          icon="home"
          :label="$t('home')"
          @click="goTo('/about')"
        />
        <q-tab
          name="record"
          icon="mic"
          :label="$t('record')"
          @click="goTo('/record')"
        />
        <q-tab
          name="history"
          icon="history"
          :label="$t('history')"
          @click="goTo('/history')"
        />
        <q-tab
          name="settings"
          icon="settings"
          :label="$t('settings')"
          @click="goTo('/settings')"
        />
      </q-tabs>
    </q-footer>
  </q-layout>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useQuasar } from 'quasar';
import { useAuthStore } from '../stores/auth';
import { useRecordingStore } from '../stores/recording';
import { useMinutesStore } from '../stores/minutes';
import { useRouter, useRoute } from 'vue-router';
import { isElectron, isMobile } from '../utils/platform';
import { useLanguage } from '../composables/useLanguage';

const $q = useQuasar();
const authStore = useAuthStore();
const recordingStore = useRecordingStore();
const minutesStore = useMinutesStore();
const router = useRouter();
const route = useRoute();

const { languages, currentLang, currentLangShort, setLanguage, initLanguage } = useLanguage();

const currentTab = ref('record');
const isMaximized = ref(false);

// Formatted remaining time for display - simple "X Min." format
const formattedRemainingTime = computed(() => {
  const totalMinutes = minutesStore.remainingMinutes;

  if (totalMinutes <= 0) {
    return '0 Min.';
  }

  return `${Math.round(totalMinutes)} Min.`;
});

// Load saved language on mount
onMounted(() => {
  initLanguage();
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
  } else if (path.includes('/settings')) {
    currentTab.value = 'settings';
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

  // Set up upload listeners (Electron only)
  if (isElectron() && window.electronAPI?.upload) {
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
  }

  // Set up auth expired listener (Electron only) - Auto-logout on expiration
  if (isElectron() && window.electronAPI?.auth?.onExpired) {
    window.electronAPI.auth.onExpired(async (data) => {
      console.warn('Auth expired, auto-logging out:', data);

      // Check if recording is in progress - warn but still need to logout
      const hasActiveRecording = recordingStore.isRecording || recordingStore.isPaused;

      if (hasActiveRecording) {
        // Recording is active - show warning but recording is saved locally
        $q.notify({
          type: 'warning',
          message: 'Session expired. Your recording is saved locally and can be uploaded after logging in again.',
          timeout: 8000
        });
      }

      // Auto-logout and redirect to login
      await authStore.forceLogout(data.message || 'Your session has expired.');
      router.push('/login');
    });
  }

  // Listen for forceLogout events from auth store
  window.addEventListener('auth:forceLogout', handleForceLogout);
});

// Handler for force logout - defined outside onMounted so it's accessible in onUnmounted
const handleForceLogout = async (event) => {
  console.warn('Force logout triggered:', event.detail?.message);
  router.push('/login');
};

onUnmounted(() => {
  if (isElectron() && window.electronAPI?.upload?.removeAllListeners) {
    window.electronAPI.upload.removeAllListeners();
  }
  if (isElectron() && window.electronAPI?.auth?.removeExpiredListener) {
    window.electronAPI.auth.removeExpiredListener();
  }
  window.removeEventListener('auth:forceLogout', handleForceLogout);
});
</script>

<style lang="scss" scoped>
.modern-header {
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(226, 232, 240, 0.8);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  // Safe area padding for mobile status bar (desktop header)
  padding-top: env(safe-area-inset-top, 0);
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

  .logo-image {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    object-fit: contain;
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

// Minutes Chip
.minutes-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.15);
  border-radius: 8px;
  font-size: 12px;
  color: #6366F1;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    background: rgba(99, 102, 241, 0.12);
  }

  .minutes-value {
    font-weight: 600;
  }

  &.low-minutes {
    background: rgba(245, 158, 11, 0.1);
    border-color: rgba(245, 158, 11, 0.3);
    color: #d97706;
  }

  &.no-minutes {
    background: rgba(239, 68, 68, 0.1);
    border-color: rgba(239, 68, 68, 0.3);
    color: #dc2626;
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

// Recording Indicator
.recording-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #ef4444;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: rgba(239, 68, 68, 0.15);
  }

  .recording-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ef4444;
    animation: pulse-recording 1.5s ease-in-out infinite;

    &.paused {
      background: #f59e0b;
      animation: none;
    }
  }
}

@keyframes pulse-recording {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(0.85);
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

// Unauthenticated header auth buttons
.unauth-header {
  .auth-btn {
    font-size: 13px;
    font-weight: 600;
    padding: 6px 16px;
    border-radius: 8px;
  }

  .signin-btn {
    color: #475569;

    &:hover {
      background: rgba(99, 102, 241, 0.08);
      color: #6366F1;
    }
  }

  .register-btn {
    background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
    color: white;

    &:hover {
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
    }
  }
}

// Mobile header adjustments
@media (max-width: 600px) {
  .header-toolbar {
    min-height: 48px;
    padding: 0 12px;
  }

  .logo-text {
    display: none; // Icon only on mobile
  }

  .lang-current span {
    display: none; // Icon only
  }

  .expand-icon {
    display: none;
  }

  .header-left {
    gap: 8px;
  }

  .header-right {
    gap: 8px;
  }

  .upload-indicator {
    padding: 4px 8px;
    font-size: 11px;
  }

  .minutes-chip {
    padding: 4px 8px;
  }

  .unauth-header {
    .auth-btn {
      font-size: 12px;
      padding: 4px 10px;
    }
  }
}

// Mobile Recording Indicator (floating)
.mobile-recording-indicator {
  position: fixed;
  top: env(safe-area-inset-top, 8px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: rgba(239, 68, 68, 0.95);
  border-radius: 20px;
  font-size: 14px;
  font-weight: 600;
  color: white;
  cursor: pointer;
  z-index: 9999;
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);

  .recording-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: white;
    animation: pulse-recording 1.5s ease-in-out infinite;

    &.paused {
      background: #fcd34d;
      animation: none;
    }
  }
}

// Mobile Minutes Indicator
.mobile-minutes-indicator {
  position: fixed;
  top: calc(env(safe-area-inset-top, 8px) + 8px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  color: #6366F1;
  cursor: pointer;
  z-index: 9998;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);

  &.low-minutes {
    background: rgba(255, 251, 235, 0.95);
    border-color: rgba(245, 158, 11, 0.3);
    color: #d97706;
  }

  &.no-minutes {
    background: rgba(254, 242, 242, 0.95);
    border-color: rgba(239, 68, 68, 0.3);
    color: #dc2626;
  }
}

// Mobile safe area top padding (when no header is rendered on mobile)
.mobile-safe-top {
  padding-top: env(safe-area-inset-top, 0) !important;
}

// Mobile bottom navigation
.mobile-bottom-nav {
  background: white;
  border-top: 1px solid #e2e8f0;

  .mobile-nav-tabs {
    :deep(.q-tab) {
      min-height: 56px;
      color: #64748b;

      &.q-tab--active {
        color: #6366F1;
      }
    }

    :deep(.q-tab__icon) {
      font-size: 26px;
    }

    :deep(.q-tab__label) {
      font-size: 10px;
      margin-top: 2px;
    }

    :deep(.q-tabs__content) {
      justify-content: space-around;
    }
  }
}
</style>
