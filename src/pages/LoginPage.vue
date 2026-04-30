<template>
  <q-page class="login-page">
    <!-- Language selector - top right corner -->
    <div class="login-lang-selector">
      <q-btn-dropdown
        flat
        no-caps
        dense
        class="login-lang-dropdown"
        dropdown-icon="none"
      >
        <template #label>
          <div class="login-lang-current">
            <q-icon
              name="language"
              size="16px"
            />
            <span>{{ currentLangShort }}</span>
            <q-icon
              name="expand_more"
              size="14px"
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
    </div>

    <!-- Login Container -->
    <div class="login-container">
      <div class="login-card">
        <!-- Logo Section -->
        <div class="login-logo">
          <q-icon
            name="mic"
            class="logo-icon"
          />
          <h1>Suisse Notes</h1>
          <p>{{ $t('signInToStart') }}</p>
        </div>

        <!-- Login Form -->
        <q-form
          class="login-form"
          @submit="handleLogin"
        >
          <q-input
            v-model="email"
            :label="$t('email')"
            type="email"
            outlined
            :rules="[val => !!val || $t('emailRequired')]"
            autocomplete="email"
            class="q-mb-md"
          >
            <template #prepend>
              <q-icon
                name="email"
                color="grey-6"
              />
            </template>
          </q-input>

          <q-input
            v-model="password"
            :label="$t('password')"
            type="password"
            outlined
            :rules="[val => !!val || $t('passwordRequired')]"
            autocomplete="current-password"
            class="q-mb-md"
          >
            <template #prepend>
              <q-icon
                name="lock"
                color="grey-6"
              />
            </template>
          </q-input>

          <!-- Error Banner -->
          <div
            v-if="authStore.error"
            class="error-banner q-mb-md"
          >
            <q-icon
              name="error_outline"
              color="negative"
            />
            <span>{{ authStore.error }}</span>
            <q-btn
              flat
              round
              size="sm"
              icon="close"
              color="grey-7"
              @click="authStore.clearError()"
            />
          </div>

          <q-btn
            type="submit"
            unelevated
            class="gradient-btn full-width"
            size="lg"
            :loading="authStore.loading"
          >
            {{ $t('signIn') }}
          </q-btn>
        </q-form>

        <!-- SSO providers (desktop only for now) -->
        <div
          v-if="isDesktopApp"
          class="sso-section"
        >
          <div class="sso-divider">
            <span>{{ $t('orContinueWith') }}</span>
          </div>
          <q-btn
            outline
            no-caps
            class="sso-btn full-width q-mb-sm"
            size="md"
            :loading="ssoLoading === 'microsoft'"
            :disable="authStore.loading || ssoLoading === 'google'"
            @click="handleMicrosoftLogin"
          >
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span
              class="sso-logo"
              v-html="microsoftLogoSvg"
            />
            <span>{{ $t('signInWithMicrosoft') }}</span>
          </q-btn>
          <q-btn
            outline
            no-caps
            class="sso-btn full-width"
            size="md"
            :loading="ssoLoading === 'google'"
            :disable="authStore.loading || ssoLoading === 'microsoft'"
            @click="handleGoogleLogin"
          >
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span
              class="sso-logo"
              v-html="googleLogoSvg"
            />
            <span>{{ $t('signInWithGoogle') }}</span>
          </q-btn>
        </div>

        <!-- Links -->
        <div class="login-links">
          <a
            href="#"
            class="forgot-link"
            @click.prevent="openForgotPassword"
          >{{ $t('forgotPassword') }}</a>
        </div>
      </div>
    </div>

    <!-- Company Footer -->
    <div class="company-footer">
      <div class="footer-content">
        <div class="company-info">
          <span class="company-name">Suisse IT GmbH</span>
        </div>
        <div class="footer-links">
          <a
            href="https://suisse-it.ch"
            target="_blank"
            rel="noopener"
          >suisse-it.ch</a>
          <span class="link-divider">•</span>
          <a
            href="https://app.suisse-notes.ch/privacy"
            target="_blank"
            rel="noopener"
          >{{ $t('privacy') }}</a>
          <span class="link-divider">•</span>
          <a
            href="https://app.suisse-notes.ch/terms"
            target="_blank"
            rel="noopener"
          >{{ $t('terms') }}</a>
        </div>
        <div class="copyright">
          © {{ currentYear }} Suisse IT GmbH. All rights reserved.
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { isElectron, isCapacitor } from '../utils/platform';
import { useLanguage } from '../composables/useLanguage';

