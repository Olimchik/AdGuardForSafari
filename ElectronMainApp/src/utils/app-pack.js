module.exports = (() => {
    const _resourcePath = function (resPath) {
        const path = require('path');
        // TODO check if this would work in production
        return path.join(process.cwd(), resPath);
    };

    return {
        resourcePath: _resourcePath,
    };
})();
