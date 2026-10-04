// Which microphone the desktop app records when the user leaves the choice on
// "Automatic" — the default:
//   1. the microphone a meeting app is recording from right now (Windows: the
//      system-audio helper lists which app uses which device),
//   2. the Windows communication microphone — where Teams and Zoom record by
//      default (the app used to take the plain default device, often the
//      laptop's microphone array while the call ran on a headset),
//   3. the system default, 4. the first real microphone.
// Always a concrete device: recording through the 'default'/'communications'
// aliases silently follows Windows to another device mid-meeting, and the
// capture checks require a physical device id.

export const AUTO_MICROPHONE = 'auto';

const isAlias = id => id === 'default' || id === 'communications';

// Loopback inputs carry the far end or the computer's own sound, never the user.
const LOOPBACK_INPUT = /\bstereo ?mix\b|what u hear|wave out mix|cable output|loopback/i;

// Process names (lowercase, without .exe) of apps whose microphone use means a call.
const MEETING_APPS = [
  [/^ms-teams|^msteams$|^teams$/, 'Microsoft Teams'],
  [/^zoom$|^cpthost$/, 'Zoom'],
  [/webex|^atmgr$|^ciscocollabhost$/, 'Webex'],
  [/^slack$/, 'Slack'],
  [/^discord$/, 'Discord'],
  [/^skype/, 'Skype'],
  [/^whatsapp/, 'WhatsApp'],
  [/^signal$/, 'Signal'],
  [/^g2m|gotomeeting/, 'GoTo Meeting'],
];
// A browser using the microphone is most likely a web meeting (Meet, Teams web).
const BROWSERS = [
  [/^chrome$/, 'Chrome'],
  [/^msedge$/, 'Edge'],
  [/^firefox$/, 'Firefox'],
  [/^brave$/, 'Brave'],
  [/^opera/, 'Opera'],
  [/^vivaldi$/, 'Vivaldi'],
  [/^arc$/, 'Arc'],
];

export function meetingApp(processName) {
  const name = String(processName || '').toLowerCase().replace(/\.exe$/, '');
  for (const [pattern, label] of MEETING_APPS) if (pattern.test(name)) return { name: label, browser: false };
  for (const [pattern, label] of BROWSERS) if (pattern.test(name)) return { name: label, browser: true };
  return null;
}

// Chromium names a Windows input like the Windows endpoint; USB devices can
// carry a " (vid:pid)" suffix.
function sameDevice(label, endpointName) {
  if (!label || !endpointName) return false;
  return label === endpointName || label.startsWith(`${endpointName} (`);
}

// The concrete input behind an alias: same group, and the alias label ends with
// the device label ("Communications - X" → "X"; the prefix is localized).
export function resolveAlias(inputs, aliasId) {
  const alias = inputs.find(device => device.deviceId === aliasId);
  if (!alias) return null;
  let matches = inputs.filter(device => device.deviceId && !isAlias(device.deviceId) &&
    (!alias.groupId || !device.groupId || device.groupId === alias.groupId));
  if (matches.length > 1) {
    matches = matches.filter(device => device.label && alias.label &&
      (alias.label === device.label || alias.label.endsWith(` ${device.label}`)));
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * @param inputs   enumerateDevices() audio inputs, aliases included
 * @param sessions the helper's device sessions ({ flow, device, sessions }) or null
 * @param isVirtual predicate for virtual inputs (meeting-app drivers, cables)
 * @returns {{ deviceId, label, reason: 'meeting'|'communications'|'default'|'first', app? } | null}
 */
export function chooseAutomaticMicrophone(inputs, sessions, { isVirtual = () => false } = {}) {
  const concrete = (inputs || []).filter(device => device.deviceId && !isAlias(device.deviceId));
  if (!concrete.length) return null;

  const inUse = [];
  for (const device of sessions || []) {
    if (device?.flow !== 'input') continue;
    for (const session of device.sessions || []) {
      if (!session.active) continue;
      const app = meetingApp(session.app);
      if (!app) continue;
      const input = concrete.find(candidate => sameDevice(candidate.label, device.device));
      if (input && !LOOPBACK_INPUT.test(input.label)) inUse.push({ input, app });
    }
  }
  // A meeting app over a browser: the browser may be using the microphone for
  // something else, the meeting app means a call.
  inUse.sort((a, b) => Number(a.app.browser) - Number(b.app.browser));
  if (inUse.length) {
    return { deviceId: inUse[0].input.deviceId, label: inUse[0].input.label, reason: 'meeting', app: inUse[0].app.name };
  }

  for (const aliasId of ['communications', 'default']) {
    const input = resolveAlias(inputs, aliasId);
    if (input && !isVirtual(input) && !LOOPBACK_INPUT.test(input.label || '')) {
      return { deviceId: input.deviceId, label: input.label, reason: aliasId };
    }
  }

  const first = concrete.find(device => !isVirtual(device) && !LOOPBACK_INPUT.test(device.label || '')) || concrete[0];
  return { deviceId: first.deviceId, label: first.label, reason: 'first' };
}

// The user's choice, remembered on this computer: automatic, or a device they
// picked (by id; by name if Chromium's id for it ever changes).
const STORAGE_KEY = 'suisse-meets.microphone-choice';

export function readMicrophoneChoice(storage = globalThis.localStorage) {
  try {
    const stored = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    if (stored && typeof stored.deviceId === 'string' && stored.deviceId && !isAlias(stored.deviceId)) {
      return { mode: 'device', deviceId: stored.deviceId, label: typeof stored.label === 'string' ? stored.label : '' };
    }
  } catch (_) { /* unreadable or blocked storage: automatic */ }
  return { mode: AUTO_MICROPHONE };
}

export function storeMicrophoneChoice(choice, storage = globalThis.localStorage) {
  try {
    if (choice?.mode === 'device' && choice.deviceId) {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ deviceId: choice.deviceId, label: choice.label || '' }));
    } else {
      storage?.removeItem(STORAGE_KEY);
    }
  } catch (_) { /* private window or full storage: the choice lasts this session */ }
}

// The chosen device among the current ones ({ id, label } list), or null.
export function findChosenMicrophone(choice, microphones) {
  if (choice?.mode !== 'device') return null;
  return microphones.find(mic => mic.id === choice.deviceId) ||
    (choice.label ? microphones.find(mic => mic.label === choice.label) : null) || null;
}
