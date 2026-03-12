<template>
  <q-page class="device-page">
    <div class="page-header">
      <h1>{{ $t('deviceTitle') }}</h1>
      <p class="text-subtitle">
        {{ $t('deviceSubtitle') }}
      </p>
    </div>

    <!-- BLE Not Available -->
    <div
      v-if="!bleAvailable"
      class="empty-state"
    >
      <q-icon
        name="bluetooth_disabled"
        class="empty-icon"
      />
      <div class="empty-title">
        {{ $t('bleNotAvailable') }}
      </div>
    </div>

    <!-- Device Card (paired device exists) -->
    <div
      v-else-if="deviceStore.hasPairedDevice"
      class="device-card"
    >
      <div class="device-card-header">
        <div class="device-status-row">
          <span
            class="status-dot"
            :class="{ connected: deviceStore.isConnected }"
          />
          <span class="status-text">
            {{ deviceStore.isConnected ? $t('connected') : $t('disconnected') }}
          </span>
        </div>
        <q-btn
          flat
          round
          dense
          icon="more_vert"
          size="sm"
        >
          <q-menu>
            <q-list dense>
              <q-item
                v-if="deviceStore.isConnected"
                v-close-popup
                clickable
                @click="disconnect"
              >
                <q-item-section avatar>
                  <q-icon
                    name="bluetooth_disabled"
                    size="20px"
                  />
                </q-item-section>
                <q-item-section>{{ $t('disconnectDevice') }}</q-item-section>
              </q-item>
              <q-item
                v-close-popup
                clickable
                @click="confirmForget"
              >
                <q-item-section avatar>
                  <q-icon
                    name="delete_outline"
                    color="negative"
                    size="20px"
                  />
                </q-item-section>
                <q-item-section class="text-negative">
                  {{ $t('forgetDevice') }}
                </q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </q-btn>
      </div>

      <div class="device-identity">
        <div class="device-icon-wrapper">
          <q-icon
            name="mic"
            size="28px"
            color="white"
          />
        </div>
        <div>
          <div class="device-name">
            {{ deviceStore.deviceName || deviceStore.pairedDevice.name }}
          </div>
          <div class="device-sn">
            SN: {{ deviceStore.deviceSN || deviceStore.pairedDevice.sn }}
          </div>
        </div>
      </div>

      <!-- Stats (when connected) -->
      <div
        v-if="deviceStore.isConnected"
        class="device-stats"
      >
        <div class="device-stat">
          <q-icon
            name="battery_std"
            :color="batteryColor"
            size="18px"
          />
          <span>{{ deviceStore.batteryLevel }}%</span>
        </div>
        <div class="device-stat-divider" />
        <div class="device-stat">
          <q-icon
            name="sd_storage"
            color="primary"
            size="18px"
          />
          <span>{{ formatStorage(deviceStore.freeStorageKB) }}</span>
        </div>
        <div
          v-if="deviceStore.isRecordingOnDevice"
          class="device-stat-divider"
        />
        <div
          v-if="deviceStore.isRecordingOnDevice"
          class="device-stat recording-active-badge"
        >
          <q-icon
            name="fiber_manual_record"
            color="negative"
            size="12px"
          />
          <span class="text-negative">{{ $t('statusRecording') }}</span>
        </div>
      </div>

      <!-- Connecting state -->
      <div
        v-if="deviceStore.isConnecting"
        class="connecting-banner"
      >
        <q-spinner-dots
          color="primary"
          size="24px"
        />
        <span>{{ $t('connecting') }}</span>
      </div>

      <!-- Reconnect button (disconnected) -->
      <q-btn
        v-if="!deviceStore.isConnected && !deviceStore.isConnecting"
        unelevated
        class="gradient-btn full-width q-mt-lg"
        icon="bluetooth"
        :label="$t('connectDevice')"
        @click="reconnect"
      />
    </div>

    <!-- No paired device - scan UI -->
    <div
      v-else
      class="empty-state scan-state"
    >
      <div class="scan-icon-wrapper">
        <q-icon
          name="bluetooth_searching"
          size="56px"
          color="primary"
        />
        <div
          v-if="deviceStore.isScanning"
          class="scan-pulse"
        />
      </div>
      <div class="empty-title">
        {{ $t('connectRecorder') }}
      </div>
      <div class="empty-subtitle">
        {{ $t('connectRecorderDesc') }}
      </div>
      <q-btn
        unelevated
        class="gradient-btn q-mt-lg"
        :icon="deviceStore.isScanning ? undefined : 'bluetooth_searching'"
        :label="deviceStore.isScanning ? $t('scanning') : $t('scanForDevices')"
        :loading="deviceStore.isScanning"
        @click="deviceStore.isScanning ? deviceStore.stopScan() : startScan()"
      />
    </div>

    <!-- Scan Results -->
    <div
      v-if="deviceStore.scanResults.length > 0 && !deviceStore.hasPairedDevice"
      class="scan-results"
    >
      <div class="section-title">
        {{ $t('devicesFound') }}
      </div>
      <div
        v-for="device in deviceStore.scanResults"
        :key="device.deviceId"
        class="scan-result-item"
        @click="connectDevice(device)"
      >
        <div class="scan-result-left">
          <div class="scan-result-icon">
            <q-icon
              name="bluetooth"
              color="primary"
              size="20px"
            />
          </div>
          <div>
            <div class="scan-result-name">
              {{ device.name || $t('unknownDevice') }}
            </div>
            <div class="scan-result-rssi">
              {{ device.rssi ? `${device.rssi} dBm` : '' }}
            </div>
          </div>
        </div>
        <q-icon
          name="chevron_right"
          color="grey-5"
          size="20px"
        />
      </div>
    </div>

    <!-- Sync Progress Banner -->
    <div
      v-if="deviceStore.isSyncing"
      class="sync-progress-banner"
    >
      <div class="sync-progress-header">
        <q-spinner-dots
          color="white"
          size="16px"
        />
        <span>{{ $t('syncProgress', { current: deviceStore.syncCurrent, total: deviceStore.syncTotal }) }}</span>
      </div>
      <q-linear-progress
        :value="deviceStore.syncProgress / 100"
        color="white"
        track-color="white-3"
        size="4px"
        rounded
        class="q-mt-sm"
      />
    </div>

    <!-- Sync Complete / Error -->
    <div
      v-if="deviceStore.syncState === 'complete'"
      class="sync-status-banner complete"
    >
      <q-icon
        name="check_circle"
        size="18px"
      />
      <span>{{ $t('syncComplete') }}</span>
      <q-btn
        flat
        dense
        size="sm"
        icon="close"
        color="white"
        @click="deviceStore.syncState = 'idle'"
      />
    </div>
    <div
      v-if="deviceStore.syncState === 'error'"
      class="sync-status-banner error"
    >
      <q-icon
        name="error_outline"
        size="18px"
      />
      <span>{{ $t('syncFailed') }}</span>
      <q-btn
        flat
        dense
        size="sm"
        icon="close"
        color="white"
        @click="deviceStore.syncState = 'idle'"
      />
    </div>

    <!-- Recordings on Device -->
    <div
      v-if="deviceStore.isConnected && deviceStore.fileListLoaded"
      class="files-section"
    >
      <div class="section-header">
        <div class="section-title">
          {{ $t('deviceRecordings') }}
          <span
            v-if="deviceStore.newFilesCount > 0"
            class="new-badge"
          >{{ deviceStore.newFilesCount }}</span>
        </div>
        <q-btn
          v-if="deviceStore.newFilesCount > 0"
          flat
          dense
          color="primary"
          no-caps
          :label="$t('syncAll')"
          :loading="deviceStore.isSyncing"
          icon="sync"
          @click="syncAll"
        />
      </div>

      <!-- Empty file list -->
      <div
        v-if="deviceStore.deviceFiles.length === 0"
        class="no-files"
      >
        <q-icon
          name="folder_open"
          size="40px"
          color="grey-4"
        />
        <span>{{ $t('noDeviceRecordings') }}</span>
      </div>

      <!-- File list -->
      <div
        v-for="file in deviceStore.deviceFiles"
        :key="file.file"
        class="file-card"
      >
        <div class="file-info">
          <div class="file-name">
            {{ formatFileName(file.file) }}
          </div>
          <div class="file-meta">
            <span>{{ formatDuration(file.duration_ms) }}</span>
            <span class="meta-dot" />
            <span>{{ formatFileSize(file.size) }}</span>
            <span class="meta-dot" />
            <span>{{ formatDate(file.creat_time) }}</span>
          </div>
        </div>
        <div class="file-action">
          <div
            v-if="deviceStore.syncedFiles.includes(file.file)"
            class="synced-badge"
          >
            <q-icon
              name="check_circle"
              size="16px"
              color="positive"
            />
            <span>{{ $t('synced') }}</span>
          </div>
          <q-btn
            v-else-if="deviceStore.currentSyncFile === file.file"
            flat
            dense
            disable
          >
            <q-spinner-dots
              size="16px"
              color="primary"
            />
          </q-btn>
          <q-btn
            v-else
            flat
            dense
            color="primary"
            icon="download"
            :label="$t('syncNow')"
            no-caps
            :disable="deviceStore.isSyncing"
            @click="syncFile(file)"
          />
        </div>
      </div>
    </div>
  </q-page>
