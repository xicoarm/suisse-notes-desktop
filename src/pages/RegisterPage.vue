<template>
  <q-page class="register-page">
    <!-- Language selector - top right corner -->
    <div class="register-lang-selector">
      <q-btn-dropdown
        flat
        no-caps
        dense
        class="register-lang-dropdown"
        dropdown-icon="none"
      >
        <template #label>
          <div class="register-lang-current">
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

    <div class="register-container">
      <div class="register-card">
        <!-- Logo Section -->
        <div class="register-logo">
          <q-icon
            name="mic"
            class="logo-icon"
          />
          <h1>Suisse Notes</h1>
          <p>{{ $t('createYourAccount') }}</p>
        </div>

        <!-- Register Form -->
        <q-form
          class="register-form"
          @submit="handleRegister"
        >
          <q-input
            v-model="name"
            label="Full Name"
            outlined
            :rules="[val => !!val || 'Name is required']"
            autocomplete="name"
            class="q-mb-md"
          >
            <template #prepend>
              <q-icon
                name="person"
                color="grey-6"
              />
            </template>
          </q-input>

          <q-input
            v-model="email"
            label="Email"
            type="email"
            outlined
            :rules="[
              val => !!val || 'Email is required',
              val => isValidEmail(val) || 'Please enter a valid email'
            ]"
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
            label="Password"
            type="password"
            outlined
            :rules="[
              val => !!val || 'Password is required',
              val => val.length >= 8 || 'Password must be at least 8 characters'
            ]"
            autocomplete="new-password"
            class="q-mb-md"
          >
            <template #prepend>
              <q-icon
                name="lock"
                color="grey-6"
              />
            </template>
          </q-input>

          <q-input
            v-model="confirmPassword"
            label="Confirm Password"
            type="password"
            outlined
            :rules="[
              val => !!val || 'Please confirm your password',
              val => val === password || 'Passwords do not match'
            ]"
            autocomplete="new-password"
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
            Create Account
          </q-btn>
        </q-form>

        <!-- Login Link -->
        <div class="register-footer">
          <p>
            {{ $t('alreadyHaveAccount') }}
            <router-link
              to="/login"
              class="login-link"
            >
              {{ $t('signIn') }}
            </router-link>
          </p>
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { isCapacitor } from '../utils/platform';
import { useLanguage } from '../composables/useLanguage';

const { t } = useI18n();

const router = useRouter();
const authStore = useAuthStore();
const { languages, currentLang, currentLangShort, setLanguage, initLanguage } = useLanguage();

// Set white status bar icons for purple background on mobile
onMounted(async () => {
  initLanguage();
  if (isCapacitor()) {
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      await StatusBar.setStyle({ style: Style.Dark });
    } catch (e) { /* not available */ }
  }
});

onUnmounted(async () => {
  if (isCapacitor()) {
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      await StatusBar.setStyle({ style: Style.Light });
    } catch (e) { /* not available */ }
  }
});

const name = ref('');
const email = ref('');
const password = ref('');
const confirmPassword = ref('');

const isValidEmail = (val) => {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailPattern.test(val);
};

const handleRegister = async () => {
  if (!name.value || !email.value || !password.value || !confirmPassword.value) return;
  if (password.value.length < 8) return;
  if (password.value !== confirmPassword.value) return;
  if (!isValidEmail(email.value)) return;

  const result = await authStore.register(email.value, password.value, name.value);

  if (result.success) {
    router.push('/record');
  }
};
</script>

<style lang="scss" scoped>
.register-page {
  min-height: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
  padding-top: env(safe-area-inset-top, 0);
  padding-bottom: env(safe-area-inset-bottom, 0);
  box-sizing: border-box;
  overflow: hidden;
}

.register-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  min-height: 0;
  overflow-y: auto;
}

.register-card {
  background: white;
  border-radius: 16px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  padding: 32px 28px;
  width: 100%;
  max-width: 380px;
  max-height: 100%;
}

.register-logo {
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

.register-form {
  margin-bottom: 20px;
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

.register-footer {
  text-align: center;
  padding-top: 16px;
  border-top: 1px solid #e2e8f0;

  p {
    color: #64748b;
    font-size: 14px;
    margin: 0;
  }

  .login-link {
    color: #6366F1;
    text-decoration: none;
    font-weight: 600;

    &:hover {
      text-decoration: underline;
    }
  }
}

// Language selector - top right corner
.register-lang-selector {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 12px);
  right: 16px;
  z-index: 10;
}

.register-lang-dropdown {
  padding: 0;
  min-height: auto;

  :deep(.q-btn__content) {
    padding: 0;
  }
}

.register-lang-current {
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
  .register-container {
    padding: 8px 16px;
  }

  .register-card {
    padding: 20px 16px;
    border-radius: 12px;
  }

  .register-logo {
    margin-bottom: 16px;

    .logo-icon {
      font-size: 32px;
    }

    h1 {
      font-size: 18px;
    }

    p {
      font-size: 11px;
    }
  }

  .register-form {
    margin-bottom: 16px;

    :deep(.q-field) {
      margin-bottom: 10px !important;
    }
  }

  .register-footer {
    padding-top: 12px;

    p {
      font-size: 13px;
    }
  }
}

@media (max-height: 600px) {
  .register-logo {
    margin-bottom: 12px;

    .logo-icon {
      font-size: 28px;
    }

    h1 {
      font-size: 16px;
    }
  }

  .register-form {
    margin-bottom: 12px;
  }
}
</style>
