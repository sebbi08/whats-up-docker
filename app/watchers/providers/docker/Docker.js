const fs = require('fs');
const Dockerode = require('dockerode');
const joi = require('joi-cron-expression')(require('joi'));
const cron = require('node-cron');
const parse = require('parse-docker-image-name');
const semver = require('semver');
const event = require('../../../event');
const store = require('../../../store');
const log = require('../../../log');
const Component = require('../../../registry/Component');
const Image = require('../../../model/Image');
const Result = require('../../../model/Result');
const registry = require('../../../registry');
const { getWatchImageGauge } = require('../../../prometheus/watcher');

/**
 * Return all supported registries
 * @returns {*}
 */
function getRegistries() {
    return registry.getState().registries;
}

/**
 * Process an Image Result.
 * @param imageWithResult
 */
function processImageResult(imageWithResult) {
    let imageToTrigger;
    let trigger = false;

    // Find image in db & compare
    const resultInDb = store.findImage(imageWithResult);

    // Not found in DB? => Save it
    if (!resultInDb) {
        log.debug(`Image watched for the first time (${JSON.stringify(imageWithResult)})`);
        imageToTrigger = store.insertImage(imageWithResult);
        if (imageWithResult.toBeUpdated) {
            trigger = true;
        } else {
            log.debug(`No result found (${JSON.stringify(imageWithResult)})`);
        }

        // Found in DB? => update it
    } else {
        imageToTrigger = store.updateImage(imageWithResult);
        trigger = !resultInDb.result.equals(imageToTrigger.result);
    }

    // Emit event only if new version not already emitted
    if (trigger) {
        log.debug(`New image version found (${JSON.stringify(imageWithResult)})`);
        event.emitImageNewVersion(imageToTrigger);
    } else {
        log.debug(`Result already processed => No need to trigger (${JSON.stringify(imageWithResult)})`);
    }
}

/**
 * Filter candidate tags (based on tag name).
 * @param image
 * @param tags
 * @returns {*}
 */
function getSemverTagsCandidate(image, tags) {
    let filteredTags = tags;

    // Match include tag regex
    if (image.includeTags) {
        const includeTagsRegex = new RegExp(image.includeTags);
        filteredTags = filteredTags.filter((tag) => includeTagsRegex.test(tag));
    }

    // Match exclude tag regex
    if (image.excludeTags) {
        const excludeTagsRegex = new RegExp(image.excludeTags);
        filteredTags = filteredTags.filter((tag) => !excludeTagsRegex.test(tag));
    }
    const currentTag = semver.coerce(image.tag);

    // Keep semver only
    filteredTags = filteredTags.filter((tag) => semver.valid(semver.coerce(tag)));

    // Apply semver sort desc
    filteredTags.sort((t1, t2) => {
        const greater = semver.gt(semver.coerce(t2), semver.coerce(t1));
        return greater ? 1 : -1;
    });

    // Keep only greater semver
    filteredTags = filteredTags.filter((tag) => semver.gt(semver.coerce(tag), currentTag));
    return filteredTags;
}

function normalizeImage(image) {
    const registryProvider = Object.values(getRegistries())
        .find((provider) => provider.match(image));
    if (!registryProvider) {
        log.warn(`No Registry Provider found for image ${JSON.stringify(image)}`);
        return {
            ...image,
            registry: 'unknown',
        };
    }
    return registryProvider.normalizeImage(image);
}

/**
 * Get the Docker Registry by name.
 * @param registryName
 */
function getRegistry(registryName) {
    const registryToReturn = getRegistries()[registryName];
    if (!registryToReturn) {
        throw new Error(`Unsupported Registry ${registryName}`);
    }
    return registryToReturn;
}

/**
 * Get old images to prune.
 * @param newImages
 * @param imagesFromTheStore
 * @returns {*[]|*}
 */
