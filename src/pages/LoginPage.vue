<template>
  <q-page class="login-page">
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

        <!-- Links -->
        <div class="login-links">
          <p>
            {{ $t('noAccount') }}
            <router-link
              to="/register"
              class="register-link"
            >
              {{ $t('createAccount') }}
            </router-link>
          </p>
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
          <span class="company-name">Suisse AI Group GmbH</span>
          <span class="company-divider">•</span>
          <span class="company-location">Wallisellen, Switzerland</span>
        </div>
        <div class="footer-links">
          <a
            href="https://suisse-ai.ch"
            target="_blank"
            rel="noopener"
          >suisse-ai.ch</a>
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
          © {{ currentYear }} Suisse AI Group GmbH. All rights reserved.
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { isElectron, isCapacitor } from '../utils/platform';

const router = useRouter();
const authStore = useAuthStore();

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
  // Status bar is handled by @capacitor/status-bar plugin with overlaysWebView: false
  // Only need safe-area for bottom home indicator on iOS
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
