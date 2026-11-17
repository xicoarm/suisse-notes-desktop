'use strict';

// A recording whose microphone is not heard (silent after the one automatic
// re-open, or lost and not recovered) was reported only inside the app window.
// In a meeting that window sits behind the meeting app, so nobody saw it. This
// carries the warning outside the window:
// - a system notification (title and text arrive translated from the renderer);
// - the platform's attention signal, which also works while the operating
//   system has notifications switched off for the app: the dock icon bounces
//   on macOS, the taskbar button flashes elsewhere.
// While the person demonstrably looks at the in-app warning (window focused and
// visible, Record page open) the alert is held and shown as soon as the window
// loses the focus. The renderer decides when an alert starts, repeats and ends;
// there is no timer here.
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 400;

function createMicrophoneAlert({ Notification, getWindow, getDock = () => null, platform = process.platform, log = null }) {
  let notification = null; // referenced so that a later click still arrives
  let bounceId = null;
  let flashing = null;     // { win, onFocus } while the taskbar button flashes
  let held = null;         // { win, onBlur } while the alert waits for the window to lose the focus

  const currentWindow = () => {
    const win = getWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  function stopAttention() {
    if (bounceId !== null) {
      try { getDock()?.cancelBounce(bounceId); } catch (e) { /* request already over */ }
      bounceId = null;
    }
    if (flashing) {
      const { win, onFocus } = flashing;
      flashing = null;
      try {
        if (!win.isDestroyed()) { win.removeListener('focus', onFocus); win.flashFrame(false); }
      } catch (e) { /* window gone */ }
    }
  }

  function release() {
    if (!held) return;
    const { win, onBlur } = held;
    held = null;
    try { if (!win.isDestroyed()) win.removeListener('blur', onBlur); } catch (e) { /* window gone */ }
  }

  function drawAttention(win) {
    if (win.isFocused()) return false;
    if (platform === 'darwin') {
      const dock = getDock();
      if (!dock) return false;
      if (bounceId !== null) dock.cancelBounce(bounceId);
      // 'critical' bounces until the app is activated or the alert is cleared.
      const id = dock.bounce('critical');
      bounceId = id >= 0 ? id : null;
      return bounceId !== null;
    }
    if (!flashing || flashing.win !== win) {
      stopAttention();
      const onFocus = () => stopAttention();
      flashing = { win, onFocus };
      win.once('focus', onFocus);
    }
    win.flashFrame(true);
    return true;
  }

  function closeNotification() {
    const shown = notification;
    notification = null;
    try { shown?.close(); } catch (e) { /* already gone */ }
  }

  function openRecordPage() {
    try {
      const win = currentWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('system:show-record-page');
    } catch (error) { log?.warn?.('Microphone alert: opening the Record page failed:', error); }
  }

  function present(win, title, body) {
    let attention = false;
    try { attention = drawAttention(win); } catch (error) { log?.warn?.('Microphone alert: attention signal failed:', error); }
    let shown = false;
    try {
      if (Notification.isSupported()) {
        closeNotification(); // a repeat replaces the previous one
        const next = new Notification({ title, body });
        next.on('click', openRecordPage);
        next.show();
        notification = next;
        shown = true;
      }
    } catch (error) { log?.warn?.('Microphone alert: notification failed:', error); }
    // The text names the microphone, which can carry a person's name: not logged.
    log?.info?.(`Microphone alert: notification ${shown ? 'shown' : 'not shown'}, attention signal ${attention ? 'on' : 'off'}`);
    return { success: true, shown, attention };
  }

  return {
    show(alert) {
      const title = typeof alert?.title === 'string' ? alert.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
      const body = typeof alert?.body === 'string' ? alert.body.trim().slice(0, MAX_BODY_LENGTH) : '';
      const win = currentWindow();
      if (!title || !win) return { success: false, error: !title ? 'No text' : 'No window' };
      release();
      if (alert.onRecordPage === true && win.isVisible() && !win.isMinimized() && win.isFocused()) {
        // The in-app warning is in view. Leaving the window must not wait for
        // the next repeat, so the alert follows the first loss of focus.
        const onBlur = () => {
          held = null;
          const current = currentWindow();
          if (current) present(current, title, body);
        };
        held = { win, onBlur };
        win.once('blur', onBlur);
        return { success: true, shown: false, attention: false, inView: true };
      }
      return present(win, title, body);
    },
    clear() {
      release();
      stopAttention();
      closeNotification();
      return { success: true };
    }
  };
}

module.exports = { createMicrophoneAlert };
