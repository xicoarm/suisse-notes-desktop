// "Update loading (NN %) – install it before recording", shown from the moment
// an update is found. The install prompt can only appear once the whole
// installer is downloaded; until then users started recordings on the old
// version without knowing a fix was on its way. Never shown while a recording,
// its save or its upload is running, and not again for a version the user
// closed it for (the install prompt still follows when the download is done).
export function useUpdateDownloadNotice({ notify, t, isBlocking }) {
  let update = null;       // Quasar notify handle: update(props) changes it, update() closes it
  let shown = null;        // { version, percent } currently on screen
  let current = null;      // { version, percent } of the running download
  const closedVersions = new Set();

  const content = () => ({
    message: t('updateDownloadingTitle'),
    caption: t('updateDownloadingMessage', { version: current.version, percent: Math.floor(current.percent) }),
  });

  const hide = () => {
    const close = update;
    update = null;
    shown = null;
    close?.();
  };

  const render = () => {
    if (!current || isBlocking() || closedVersions.has(current.version)) {
      hide();
      return;
    }
    if (update && shown?.version === current.version) {
      if (Math.floor(shown.percent) !== Math.floor(current.percent)) {
        shown = { ...current };
        update(content());
      }
      return;
    }
    hide();
    const version = current.version;
    shown = { ...current };
    update = notify({
      type: 'info', icon: 'system_update_alt', position: 'top', timeout: 0, group: false, multiLine: true,
      ...content(),
      actions: [{ icon: 'close', color: 'white', round: true, handler: () => {
        closedVersions.add(version);
        update = null;
        shown = null;
      } }],
    });
  };

  return {
    // percent omitted: keep the known progress of the same version.
    downloading(version, percent) {
      if (!version) return;
      const known = current?.version === version ? current.percent : 0;
      current = { version, percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : known };
      render();
    },
    done() {
      current = null;
      hide();
    },
    refresh: render,
  };
}
