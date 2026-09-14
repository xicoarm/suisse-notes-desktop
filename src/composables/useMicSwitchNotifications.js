import { onScopeDispose, watch } from 'vue';

// The warning describes current microphone health. Keep its dismiss handle so
// a confirmed recovery cannot leave an indefinite "microphone is silent" toast
// covering a healthy recording. Recording metadata retains the earlier warning.
export function useMicSwitchNotifications({ notify, t, micSwitchEvent, recordingHealth, recordId }) {
  let dismissSilentWarning = null;
  const clearSilentWarning = () => {
    const dismiss = dismissSilentWarning;
    dismissSilentWarning = null;
    dismiss?.();
  };

  watch(micSwitchEvent, ev => {
    if (!ev) return;
    micSwitchEvent.value = null;
    if (ev.unverified) return;
    const device = ev.label || t('micGenericDevice');
    if (ev.ok) {
      clearSilentWarning();
      if (ev.context === 'auto-recovery') return;
      notify({ type: 'positive', message: t('micSwitchOkToast', { device }), icon: 'mic', timeout: 4000 });
      return;
    }
    clearSilentWarning();
    dismissSilentWarning = notify({
      type: 'negative', message: t('micSwitchSilentToast', { device }),
      icon: 'mic_off', timeout: 0, group: false,
      actions: [{ label: t('ok', 'OK'), color: 'white' }]
    });
  });

  // A silent device can recover without another device switch. Clear only
  // after the service's health monitor has actually declared its input healthy.
  watch(recordingHealth, health => {
    if (health?.status === 'ok' && health.micActive === true && !health.verifying) clearSilentWarning();
  });
  watch(recordId, clearSilentWarning);
  onScopeDispose(clearSilentWarning);
}