function getOldImages(newImages, imagesFromTheStore) {
    if (!imagesFromTheStore || !imagesFromTheStore) {
        return [];
    }
    return imagesFromTheStore.filter((imageFromStore) => {
        const isImageStillToWatch = newImages
            .find((newImage) => newImage.watcher === imageFromStore.watcher
                && newImage.registryUrl === imageFromStore.registryUrl
                && newImage.image === imageFromStore.image
                && newImage.tag === imageFromStore.tag
                && newImage.digest === imageFromStore.digest
                && newImage.includeTags === imageFromStore.includeTags
                && newImage.excludeTags === imageFromStore.excludeTags);
        return isImageStillToWatch === undefined;
    });
}

/**
 * Prune old images from the store.
 * @param newImages
 * @param imagesFromTheStore
 */
function pruneOldImages(newImages, imagesFromTheStore) {
    const imagesToRemove = getOldImages(newImages, imagesFromTheStore);
    imagesToRemove.forEach((imageToRemove) => store.deleteImage(imageToRemove.id));
}

/**
 * Get image digest.
 * @param containerImage
 * @returns {*} digest
 */
function getDigest(containerImage) {
    let digest = containerImage.Id;

    // Check if it's not an legacy v1 digest
    if (containerImage.Config.Image) {
        const digestSplit = containerImage.Config.Image.split(':');
        // Should looks like sha256:aaabbb... if not ? that's a v1 digest
        if (digestSplit.length === 1) {
            digest = containerImage.Config.Image;
        }
    }
    return digest;
}

/**
 * Docker Watcher Component.
 */
class Docker extends Component {
    getConfigurationSchema() {
        return joi.object().keys({
            socket: this.joi.string().default('/var/run/docker.sock'),
            host: this.joi.string(),
            port: this.joi.number().port().default(2375),
            cafile: this.joi.string(),
            certfile: this.joi.string(),
            keyfile: this.joi.string(),
            cron: joi.string().cron().default('0 * * * *'),
            watchbydefault: this.joi.boolean().default(true),
            watchall: this.joi.boolean().default(false),
        });
    }

    /**
     * Init the Watcher.
     */
    init() {
        this.initTrigger();
        log.info(`Schedule runner (${this.configuration.cron})`);
        cron.schedule(this.configuration.cron, () => this.watch());

        // Subscribe to image result events
        event.registerImageResult(processImageResult);

        // watch at startup
        this.watch();
    }

    initTrigger() {
        const options = {};
        if (this.configuration.host) {
            options.host = this.configuration.host;
            options.port = this.configuration.port;
            if (this.configuration.cafile) {
                options.ca = fs.readFileSync(this.configuration.cafile);
            }
            if (this.configuration.certfile) {
                options.cert = fs.readFileSync(this.configuration.certfile);
            }
            if (this.configuration.keyfile) {
                options.key = fs.readFileSync(this.configuration.keyfile);
            }
        } else {
            options.socketPath = this.configuration.socket;
        }
        this.dockerApi = new Dockerode(options);
    }

    /**
     * Watch main method.
     * @returns {Promise<*[]>}
     */
    async watch() {
        // List images to watch
        const imagesArray = await this.getImages();

        // Prune old images from the store
        const imagesFromTheStore = store.getImages({ watcher: this.getId() });
        pruneOldImages(imagesArray, imagesFromTheStore);

        const images = {};

        // map to K/V map to remove duplicate items
        imagesArray.forEach((image) => {
            const key = `${image.registry}_${image.image}_${image.tag}_${image.digest}_${image.includeTags}_${image.excludeTags}`;
            images[key] = image;
        });
        getWatchImageGauge().set({
            type: this.type,
            name: this.name,
        }, Object.keys(images).length);
        return Promise.all(Object.values(images).map((image) => this.watchImage(image)));
    }

    /**
     * Watch an Image.
     * @param image
     * @returns {Promise<*>}
     */
    async watchImage(image) {
        const imageWithResult = image;
        log.debug(`Check ${image.registryUrl}/${image.image}:${image.tag}`);

        try {
            imageWithResult.result = await this.findNewVersion(image);
        } catch (e) {
            imageWithResult.result = {
                error: e.message,
            };
        }
        event.emitImageResult(imageWithResult);
        return imageWithResult;
    }

