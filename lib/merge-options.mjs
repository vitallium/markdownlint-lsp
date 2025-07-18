// Copied from https://github.com/DavidAnson/markdownlint-cli2/blob/main/merge-options.mjs

/**
 * Merges two options objects by combining config and replacing properties.
 * @param {object} first First options object.
 * @param {object} second Second options object.
 * @returns {object} Merged options object.
 */
const mergeOptions = (first, second) => {
	const merged = {
		...first,
		...second,
	};
	const firstConfig = first?.config;
	const secondConfig = second?.config;
	if (firstConfig || secondConfig) {
		merged.config = {
			...firstConfig,
			...secondConfig,
		};
	}
	return merged;
};

export default mergeOptions;
