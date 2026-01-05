<template>
  <q-page class="login-container">
    <div class="login-card">
      <!-- Logo Section -->
      <div class="login-logo">
        <q-icon name="mic" class="logo-icon" />
        <h1>Suisse Notes</h1>
        <p>Sign in to start recording</p>
      </div>

      <!-- Login Form -->
      <q-form @submit="handleLogin" class="login-form">
        <q-input
          v-model="email"
          label="Email"
          type="email"
          outlined
          :rules="[val => !!val || 'Email is required']"
          autocomplete="email"
          class="q-mb-md"
        >
          <template #prepend>
            <q-icon name="email" color="grey-6" />
          </template>
        </q-input>

        <q-input
          v-model="password"
          label="Password"
          type="password"
          outlined
          :rules="[val => !!val || 'Password is required']"
          autocomplete="current-password"
          class="q-mb-md"
        >
          <template #prepend>
            <q-icon name="lock" color="grey-6" />
          </template>
        </q-input>

        <!-- Error Banner -->
        <div class="error-banner q-mb-md" v-if="authStore.error">
          <q-icon name="error_outline" color="negative" />
          <span>{{ authStore.error }}</span>
          <q-btn flat round size="sm" icon="close" color="grey-7" @click="authStore.clearError()" />
        </div>

        <q-btn
          type="submit"
          unelevated
          class="gradient-btn full-width"
          size="lg"
          :loading="authStore.loading"
        >
          Sign In
        </q-btn>
      </q-form>

      <!-- Links -->
      <div class="login-links">
        <p>
          Don't have an account?
          <router-link to="/register" class="register-link">Create Account</router-link>
        </p>
        <a href="#" @click.prevent="openForgotPassword" class="forgot-link">Forgot Password?</a>
      </div>

      <!-- Footer -->
      <div class="login-footer">
        <p>Recording desktop app for Suisse Notes platform</p>
      </div>
    </div>
  </q-page>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const email = ref('');
const password = ref('');

const handleLogin = async () => {
  if (!email.value || !password.value) return;

  const result = await authStore.login(email.value, password.value);

  if (result.success) {
    router.push('/record');
  }
};

const openForgotPassword = () => {
  window.electronAPI.shell.openExternal('https://app.suisse-notes.ch/forgot-password');
};
</script>

<style lang="scss" scoped>
.login-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
  padding: 24px;
}

.login-card {
  background: white;
  border-radius: 16px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  padding: 40px;
  width: 100%;
  max-width: 400px;
}

.login-logo {
  text-align: center;
  margin-bottom: 32px;

  .logo-icon {
    font-size: 48px;
    color: #6366F1;
  }

  h1 {
    font-size: 24px;
    font-weight: 700;
    margin: 12px 0 4px 0;
    color: #1e293b;
  }

  p {
    color: #64748b;
    font-size: 14px;
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
  margin-bottom: 16px;

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

.login-footer {
  text-align: center;
  padding-top: 16px;
  border-top: 1px solid #e2e8f0;

  p {
    color: #94a3b8;
    font-size: 13px;
    margin: 0;
  }
}

// Override Quasar input styling
:deep(.q-field--outlined .q-field__control) {
  border-radius: 8px;
}

:deep(.q-field--outlined.q-field--focused .q-field__control:before) {
  border-color: #6366F1;
}
</style>