</template>

<script>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { useDeviceStore } from '../stores/device';
import { isCapacitor } from '../utils/platform';

export default {
  name: 'DevicePage',

  setup() {
    const $q = useQuasar();
    const { t } = useI18n();
    const deviceStore = useDeviceStore();
    const bleAvailable = ref(true);

    const batteryColor = computed(() => {
      if (deviceStore.batteryLevel > 50) return 'positive';
      if (deviceStore.batteryLevel > 20) return 'warning';
      return 'negative';
    });

    const startScan = async () => {
      try {
        await deviceStore.startScan();
      } catch (e) {
        $q.notify({ type: 'warning', message: e.message });
      }
    };

    const connectDevice = async (device) => {
      try {
        await deviceStore.connectAndPair(device.deviceId);
        $q.notify({ type: 'positive', message: t('deviceConnected') });
      } catch (e) {
        $q.notify({ type: 'negative', message: t('pairingFailed'), caption: e.message, timeout: 5000 });
      }
    };

    const reconnect = async () => {
      try {
        await deviceStore.autoConnect();
      } catch (e) {
        $q.notify({ type: 'negative', message: t('connectionFailed'), caption: e.message, timeout: 5000 });
      }
    };

    const disconnect = async () => {
      await deviceStore.disconnect();
    };

    const confirmForget = () => {
      $q.dialog({
        title: t('forgetDeviceTitle'),
        message: t('forgetDeviceMessage'),
        cancel: { flat: true, label: t('cancel') },
        ok: { color: 'negative', label: t('forgetDevice'), flat: true }
      }).onOk(async () => {
        await deviceStore.forgetDevice();
      });
    };

    const syncFile = async (file) => {
      try {
        await deviceStore.syncFile(file);
        $q.notify({ type: 'positive', message: t('syncComplete') });
      } catch (e) {
        $q.notify({ type: 'negative', message: t('syncFailed'), caption: e.message, timeout: 5000 });
      }
    };

    const syncAll = async () => {
      try {
        await deviceStore.syncAllNew();
        $q.notify({ type: 'positive', message: t('syncComplete') });
      } catch (e) {
        $q.notify({ type: 'negative', message: t('syncFailed'), caption: e.message, timeout: 5000 });
      }
    };

    const formatStorage = (kb) => {
      if (!kb) return '—';
      if (kb >= 1048576) return `${(kb / 1048576).toFixed(1)} GB`;
      if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`;
      return `${kb} KB`;
    };

    const formatDuration = (ms) => {
      if (!ms) return '0:00';
      const totalSec = Math.round(ms / 1000);
      const hours = Math.floor(totalSec / 3600);
      const minutes = Math.floor((totalSec % 3600) / 60);
      const seconds = totalSec % 60;
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m ${seconds}s`;
      return `${seconds}s`;
    };

    const formatFileSize = (bytes) => {
      if (!bytes) return '—';
      if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${bytes} B`;
    };

    const formatDate = (timestamp) => {
      if (!timestamp) return '';
      const d = new Date(timestamp * 1000);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (isToday) return time;

      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (d.toDateString() === yesterday.toDateString()) {
        return `${t('dateYesterday', { time })}`;
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
    };

    const formatFileName = (filename) => {
      const match = filename.match(/R(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
      if (match) {
        const [, y, m, d, h, min] = match;
        return `${d}.${m}.${y} ${h}:${min}`;
      }
      return filename.replace(/\.\w+$/, '');
    };

    onMounted(async () => {
      if (!isCapacitor()) {
        bleAvailable.value = false;
        return;
      }

      try {
        await deviceStore.initialize();
      } catch {
        bleAvailable.value = false;
        return;
      }

      // Auto-connect if we have a paired device
      if (deviceStore.hasPairedDevice && !deviceStore.isConnected) {
        try {
          await deviceStore.autoConnect();
          // autoConnect now starts auto-sync polling automatically
        } catch (e) {
          console.log('Auto-connect failed:', e.message);
        }
      }
    });

    onUnmounted(() => {
      // Polling continues in background — don't stop it when leaving the page
      // It will stop on disconnect
    });

    return {
      deviceStore,
      bleAvailable,
      batteryColor,
      startScan,
      connectDevice,
      reconnect,
      disconnect,
      confirmForget,
      syncFile,
      syncAll,
      formatStorage,
      formatDuration,
      formatFileSize,
      formatDate,
      formatFileName
    };
  }
};
</script>

<style lang="scss" scoped>
.device-page {
  padding: 24px 16px;
  max-width: 600px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 24px;

  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0 0 6px 0;
    color: #1e293b;
  }

  .text-subtitle {
    color: #64748b;
    font-size: 14px;
    margin: 0;
  }
}

// ========== Device Card ==========

.device-card {
  background: white;
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.device-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.device-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #94a3b8;
  transition: background 0.3s;

  &.connected {
    background: #22c55e;
    box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
  }
}

.status-text {
  font-size: 13px;
  font-weight: 500;
  color: #64748b;
}

.device-identity {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
}

.device-icon-wrapper {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  background: linear-gradient(135deg, #6366F1, #8B5CF6);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.device-name {
  font-size: 17px;
  font-weight: 600;
  color: #1e293b;
}

.device-sn {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 2px;
  font-family: 'JetBrains Mono', monospace;
}

.device-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #f8fafc;
  border-radius: 10px;
}

.device-stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: #334155;
}

.device-stat-divider {
  width: 1px;
  height: 16px;
  background: #e2e8f0;
}

.recording-active-badge {
  animation: pulse-recording-badge 1.5s ease-in-out infinite;
}

@keyframes pulse-recording-badge {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.connecting-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px;
  color: #6366F1;
  font-weight: 500;
  font-size: 14px;
}

// ========== Scan / Empty State ==========

.scan-state {
  background: white;
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  padding: 40px 24px;
  margin-bottom: 16px;
}

.scan-icon-wrapper {
  position: relative;
  width: 96px;
  height: 96px;
  margin: 0 auto 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.08);
  border-radius: 50%;
}

.scan-pulse {
  position: absolute;
  inset: -8px;
  border-radius: 50%;
  border: 2px solid rgba(99, 102, 241, 0.3);
  animation: scan-pulse-anim 1.5s ease-out infinite;
}

@keyframes scan-pulse-anim {
  0% { transform: scale(0.9); opacity: 1; }
  100% { transform: scale(1.4); opacity: 0; }
}

.empty-state {
  text-align: center;

  .empty-icon {
    font-size: 56px;
    color: #94a3b8;
    margin-bottom: 16px;
  }

  .empty-title {
    font-size: 18px;
    font-weight: 600;
    color: #1e293b;
    margin-bottom: 8px;
  }

  .empty-subtitle {
    color: #64748b;
    font-size: 14px;
    max-width: 280px;
    margin: 0 auto;
    line-height: 1.5;
  }
}

// ========== Scan Results ==========

.scan-results {
  margin-top: 16px;
  margin-bottom: 16px;
}

.scan-result-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover, &:active {
    background: #f8fafc;
    border-color: #6366F1;
  }
}

.scan-result-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.scan-result-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
}

.scan-result-name {
  font-size: 15px;
  font-weight: 500;
  color: #1e293b;
}

.scan-result-rssi {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 2px;
}

// ========== Sync Progress ==========

.sync-progress-banner {
  background: linear-gradient(90deg, #6366F1, #8B5CF6);
  border-radius: 12px;
  padding: 14px 18px;
  margin-bottom: 16px;
  color: white;
}

.sync-progress-header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 500;
}

.sync-status-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
  color: white;
  font-size: 14px;
  font-weight: 500;

  &.complete {
    background: #22c55e;
  }

  &.error {
    background: #ef4444;
  }

  .q-btn {
    margin-left: auto;
  }
}

// ========== Files Section ==========

.files-section {
  margin-top: 8px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: #1e293b;
  display: flex;
  align-items: center;
  gap: 8px;
}

.new-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  border-radius: 10px;
  background: #6366F1;
  color: white;
  font-size: 11px;
  font-weight: 600;
  padding: 0 6px;
}

.no-files {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px;
  color: #94a3b8;
  font-size: 14px;
}

.file-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 8px;
  transition: border-color 0.2s;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 15px;
  font-weight: 500;
  color: #1e293b;
}

.file-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 12px;
  color: #94a3b8;
  flex-wrap: wrap;
}

.meta-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #cbd5e1;
}

.file-action {
  flex-shrink: 0;
  margin-left: 12px;
}

.synced-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
  color: #22c55e;
}

// ========== Mobile Adjustments ==========

@media (max-width: 600px) {
  .device-page {
    padding: 20px 16px;
    padding-top: calc(20px + env(safe-area-inset-top));
  }

  .page-header h1 {
    font-size: 22px;
  }

  .gradient-btn {
    height: 48px;
    font-size: 15px;
    border-radius: 12px;
  }
}
</style>
