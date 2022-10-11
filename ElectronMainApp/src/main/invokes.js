const { dialog, ipcMain } = require('electron');
const fs = require('fs');

const { InvokeType } = require('../common/invoke-type');

/**
 * Module handles invokes sent from renderer process
 */
class Invokes {
    static init() {
        ipcMain.handle(InvokeType.ExportFile, Invokes.onExportFile);
    }

    /**
     * onExportFile handles export file invoke
     * @param event
     * @param path
     * @param data
     * @returns {Promise<void>}
     */
    static async onExportFile(event, { path, data }) {
        const dialogResponse = await dialog.showSaveDialog({ defaultPath: path });
        await fs.promises.writeFile(dialogResponse.filePath.toString(), data);
    }
}

module.exports = {
    Invokes,
};
