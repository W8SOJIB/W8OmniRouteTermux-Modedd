/** Pure helpers for deciding and driving the Electron dashboard window lifecycle. */

function shouldStartHidden({ argv = [], loginItemSettings = {} } = {}) {
  return (
    argv.includes("--hidden") ||
    argv.includes("--minimized") ||
    loginItemSettings.wasOpenedAsHidden === true
  );
}

function showOrCreateWindow({ appReady, getWindow, createWindow }) {
  if (!appReady) return null;

  const currentWindow = getWindow();
  if (!currentWindow || currentWindow.isDestroyed()) {
    return createWindow();
  }

  if (currentWindow.isMinimized()) currentWindow.restore();
  currentWindow.show();
  currentWindow.focus();
  return currentWindow;
}

module.exports = {
  shouldStartHidden,
  showOrCreateWindow,
};
