import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useMicSwitchNotifications } from '../../src/composables/useMicSwitchNotifications';

describe('microphone warning notification lifecycle', () => {
  let scope, micSwitchEvent, recordingHealth, recordId, notify, dismissals;
  beforeEach(() => {
    micSwitchEvent = ref(null);
    recordingHealth = ref({ status: 'critical', micActive: true, verifying: false });
    recordId = ref('meeting-one');
    dismissals = [];
    notify = vi.fn(() => { const dismiss = vi.fn(); dismissals.push(dismiss); return dismiss; });
    scope = effectScope();
    scope.run(() => useMicSwitchNotifications({
      notify, t: key => key, micSwitchEvent, recordingHealth, recordId
    }));
  });
  afterEach(() => scope.stop());

  async function silent() {
    micSwitchEvent.value = { ok: false, label: 'Conference microphone', context: 'manual-switch' };
    await nextTick();
  }

  it('dismisses the indefinite warning when signal returns without another microphone switch', async () => {
    await silent();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ timeout: 0, type: 'negative' }));
    recordingHealth.value = { status: 'ok', micActive: true, verifying: true };
    await nextTick();
    expect(dismissals[0]).not.toHaveBeenCalled();
    recordingHealth.value = { status: 'ok', micActive: false, verifying: false };
    await nextTick();
    expect(dismissals[0]).not.toHaveBeenCalled();
    recordingHealth.value = { status: 'ok', micActive: true, verifying: false };
    await nextTick();
    expect(dismissals[0]).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1); // Live recovery needs no extra switch-success toast.
  });

  it('keeps the warning for an unverified switch and dismisses it for verified automatic recovery', async () => {
    await silent();
    micSwitchEvent.value = { ok: true, unverified: true, context: 'manual-switch' };
    await nextTick();
    expect(dismissals[0]).not.toHaveBeenCalled();
    micSwitchEvent.value = { ok: true, context: 'auto-recovery' };
    await nextTick();
    expect(dismissals[0]).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1); // The page owns the separate automatic-switch notice.
  });

  it('replaces older silent warnings instead of leaving multiple permanent errors on screen', async () => {
    await silent();
    await silent();
    expect(dismissals[0]).toHaveBeenCalledTimes(1);
    expect(dismissals[1]).not.toHaveBeenCalled();
    micSwitchEvent.value = { ok: true, label: 'USB microphone', context: 'manual-switch' };
    await nextTick();
    expect(dismissals[1]).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'positive', message: 'micSwitchOkToast' }));
  });

  it('disposes stale warnings when a new meeting starts or the page unmounts', async () => {
    await silent();
    recordId.value = 'meeting-two';
    await nextTick();
    expect(dismissals[0]).toHaveBeenCalledTimes(1);
    await silent();
    scope.stop();
    expect(dismissals[1]).toHaveBeenCalledTimes(1);
    micSwitchEvent.value = { ok: false, context: 'manual-switch' };
    await nextTick();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
