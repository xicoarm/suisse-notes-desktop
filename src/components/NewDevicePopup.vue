<template>
  <transition name="slide-up">
    <div
      v-if="deviceStore.discoveredDevice"
      class="new-device-popup"
    >
      <div class="popup-content">
        <div class="popup-icon">
          <q-icon
            name="bluetooth"
            size="24px"
            color="primary"
          />
        </div>

        <div class="popup-text">
          <div class="popup-title">
            {{ $t('newDeviceFound') }}
          </div>
          <div class="popup-device-name">
            {{ deviceStore.discoveredDevice.name }}
          </div>
        </div>

        <div class="popup-actions">
          <q-btn
            flat
            dense
            no-caps
            color="grey-7"
            :label="$t('reject')"
            class="popup-btn"
            @click="onReject"
          />
          <q-btn
            unelevated
            dense
            no-caps
            color="primary"
            :label="$t('connectDevice')"
            :loading="deviceStore.isConnecting"
            class="popup-btn connect-btn"
            @click="onAccept"
          />
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
import { useDeviceStore } from '../stores/device';

export default {
  name: 'NewDevicePopup',

  setup() {
    const deviceStore = useDeviceStore();

    const onAccept = async () => {
      await deviceStore.acceptDiscoveredDevice();
    };

    const onReject = async () => {
      await deviceStore.rejectDiscoveredDevice();
    };

    return {
      deviceStore,
      onAccept,
      onReject
    };
  }
};
</script>

<style lang="scss" scoped>
.new-device-popup {
  position: fixed;
  bottom: 80px; // Above mobile bottom nav
  left: 12px;
  right: 12px;
  z-index: 9000;
  pointer-events: auto;
}

.popup-content {
  display: flex;
  align-items: center;
  gap: 12px;
  background: white;
  border-radius: 12px;
  padding: 12px 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05);
}

.popup-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.1);
  border-radius: 10px;
}

.popup-text {
  flex: 1;
  min-width: 0;
}

.popup-title {
  font-size: 13px;
  font-weight: 600;
  color: #1e293b;
}

.popup-device-name {
  font-size: 12px;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.popup-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.popup-btn {
  font-size: 12px;
  padding: 4px 12px;
  min-height: 32px;
  border-radius: 8px;
}

.connect-btn {
  font-weight: 600;
}

// Transition
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

@media (min-width: 601px) {
  .new-device-popup {
    bottom: 24px;
    left: auto;
    right: 24px;
    max-width: 400px;
  }
}
</style>
