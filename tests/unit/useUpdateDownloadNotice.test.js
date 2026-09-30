import { describe, expect, it, vi } from 'vitest';
import { useUpdateDownloadNotice } from '../../src/composables/useUpdateDownloadNotice';

function setup({ blocking = false } = {}) {
  const state = { blocking };
  const notices = [];
  const notify = vi.fn(options => {
    const notice = { options, updates: [], closed: false };
    notices.push(notice);
    return props => { if (props) notice.updates.push(props); else notice.closed = true; };
  });
  const t = (key, params) => (params ? `${key}:${params.version}:${params.percent}` : key);
  const notice = useUpdateDownloadNotice({ notify, t, isBlocking: () => state.blocking });
  return { notice, notices, notify, state };
}

describe('update download notice', () => {
  it('appears as soon as an update is found and shows its progress in whole percent', () => {
    const { notice, notices } = setup();
    notice.downloading('4.7.12');
    expect(notices).toHaveLength(1);
    expect(notices[0].options).toMatchObject({ timeout: 0, position: 'top', message: 'updateDownloadingTitle',
      caption: 'updateDownloadingMessage:4.7.12:0' });
    notice.downloading('4.7.12', 12.4);
    notice.downloading('4.7.12', 12.9); // same whole percent: no redraw
    notice.downloading('4.7.12', 57.2);
    expect(notices[0].updates.map(update => update.caption)).toEqual(['updateDownloadingMessage:4.7.12:12', 'updateDownloadingMessage:4.7.12:57']);
    notice.downloading('4.7.12'); // a repeated "available" keeps the known progress
    expect(notices).toHaveLength(1);
  });

  it('closes when the download is done (the install prompt takes over) or fails', () => {
    const { notice, notices } = setup();
    notice.downloading('4.7.12', 40);
    notice.done();
    expect(notices[0].closed).toBe(true);
  });

  it('never appears during a recording, save or upload, and returns afterwards', () => {
    const { notice, notices, state } = setup({ blocking: true });
    notice.downloading('4.7.12', 20);
    expect(notices).toHaveLength(0);
    state.blocking = false;
    notice.refresh();
    expect(notices).toHaveLength(1);
    state.blocking = true;
    notice.refresh();
    expect(notices[0].closed).toBe(true);
  });

  it('stays closed for a version the user dismissed, but shows the next version', () => {
    const { notice, notices } = setup();
    notice.downloading('4.7.12', 10);
    notices[0].options.actions[0].handler();
    notice.downloading('4.7.12', 80);
    notice.refresh();
    expect(notices).toHaveLength(1);
    notice.downloading('4.7.13', 5);
    expect(notices).toHaveLength(2);
  });

  it('ignores progress without a version', () => {
    const { notice, notify } = setup();
    notice.downloading(null, 50);
    expect(notify).not.toHaveBeenCalled();
  });
});
