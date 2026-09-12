<template>
  <div class="history-day-groups">
    <section
      v-for="group in groups"
      :key="group.key"
      class="day-group"
    >
      <div class="day-header">
        <span class="day-label">{{ group.label }}</span>
        <span class="day-count">{{ group.items.length }}</span>
      </div>
      <RecordingHistoryCard
        v-for="recording in group.items"
        :key="recording.id"
        :recording="recording"
        :uploading="uploadingId === recording.id"
        v-bind="$attrs"
      />
    </section>
  </div>
</template>

<script>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import RecordingHistoryCard from './RecordingHistoryCard.vue';
import { groupRecordingsByDay } from '../utils/historyGroups';

/**
 * Mobile history list: recordings grouped by calendar day with a compact
 * "Today / Yesterday / Thursday, 11 September" header per group, newest
 * first. Every card event (upload, retry, reupload, deleted, cancel-transfer,
 * resync, answer-prep) is forwarded untouched through $attrs.
 */
export default {
  name: 'HistoryDayGroups',
  components: { RecordingHistoryCard },
  inheritAttrs: false,
  props: {
    recordings: { type: Array, required: true },
    uploadingId: { type: String, default: null }
  },
  setup(props) {
    const { t, locale } = useI18n();
    const groups = computed(() => groupRecordingsByDay(props.recordings, { locale: locale.value, t }));
    return { groups };
  }
};
</script>

<style lang="scss" scoped>
.day-group {
  margin-bottom: 14px;
}

.day-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 4px 8px;

  .day-label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: #64748b;
  }

  .day-count {
    font-size: 11px;
    font-weight: 500;
    color: #94a3b8;
    background: rgba(148, 163, 184, 0.12);
    border-radius: 9999px;
    padding: 1px 7px;
  }
}
</style>
