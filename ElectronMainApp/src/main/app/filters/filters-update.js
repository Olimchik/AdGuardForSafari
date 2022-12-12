const subscriptions = require('./subscriptions');
const cache = require('./cache');
const customFilters = require('./custom-filters');
const serviceClient = require('./service-client');
const listeners = require('../../notifier');
const events = require('../../events');
const settings = require('../settings-manager');
const versionUtils = require('../utils/version');
const log = require('../utils/log');
const storage = require('../storage/storage');

const FILTERS_UPDATE_LAST_CHECK_KEY = 'filters-update-last-check';

/**
 * Filters update service
 */
module.exports = (() => {
    'use strict';

    /**
     * Autoupdate timer
     */
    let filterAutoupdateTimer;

    /**
     * Delay before doing first filters update check -- 5 minutes
     */
    const UPDATE_FILTERS_DELAY = 5 * 60 * 1000;

    /**
     * Delay before doing filters reload -- 15 seconds
     */
    const RELOAD_FILTERS_DELAY = 15 * 1000;

    /**
     * TImeout for recently updated filters and again enabled filters - 5 minutes
     */
    const ENABLED_FILTERS_SKIP_TIMEOUT = 5 * 60 * 1000;

    /**
     * Schedules filters update job
     *
     * @param isFirstRun App first run flag
     * @private
     */
    const scheduleFiltersUpdate = (isFirstRun) => {
        // First run delay
        setTimeout(checkAntiBannerFiltersUpdate, UPDATE_FILTERS_DELAY, isFirstRun === true);

        // Scheduling job
        const updateFiltersPeriodInMs = settings.getUpdateFiltersPeriod() * 60 * 60 * 1000;
        const scheduleUpdate = () => {
            // User can disable autoupdate
            if (updateFiltersPeriodInMs <= 0) {
                return;
            }
            filterAutoupdateTimer = setTimeout(() => {
                try {
                    checkAntiBannerFiltersUpdate();
                } catch (ex) {
                    log.error('Error update filters, cause {0}', ex);
                }
                scheduleUpdate();
            }, updateFiltersPeriodInMs);
        };

        scheduleUpdate();
    };

    /**
     * Sets date of last filters updated check
     */
    const setFiltersUpdateLastCheck = (value) => {
        storage.setItem(FILTERS_UPDATE_LAST_CHECK_KEY, value);
    };

    /**
     * Gets date of last filters updated check
     */
    const getFiltersUpdateLastCheck = () => {
        return storage.getItem(FILTERS_UPDATE_LAST_CHECK_KEY);
    };

    /**
     * Checks filters updates.
     *
     * @param forceUpdate Normally we respect filter update period. But if this parameter is
     *                    true - we ignore it and check updates for all filters.
     * @param filters     Optional Array of filters to update
     */
    const checkAntiBannerFiltersUpdate = (forceUpdate, filters) => {
        const currentDate = new Date();
        setFiltersUpdateLastCheck(currentDate);
        const onSuccess = (updatedFilters) => {
            listeners.notifyListeners(events.UPDATE_FILTERS_SHOW_POPUP, {
                success: true,
                updatedFilters,
                forceUpdate,
                filtersUpdateLastCheck: currentDate,
            });
        };
        const onError = () => {
            listeners.notifyListeners(events.UPDATE_FILTERS_SHOW_POPUP, {
                success: false,
                forceUpdate,
                filtersUpdateLastCheck: currentDate,
            });
        };

        log.info('Start checking filters updates..');

        // Select filters for update
        const toUpdate = selectFilterIdsToUpdate(forceUpdate, filters);
        const filterIdsToUpdate = toUpdate.filterIds;
        const customFilterIdsToUpdate = toUpdate.customFilterIds;

        const totalToUpdate = filterIdsToUpdate.length + customFilterIdsToUpdate.length;
        if (totalToUpdate === 0) {
            onSuccess([]);
            return;
        }

        log.info('Checking updates for {0} filters', totalToUpdate);

        // Load filters with changed version
        const loadFiltersFromBackendCallback = (filterMetadataList) => {
            loadFiltersFromBackend(filterMetadataList, (success, filterIds) => {
                if (success) {
                    const filters = [];
                    for (let i = 0; i < filterIds.length; i += 1) {
                        const filter = cache.getFilter(filterIds[i]);
                        if (filter) {
                            filters.push(filter);
                        }
                    }

                    updateCustomFilters(customFilterIdsToUpdate, (customFilters) => {
                        onSuccess(filters.concat(customFilters));

                        log.info('Filters updated successfully');
                    });
                } else {
                    onError();
                }
            });
        };

        // Method is called after we have got server response
        // Now we check filters version and update filter if needed
        const onLoadFilterMetadataList = (success, filterMetadataList) => {
            if (success) {
                const filterMetadataListToUpdate = [];
                for (let i = 0; i < filterMetadataList.length; i += 1) {
                    const filterMetadata = subscriptions.createSubscriptionFilterFromJSON(filterMetadataList[i]);
                    const filter = cache.getFilter(filterMetadata.filterId);
                    if (filter && filterMetadata.version
                        && versionUtils.isGreaterVersion(filterMetadata.version, filter.version)) {
                        log.info('Updating filter {0} to version {1}', filter.filterId, filterMetadata.version);
                        filterMetadataListToUpdate.push(filterMetadata);
                    }
                }

                loadFiltersFromBackendCallback(filterMetadataListToUpdate);
            } else {
                onError();
            }
        };

        // Retrieve current filters metadata for update
        loadFiltersMetadataFromBackend(filterIdsToUpdate, onLoadFilterMetadataList);
    };

    /**
     * Loads filter versions from remote server
     *
     * @param filterIds Filter identifiers
     * @param callback Callback (called when load is finished)
     * @private
     */
    const loadFiltersMetadataFromBackend = (filterIds, callback) => {
        if (filterIds.length === 0) {
            callback(true, []);
            return;
        }

        const loadSuccess = function (filterMetadataList) {
            log.debug(
                'Retrieved response from server for {0} filters, result: {1} metadata',
                filterIds.length,
                filterMetadataList.length
            );
            callback(true, filterMetadataList);
        };

        const loadError = function (request, cause) {
            log.error(
                'Error retrieved response from server for filters {0}, cause: {1} {2}',
                filterIds,
                request.statusText,
                cause || ''
            );
            callback(false);
        };

        serviceClient.loadFiltersMetadata(filterIds, loadSuccess, loadError);
    };

    /**
     * Loads filters (ony-by-one) from the remote server
     *
     * @param filterMetadataList List of filter metadata to load
     * @param callback Called when filters have been loaded
     * @private
     */
    const loadFiltersFromBackend = (filterMetadataList, callback) => {
        const dfds = [];
        const loadedFilters = [];

        filterMetadataList.forEach((filterMetadata) => {
            const dfd = new Promise((resolve, reject) => {
                loadFilterRules(filterMetadata, true, (success) => {
                    if (!success) {
                        reject();
                        return;
                    }

                    loadedFilters.push(filterMetadata.filterId);
                    resolve();
                });
            });

            dfds.push(dfd);
        });

        Promise.all(dfds).then(() => {
            callback(true, loadedFilters);
        }, () => {
            callback(false);
        });
    };

    /**
     * Loads filter rules
     *
     * @param filterMetadata Filter metadata
     * @param forceRemote Force download filter rules from remote server
     * (if false try to download local copy of rules if it's possible)
     * @param callback Called when filter rules have been loaded
     * @private
     */
    const loadFilterRules = (filterMetadata, forceRemote, callback) => {
        const filter = cache.getFilter(filterMetadata.filterId);

        filter._isDownloading = true;
        listeners.notifyListeners(events.START_DOWNLOAD_FILTER, filter);

        const successCallback = function (filterRules) {
            log.info(
                'Retrieved response from server for filter {0}, rules count: {1}',
                filter.filterId,
                filterRules.length
            );
            delete filter._isDownloading;
            filter.version = filterMetadata.version;
            filter.lastUpdateTime = filterMetadata.timeUpdated;
            filter.lastCheckTime = Date.now();
            filter.loaded = true;
            // notify listeners
            listeners.notifyListeners(events.SUCCESS_DOWNLOAD_FILTER, filter);
            listeners.notifyListeners(events.UPDATE_FILTER_RULES, filter, filterRules);
            callback(true);
        };

        const errorCallback = function (cause) {
            log.error('Error retrieved response from server for filter {0}, cause: {1}', filter.filterId, cause || '');
            delete filter._isDownloading;
            listeners.notifyListeners(events.ERROR_DOWNLOAD_FILTER, filter);
            callback(false);
        };

        serviceClient.loadFilterRules(
            filter.filterId,
            forceRemote,
            true,
            successCallback,
            errorCallback
        );
    };

    /**
     * Select filters for update. It depends on the time of last update.
     *
     * @param forceUpdate Force update flag.
     * @param filtersToUpdate Optional array of filters
     * @returns object
     */
    const selectFilterIdsToUpdate = (forceUpdate, filtersToUpdate) => {
        const filterIds = [];

        const customFilterIds = customFilters.loadCustomFilters()
            .filter((f) => !filtersToUpdate || filtersToUpdate.find((x) => x.filterId === f.filterId))
            .filter((f) => f.enabled)
            .map((filter) => filter.filterId);

        const filters = filtersToUpdate || cache.getFilters();
        const updateFiltersPeriodInMs = settings.getUpdateFiltersPeriod() * 60 * 60 * 1000;

        for (const filter of filters) {
            if (filter.installed && filter.enabled) {
                // Check filters update period (or forceUpdate flag)
                const needUpdate = forceUpdate
                    || (!filter.lastCheckTime
                    || (Date.now() - filter.lastCheckTime) >= updateFiltersPeriodInMs);

                if (needUpdate) {
                    if (!filter.customUrl) {
                        filterIds.push(filter.filterId);
                    }
                }
            }
        }

        return {
            filterIds,
            customFilterIds,
        };
    };

    /**
     * Update filters with custom urls
     *
     * @param customFilterIds
     * @param callback
     */
    const updateCustomFilters = (customFilterIds, callback) => {
        if (customFilterIds.length === 0) {
            callback([]);
            return;
        }

        const dfds = [];
        const filters = [];
        for (let i = 0; i < customFilterIds.length; i += 1) {
            const filter = cache.getFilter(customFilterIds[i]);

            dfds.push((function (filter, filters) {
                return new Promise((resolve) => {
                    customFilters.updateCustomFilter(
                        filter,
                        (filterId) => {
                            if (filterId) {
                                filters.push(filter);
                            }

                            resolve();
                        }
                    );
                    listeners.notifyListeners(events.FILTER_ADD_REMOVE, filter);
                });
            })(filter, filters));
        }

        Promise.all(dfds).then(() => {
            log.info('Custom filters updated');
            callback(filters);
        });
    };

    /**
     * Force checks updates for specified filter
     *
     * @param filter
     */
    const checkFilterUpdate = (filter) => {
        if (!filter.enabled) {
            return;
        }

        // Skip recently downloaded filters
        if (Date.now() - filter.lastCheckTime < ENABLED_FILTERS_SKIP_TIMEOUT) {
            return;
        }

        checkAntiBannerFiltersUpdate(true, [filter]);
    };

    /**
     * Rerun filters autoupdate timer when period changes
     */
    const rerunAutoUpdateTimer = () => {
        if (filterAutoupdateTimer) {
            clearTimeout(filterAutoupdateTimer);
        }
        scheduleFiltersUpdate(false);
    };

    /**
     * Resets all filters versions
     */
    const resetFiltersVersion = () => {
        const RESET_VERSION = '0.0.0.0';

        const filters = cache.getFilters();
        for (const filter of filters) {
            log.debug('Reset version for filter {0}', filter.filterId);
            filter.version = RESET_VERSION;
        }
    };

    /**
     * Reloads filters from backend
     *
     * @private
     */
    const reloadAntiBannerFilters = () => {
        log.info('Schedule filters reload..');

        // Delay filters update
        setTimeout(() => {
            resetFiltersVersion();
            checkAntiBannerFiltersUpdate(true);
        }, RELOAD_FILTERS_DELAY);
    };

    return {
        checkAntiBannerFiltersUpdate,
        checkFilterUpdate,
        scheduleFiltersUpdate,
        loadFilterRules,
        rerunAutoUpdateTimer,
        reloadAntiBannerFilters,
        getFiltersUpdateLastCheck,
    };
})();
