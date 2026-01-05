<template>
  <router-view />
</template>

<script setup>
import { onMounted } from 'vue';
import { useConfigStore } from './stores/config';

const configStore = useConfigStore();

onMounted(async () => {
  // Load configuration on app start
  await configStore.loadConfig();
  // Session check is now handled by router guard (prevents race condition)
});
</script>
