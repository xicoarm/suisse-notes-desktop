<template>
  <q-page class="register-page">
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
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';

const { t } = useI18n();

const router = useRouter();
const authStore = useAuthStore();

const name = ref('');
const email = ref('');
const password = ref('');

const isValidEmail = (val) => {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailPattern.test(val);
};

const handleRegister = async () => {
  if (!name.value || !email.value || !password.value) return;
  if (password.value.length < 8) return;
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
