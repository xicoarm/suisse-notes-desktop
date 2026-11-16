// @vitest-environment node
/**
 * Main-process side of the "microphone is not heard" alert: a system
 * notification plus the dock or taskbar signal, so the warning reaches a
 * person whose app window is behind the meeting app. The signal must not
 * depend on the notification: the operating system may have notifications
 * switched off for the app.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { createMicrophoneAlert } = require('../../src-electron/microphone-alert');

const ALERT = { title: 'Microphone is not being heard', body: 'Microphone "Headset" has been silent since 09:42 (muted?).' };

function setup({ platform = 'win32', supported = true, focused = false, visible = true, minimized = false, bounceId = 7 } = {}) {
  const shown = [];
  class Notification extends EventEmitter {
    static isSupported() { return state.supported; }
    constructor(options) { super(); this.options = options; this.show = vi.fn(() => shown.push(this)); this.close = vi.fn(); }
  }
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => state.destroyed), isFocused: vi.fn(() => state.focused), isVisible: vi.fn(() => state.visible),
    isMinimized: vi.fn(() => state.minimized), restore: vi.fn(), show: vi.fn(), focus: vi.fn(), flashFrame: vi.fn(),
    webContents: { send: vi.fn() }
  });
  const dock = { bounce: vi.fn(() => bounceId), cancelBounce: vi.fn() };
  const state = { supported, focused, visible, minimized, destroyed: false, win };
  const log = { info: vi.fn(), warn: vi.fn() };
  const alert = createMicrophoneAlert({ Notification, getWindow: () => state.win, getDock: () => dock, platform, log });
  return { alert, shown, win, dock, state, log, Notification };
}

describe('microphone alert outside the app window', () => {
  it('shows one notification with the given title and text and flashes the taskbar button on Windows', () => {
    const { alert, shown, win, dock } = setup();
    expect(alert.show(ALERT)).toEqual({ success: true, shown: true, attention: true });
    expect(shown).toHaveLength(1);
    expect(shown[0].options).toEqual(ALERT);
    expect(win.flashFrame).toHaveBeenCalledWith(true);
    expect(dock.bounce).not.toHaveBeenCalled();
  });

  it('bounces the dock icon on macOS until the app is activated or the alert is cleared', () => {
    const { alert, shown, win, dock } = setup({ platform: 'darwin' });
    expect(alert.show(ALERT)).toEqual({ success: true, shown: true, attention: true });
    expect(dock.bounce).toHaveBeenCalledWith('critical');
    expect(win.flashFrame).not.toHaveBeenCalled();
    alert.clear();
    expect(dock.cancelBounce).toHaveBeenCalledWith(7);
    expect(shown[0].close).toHaveBeenCalledTimes(1);
  });

  it('still signals in the dock or taskbar when notifications are switched off or fail', () => {
    const off = setup({ supported: false });
    expect(off.alert.show(ALERT)).toEqual({ success: true, shown: false, attention: true });
    expect(off.shown).toHaveLength(0);
    expect(off.win.flashFrame).toHaveBeenCalledWith(true);

    const broken = setup({ platform: 'darwin' });
    const failing = createMicrophoneAlert({
      Notification: class { static isSupported() { return true; } constructor() { throw new Error('no notification service'); } },
      getWindow: () => broken.win, getDock: () => broken.dock, platform: 'darwin', log: broken.log
    });
    expect(failing.show(ALERT)).toEqual({ success: true, shown: false, attention: true });
    expect(broken.dock.bounce).toHaveBeenCalledWith('critical');
  });

  it('holds the alert while the window is focused and visible on the Record page, and shows it once the window loses the focus', () => {
    const { alert, shown, win, dock, state } = setup({ focused: true });
    expect(alert.show({ ...ALERT, onRecordPage: true })).toEqual({ success: true, shown: false, attention: false, inView: true });
    expect(alert.show({ ...ALERT, body: 'repeat', onRecordPage: true }).inView).toBe(true); // a repeat replaces the held one
    expect(shown).toHaveLength(0);
    expect(win.flashFrame).not.toHaveBeenCalled();
    expect(dock.bounce).not.toHaveBeenCalled();
    expect(win.listenerCount('blur')).toBe(1);

    state.focused = false; // the person switches to the meeting app
    win.emit('blur');
    expect(shown).toHaveLength(1);
    expect(shown[0].options).toEqual({ title: ALERT.title, body: 'repeat' });
    expect(win.flashFrame).toHaveBeenCalledWith(true);
    win.emit('blur');
    expect(shown).toHaveLength(1); // once

    // Held, then the microphone recovered: leaving the window shows nothing.
    state.focused = true;
    alert.show({ ...ALERT, onRecordPage: true });
    alert.clear();
    expect(win.listenerCount('blur')).toBe(0);
    win.emit('blur');
    expect(shown).toHaveLength(1);

    // Focused on another page: the in-app warning is not in view there.
    expect(alert.show({ ...ALERT, onRecordPage: false })).toEqual({ success: true, shown: true, attention: false });
    // Record page open, but the window is behind another app or minimized.
    state.focused = false;
    expect(alert.show({ ...ALERT, onRecordPage: true })).toEqual({ success: true, shown: true, attention: true });
    state.focused = true; state.minimized = true;
    expect(alert.show({ ...ALERT, onRecordPage: true }).shown).toBe(true);
    state.minimized = false; state.visible = false;
    expect(alert.show({ ...ALERT, onRecordPage: true }).shown).toBe(true);
  });

  it('replaces the previous notification on a repeat instead of stacking them', () => {
    const { alert, shown, win } = setup();
    alert.show(ALERT);
    alert.show({ ...ALERT, body: 'again' });
    expect(shown).toHaveLength(2);
    expect(shown[0].close).toHaveBeenCalledTimes(1);
    expect(shown[1].close).not.toHaveBeenCalled();
    expect(win.listenerCount('focus')).toBe(1);
    expect(win.flashFrame).toHaveBeenCalledTimes(2);
  });

  it('a click brings the window to the front and asks for the Record page', () => {
    const { alert, shown, win, state } = setup({ minimized: true });
    alert.show(ALERT);
    shown[0].emit('click');
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('system:show-record-page');

    state.destroyed = true; // window closed meanwhile: a late click does nothing
    expect(() => shown[0].emit('click')).not.toThrow();
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('stops flashing when the window gets the focus, and on clear', () => {
    const focusCase = setup();
    focusCase.alert.show(ALERT);
    focusCase.win.emit('focus');
    expect(focusCase.win.flashFrame).toHaveBeenLastCalledWith(false);
    expect(focusCase.win.listenerCount('focus')).toBe(0);

    const { alert, shown, win } = setup();
    alert.show(ALERT);
    expect(alert.clear()).toEqual({ success: true });
    expect(win.flashFrame).toHaveBeenLastCalledWith(false);
    expect(win.listenerCount('focus')).toBe(0);
    expect(shown[0].close).toHaveBeenCalledTimes(1);
    expect(() => alert.clear()).not.toThrow(); // nothing left: harmless
    expect(shown[0].close).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a window or without a text, and caps the text length', () => {
    const { alert, shown, state, win } = setup();
    expect(alert.show({ title: '   ', body: 'x' }).success).toBe(false);
    expect(alert.show(null).success).toBe(false);
    expect(alert.show({ title: 42, body: 'x' }).success).toBe(false);
    alert.show({ title: 'T'.repeat(500), body: 'B'.repeat(5000) });
    expect(shown[0].options.title).toHaveLength(120);
    expect(shown[0].options.body).toHaveLength(400);
    state.win = null;
    expect(alert.show(ALERT).success).toBe(false);
    state.win = win; state.destroyed = true;
    expect(alert.show(ALERT).success).toBe(false);
    expect(shown).toHaveLength(1);
  });

  it('never writes the microphone name into the log', () => {
    const { alert, log } = setup();
    alert.show(ALERT);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('Headset');
  });
});

// electron-main.js and the preload cannot be loaded outside Electron: check the wiring from source.
describe('microphone alert wiring (main process and preload)', () => {
  const main = fs.readFileSync('src-electron/electron-main.js', 'utf8').replace(/\r\n/g, '\n');
  const preload = fs.readFileSync('src-electron/electron-preload.js', 'utf8').replace(/\r\n/g, '\n');

  it('main creates the alert with its window and dock and serves both channels', () => {
    expect(main).toMatch(/createMicrophoneAlert\(\{ Notification, getWindow: \(\) => mainWindow, getDock: \(\) => app\.dock, log \}\)/);
    expect(main).toMatch(/ipcMain\.handle\('system:showMicrophoneAlert', \(event, alert\) => microphoneAlert\.show\(alert\)\)/);
    expect(main).toMatch(/ipcMain\.handle\('system:clearMicrophoneAlert', \(\) => microphoneAlert\.clear\(\)\)/);
  });

  it('main clears the alert when the recording is no longer in progress', () => {
    const handler = main.slice(main.indexOf("ipcMain.handle('recording:setInProgress'"), main.indexOf("ipcMain.handle('recording:setUnsavedAudio'"));
    expect(handler).toMatch(/else \{\s*destroyRecordingTray\(\);\s*microphoneAlert\.clear\(\);/);
  });

  it('the preload exposes the channels, and page cleanup keeps the click listener', () => {
    expect(preload).toContain("showMicrophoneAlert: (alert) => ipcRenderer.invoke('system:showMicrophoneAlert', alert)");
    expect(preload).toContain("clearMicrophoneAlert: () => ipcRenderer.invoke('system:clearMicrophoneAlert')");
    expect(preload).toContain("ipcRenderer.on('system:show-record-page', () => callback())");
    expect(preload).not.toContain("removeAllListeners('system:show-record-page')");
  });
});