const router = useRouter();
const authStore = useAuthStore();
const { languages, currentLang, currentLangShort, setLanguage, initLanguage } = useLanguage();
const isMobileApp = isCapacitor();
const isDesktopApp = isElectron();
// null | 'microsoft' | 'google' — which SSO flow is currently in flight
const ssoLoading = ref(null);

// Brand marks — inlined to avoid extra image fetches
const microsoftLogoSvg = '<svg viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>';
const googleLogoSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>';

// Set white status bar icons for purple background on mobile
onMounted(async () => {
  initLanguage();
  if (isCapacitor()) {
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      await StatusBar.setStyle({ style: Style.Dark });
    } catch (e) { /* not available */ }
  }

  // Wire up SSO callback listener (Electron only)
  if (isDesktopApp && window.electronAPI?.auth?.onSSOCallback) {
    window.electronAPI.auth.onSSOCallback(async (payload) => {
      ssoLoading.value = null;
      if (!payload || payload.error) {
        authStore.error = payload?.error || 'SSO login failed';
        return;
      }
      const result = await authStore.loginWithSSO(payload);
      if (result.success) {
        router.push('/record');
      }
    });
  }
});

onUnmounted(async () => {
  if (isCapacitor()) {
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      await StatusBar.setStyle({ style: Style.Light });
    } catch (e) { /* not available */ }
  }
  if (isDesktopApp && window.electronAPI?.auth?.removeSSOCallbackListener) {
    window.electronAPI.auth.removeSSOCallbackListener();
  }
});

const email = ref('');
const password = ref('');

// Current year for copyright
const currentYear = new Date().getFullYear();

const handleLogin = async () => {
  if (!email.value || !password.value) return;

  const result = await authStore.login(email.value, password.value);

  if (result.success) {
    router.push('/record');
  }
};

const handleMicrosoftLogin = async () => {
  if (!window.electronAPI?.auth?.loginWithMicrosoft) return;
  authStore.clearError();
  ssoLoading.value = 'microsoft';
  const result = await window.electronAPI.auth.loginWithMicrosoft();
  if (!result?.success) {
    ssoLoading.value = null;
    authStore.error = result?.error || 'Could not open Microsoft login';
  }
  // On success, the system browser is now open; the actual login completes
  // asynchronously via the auth:ssoCallback IPC event handled in onMounted.
};

const handleGoogleLogin = async () => {
  if (!window.electronAPI?.auth?.loginWithGoogle) return;
  authStore.clearError();
  ssoLoading.value = 'google';
  const result = await window.electronAPI.auth.loginWithGoogle();
  if (!result?.success) {
    ssoLoading.value = null;
    authStore.error = result?.error || 'Could not open Google login';
  }
};

const openForgotPassword = async () => {
  const url = 'https://app.suisse-notes.ch/forgot-password';

  if (isElectron() && window.electronAPI?.shell?.openExternal) {
    window.electronAPI.shell.openExternal(url);
  } else if (isCapacitor()) {
    // Use Capacitor Browser plugin
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
    } catch (error) {
      // Fallback to window.open
      window.open(url, '_blank');
    }
  } else {
    window.open(url, '_blank');
  }
};
</script>

<style lang="scss" scoped>
.login-page {
  min-height: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
  padding-top: env(safe-area-inset-top, 0);
  padding-bottom: env(safe-area-inset-bottom, 0);
  box-sizing: border-box;
  overflow: hidden; // Prevent scrolling on login page
}

// Login container
.login-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  min-height: 0; // Allow shrinking
  overflow-y: auto; // Allow scroll only if needed
}

.login-card {
  background: white;
  border-radius: 16px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  padding: 32px 28px;
  width: 100%;
  max-width: 380px;
  max-height: 100%; // Don't overflow container
}

