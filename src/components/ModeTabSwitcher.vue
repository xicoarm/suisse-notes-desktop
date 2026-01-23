<template>
  <div class="mode-tab-switcher">
    <q-tabs
      :model-value="currentMode"
      class="mode-tabs"
      inline-label
      no-caps
      indicator-color="primary"
      @update:model-value="switchMode"
    >
      <q-tab
        name="record"
        icon="mic"
        :label="$t('recordAudio')"
        class="mode-tab"
      />
      <q-tab
        name="upload"
        icon="cloud_upload"
        :label="$t('uploadFileTab')"
        class="mode-tab"
      />
    </q-tabs>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';

const router = useRouter();
const route = useRoute();

const currentMode = computed(() => {
  if (route.path.includes('/upload')) return 'upload';
  return 'record';
});

const switchMode = (mode) => {
  if (mode === 'upload') {
    router.push('/upload');
  } else {
    router.push('/record');
  }
};
</script>

<style lang="scss" scoped>
.mode-tab-switcher {
  margin-bottom: 24px;
}

.mode-tabs {
  background: #f1f5f9;
  border-radius: 10px;
  padding: 4px;
  max-width: 380px;

  :deep(.q-tabs__content) {
    gap: 4px;
  }

  :deep(.q-tab) {
    border-radius: 8px;
    min-height: 40px;
    padding: 0 16px;
    font-weight: 500;
    font-size: 13px;
    color: #64748b;
    transition: all 0.2s ease;

    &.q-tab--active {
      background: white;
      color: #6366F1;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    &:not(.q-tab--active):hover {
      background: rgba(255, 255, 255, 0.5);
    }
  }

  :deep(.q-tab__icon) {
    font-size: 18px;
    margin-right: 6px;
  }

  :deep(.q-tab__indicator) {
    display: none;
  }

  :deep(.q-tabs__arrow) {
    display: none;
  }
}
</style>
