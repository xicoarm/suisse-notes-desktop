<template>
  <div class="upload-progress">
    <div class="progress-header q-mb-md">
      <div class="text-subtitle1">
        <q-icon name="cloud_upload" class="q-mr-sm" />
        Uploading...
      </div>
      <div class="text-h6 text-primary">{{ progress }}%</div>
    </div>

    <q-linear-progress
      :value="progress / 100"
      color="primary"
      size="12px"
      rounded
      class="q-mb-md"
    />

    <div class="progress-details text-caption text-grey q-mb-md">
      {{ formatBytes(bytesUploaded) }} / {{ formatBytes(bytesTotal) }}
    </div>

    <div class="progress-actions">
      <q-btn
        flat
        color="warning"
        label="Pause"
        icon="pause"
        @click="$emit('pause')"
        class="q-mr-sm"
      />
      <q-btn
        flat
        color="negative"
        label="Cancel"
        icon="close"
        @click="$emit('cancel')"
      />
    </div>
  </div>
</template>

<script setup>
defineProps({
  progress: {
    type: Number,
    default: 0
  },
  bytesUploaded: {
    type: Number,
    default: 0
  },
  bytesTotal: {
    type: Number,
    default: 0
  }
});

defineEmits(['pause', 'cancel']);

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
</script>

<style scoped>
.upload-progress {
  text-align: center;
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.progress-actions {
  display: flex;
  justify-content: center;
}
</style>
