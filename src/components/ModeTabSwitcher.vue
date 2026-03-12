<template>
  <div
    v-if="!hidden"
    class="mode-tab-switcher"
  >
    <q-tabs
      :model-value="currentMode"
      class="mode-tabs"
      :class="{ 'tabs-disabled': disabled }"
      inline-label
      no-caps
      indicator-color="primary"
      @update:model-value="handleSwitchMode"
    >
      <q-tab
        name="record"
        icon="mic"
        :label="$t('recordAudio')"
        class="mode-tab"
        :disable="disabled"
      />
      <q-tab
        name="upload"
        icon="cloud_upload"
        :label="$t('uploadFileTab')"
        class="mode-tab"
        :disable="disabled"
      />
    </q-tabs>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';

const props = defineProps({
  disabled: {
    type: Boolean,
    default: false
  },
  hidden: {
    type: Boolean,
    default: false
  }
});

const router = useRouter();
const route = useRoute();

const currentMode = computed(() => {
  if (route.path.includes('/upload')) return 'upload';
  return 'record';
});

const handleSwitchMode = (mode) => {
  if (props.disabled) {
    // Note: Disabled tabs shouldn't be clickable, but just in case
    return;
  }
  switchMode(mode);
};

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

  @media (max-width: 600px) {
    max-width: 100%;
    width: 100%;
  }

  &.tabs-disabled {
    opacity: 0.5;
    pointer-events: none;
  }

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

    @media (max-width: 600px) {
      padding: 0 12px;
      font-size: 12px;
    }

    &.q-tab--active {
      background: white;
      color: #6366F1;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    &:not(.q-tab--active):hover {
      background: rgba(255, 255, 255, 0.5);
    }

    &.disabled {
      cursor: not-allowed;
      opacity: 0.6;
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
