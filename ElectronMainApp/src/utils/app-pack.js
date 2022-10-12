const path = require('path');
const { app, ipcRenderer } = require('electron');

module.exports = (() => {
    const _resourcePath = function (resPath) {
        let base;
        if (app) {
            base = app.getAppPath();
        } else {
            base = ipcRenderer.sendSync('renderer-to-main', JSON.stringify({
                'type': 'getAppPath',
            }));
        }

        return path.join(base, resPath);
    };

    return {
        resourcePath: _resourcePath,
    };
})();