.login-logo {
  text-align: center;
  margin-bottom: 24px;

  .logo-icon {
    font-size: 40px;
    color: #6366F1;
  }

  h1 {
    font-size: 22px;
    font-weight: 700;
    margin: 8px 0 4px 0;
    color: #1e293b;
  }

  p {
    color: #64748b;
    font-size: 13px;
    margin: 0;
  }
}

.login-form {
  margin-bottom: 24px;
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  color: #ef4444;
  font-size: 14px;

  span {
    flex: 1;
  }
}

.sso-section {
  margin-top: 4px;
  margin-bottom: 24px;
}

.sso-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0;
  color: #94a3b8;
  font-size: 12px;

  &::before,
  &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #e2e8f0;
  }
}

.sso-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-color: #e2e8f0;
  color: #1e293b;
  font-weight: 500;

  &:hover {
    background: #f8fafc;
  }

  .sso-logo {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }
}

.login-links {
  text-align: center;

  p {
    color: #64748b;
    font-size: 14px;
    margin: 0 0 8px 0;
  }

  .register-link {
    color: #6366F1;
    text-decoration: none;
    font-weight: 600;

    &:hover {
      text-decoration: underline;
    }
  }

  .forgot-link {
    color: #94a3b8;
    text-decoration: none;
    font-size: 13px;

    &:hover {
      color: #6366F1;
      text-decoration: underline;
    }
  }
}

// Company footer
.company-footer {
  flex-shrink: 0;
  padding: 20px 24px;
  text-align: center;
}

.footer-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}

.company-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;

  .company-name {
    font-size: 13px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.95);
  }

  .company-divider {
    color: rgba(255, 255, 255, 0.5);
  }

  .company-location {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.8);
  }
}

.footer-links {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;

  a {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.8);
    text-decoration: none;
    transition: color 0.2s ease;

    &:hover {
      color: white;
      text-decoration: underline;
    }
  }

  .link-divider {
    color: rgba(255, 255, 255, 0.4);
    font-size: 10px;
  }
}

.copyright {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 4px;
}

// Language selector - top right corner
.login-lang-selector {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 12px);
  right: 16px;
  z-index: 10;
}

.login-lang-dropdown {
  padding: 0;
  min-height: auto;

  :deep(.q-btn__content) {
    padding: 0;
  }
}

.login-lang-current {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.95);
  transition: all 0.2s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.3);
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

// Override Quasar input styling
:deep(.q-field--outlined .q-field__control) {
  border-radius: 8px;
}

:deep(.q-field--outlined.q-field--focused .q-field__control:before) {
  border-color: #6366F1;
}

// Mobile adjustments
@media (max-width: 600px) {
  .login-container {
    padding: 8px 16px;
  }

  .login-card {
    padding: 20px 16px;
    border-radius: 12px;
  }

  .login-logo {
    margin-bottom: 16px;

    .logo-icon {
      font-size: 32px;
    }

    h1 {
      font-size: 18px;
      margin: 6px 0 2px 0;
    }

    p {
      font-size: 11px;
    }
  }

  .login-form {
    margin-bottom: 16px;

    :deep(.q-field) {
      margin-bottom: 12px !important;
    }

    :deep(.q-field__label) {
      font-size: 13px;
    }
  }

  .login-links {
    p {
      font-size: 13px;
      margin-bottom: 6px;
    }

    .forgot-link {
      font-size: 12px;
    }
  }

  .company-footer {
    padding: 12px 16px;
  }

  .footer-content {
    gap: 4px;
  }

  .company-info {
    flex-direction: row;
    gap: 6px;

    .company-name {
      font-size: 11px;
    }

    .company-location {
      font-size: 10px;
    }

    .company-divider {
      font-size: 10px;
    }
  }

  .footer-links {
    gap: 4px;

    a {
      font-size: 10px;
      padding: 2px 4px;
    }

    .link-divider {
      font-size: 8px;
    }
  }

  .copyright {
    font-size: 9px;
    margin-top: 2px;
  }
}

// Extra small screens (like iPhone SE)
@media (max-height: 600px) {
  .login-logo {
    margin-bottom: 12px;

    .logo-icon {
      font-size: 28px;
    }

    h1 {
      font-size: 16px;
    }
  }

  .login-form {
    margin-bottom: 12px;
  }

  .company-footer {
    padding: 8px 16px;
  }
}
</style>
