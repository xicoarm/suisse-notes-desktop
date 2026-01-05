<template>
  <router-view />
</template>

<script setup>
import { onMounted } from 'vue';
import { useConfigStore } from './stores/config';
import { useAuthStore } from './stores/auth';

const configStore = useConfigStore();
const authStore = useAuthStore();

onMounted(async () => {
  // Load configuration on app start
  await configStore.loadConfig();
  // Check for existing session
  await authStore.checkSession();
});
</script>
