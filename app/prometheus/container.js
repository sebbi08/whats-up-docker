const { Gauge } = require('prom-client');
const storeContainer = require('../store/container');
const log = require('../log');
const { flatten } = require('../model/container');

let gaugeContainer;

/**
 * Populate gauge.
 */
function populateGauge() {
    gaugeContainer.reset();
    storeContainer.getContainers().forEach((container) => {
        try {
            gaugeContainer.set(flatten(container), 1);
        } catch (e) {
            log.warn(`${container.id} - Error when adding container to the metrics (${e.message})`);
            log.debug(e);
        }
    });
}

function init() {
    gaugeContainer = new Gauge({
        name: 'wud_containers',
        help: 'The watched containers',
        labelNames: [
            'id',
            'name',
            'watcher',
            'include_tags',
            'exclude_tags',
            'image_id',
            'image_registry_name',
            'image_registry_url',
            'image_name',
            'image_tag_value',
            'image_tag_semver',
            'image_digest_watch',
            'image_digest_value',
            'image_digest_repo',
            'image_architecture',
            'image_os',
            'image_variant',
            'image_created',
            'result_tag',
            'result_digest',
            'result_created',
            'update_available',
            'error_message',
        ],
    });
    log.debug('Start container metrics interval');
    setInterval(populateGauge, 5000);
    populateGauge();
    return gaugeContainer;
}

module.exports = {
    init,
};