    /**
     * Get all images to watch.
     * @returns {Promise<unknown[]>}
     */
    async getImages() {
        const listContainersOptions = {};
        if (this.configuration.watchall) {
            listContainersOptions.all = true;
        }
        const containers = await this.dockerApi.listContainers(listContainersOptions);
        const filteredContainers = containers

            // Filter containers on labels
            .filter((container) => {
                if (this.configuration.watchbydefault) {
                    return true;
                }
                const labels = container.Labels;
                return Object.keys(labels).find((labelName) => labelName.toLowerCase() === 'wud.watch') !== undefined;
            });
        const imagesPromises = filteredContainers
            .map((container) => {
                const labels = container.Labels;
                const includeTags = Object.keys(labels).find((labelName) => labelName.toLowerCase() === 'wud.tag.include') ? labels['wud.tag.include'] : undefined;
                const excludeTags = Object.keys(labels).find((labelName) => labelName.toLowerCase() === 'wud.tag.exclude') ? labels['wud.tag.exclude'] : undefined;
                return this.mapContainerToImage(container, includeTags, excludeTags);
            });
        const images = await Promise.all(imagesPromises);

        // Return defined images to process
        return images.filter((imagePromise) => imagePromise !== undefined);
    }

    /**
     * Find new version for an Image.
     */
    /* eslint-disable-next-line */
    async findNewVersion(image) {
        const registryProvider = getRegistry(image.registry);
        const result = new Result({ tag: undefined, digest: undefined });
        if (!registryProvider) {
            log.error(`Unsupported registry ${image.registry}`);
        } else {
            try {
                // Semver & non Server versions with digest -> Find if digest changed on registry
                result.digest = await registryProvider.getImageDigest(image);

                // Semver image -> find higher semver tag
                if (image.isSemver) {
                    const tagsResult = await registryProvider.getTags(image);

                    // Get candidates (based on tag name)
                    const semverTagsCandidate = getSemverTagsCandidate(image, tagsResult.tags);

                    // The first one in the array is the highest
                    if (semverTagsCandidate && semverTagsCandidate.length > 0) {
                        [result.tag] = semverTagsCandidate;
                    }
                }
                return result;
            } catch (e) {
                log.debug(e);
                return undefined;
            }
        }
    }

    /**
     * Map a Container Spec to an Image Model Object.
     * @param container
     * @param includeTags
     * @param excludeTags
     * @returns {Promise<Image>}
     */
    async mapContainerToImage(container, includeTags, excludeTags) {
        // Get container image details
        const containerImage = await this.dockerApi.getImage(container.Image).inspect();

        // Get useful properties
        const architecture = containerImage.Architecture;
        const os = containerImage.Os;
        const size = containerImage.Size;
        const creationDate = containerImage.Created;
        const digest = getDigest(containerImage);

        // Parse image to get registry, organization...
        let imageNameToParse = container.Image;
        if (imageNameToParse.includes('sha256:')) {
            if (!containerImage.RepoTags || containerImage.RepoTags.length === 0) {
                log.warn(`Cannot get a reliable tag for this image [${imageNameToParse}]`);
                return Promise.resolve();
            }
            // Get the first repo tag (better than nothing ;)
            [imageNameToParse] = containerImage.RepoTags;
        }
        const parsedImage = parse(imageNameToParse);
        const tag = parsedImage.tag || 'latest';
        const parsedTag = semver.coerce(tag);
        const isSemver = parsedTag !== null && parsedTag !== undefined;

        return normalizeImage(new Image({
            watcher: this.getId(),
            registryUrl: parsedImage.domain,
            image: parsedImage.path,
            tag,
            digest,
            versionDate: creationDate,
            isSemver,
            architecture,
            os,
            size,
            includeTags,
            excludeTags,
        }));
    }
}

module.exports = Docker;
