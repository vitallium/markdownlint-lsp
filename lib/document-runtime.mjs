import { TextDocument } from "vscode-languageserver-textdocument";

const NO_DOCUMENT = null;

/**
 * Encapsulates all runtime state for a single document.
 * This consolidates the previously separate Maps and Sets for:
 * - document
 * - validation timeout
 * - latest version
 * - validation in-flight status
 * - queued validation
 */
class DocumentState {
	document = null;
	validationTimeout = null;
	latestVersion = null;
	inFlight = false;
	queuedDocument = null;

	constructor() {
		// Empty
	}
}

export class DocumentRuntime {
	#documents = new Map();
	#validationDelay;

	constructor(validationDelay) {
		this.#validationDelay = validationDelay;
	}

	setValidationDelay(validationDelay) {
		this.#validationDelay = validationDelay;
	}

	open(textDocument) {
		const document = TextDocument.create(
			textDocument.uri,
			textDocument.languageId,
			textDocument.version,
			textDocument.text,
		);
		let state = this.#documents.get(textDocument.uri);
		if (!state) {
			state = new DocumentState();
			this.#documents.set(textDocument.uri, state);
		}
		state.document = document;
		state.latestVersion = document.version;
		return document;
	}

	update(textDocument, contentChanges) {
		const state = this.#documents.get(textDocument.uri);
		if (!state || !state.document) {
			return NO_DOCUMENT;
		}

		const updatedDocument = TextDocument.update(
			state.document,
			contentChanges,
			textDocument.version,
		);
		state.document = updatedDocument;
		state.latestVersion = updatedDocument.version;
		return updatedDocument;
	}

	save(uri) {
		this.#clearScheduledValidation(uri);
		return this.get(uri);
	}

	close(uri) {
		const state = this.#documents.get(uri);
		if (state) {
			if (state.validationTimeout) {
				clearTimeout(state.validationTimeout);
				state.validationTimeout = null;
			}
		}
		this.#documents.delete(uri);
	}

	get(uri) {
		const state = this.#documents.get(uri);
		return state?.document ?? NO_DOCUMENT;
	}

	getAll() {
		const result = [];
		for (const state of this.#documents.values()) {
			if (state.document) {
				result.push(state.document);
			}
		}
		return result;
	}

	scheduleValidation(document, onReady, delay = this.#validationDelay) {
		const uri = document.uri;
		this.#clearScheduledValidation(uri);

		const timeoutId = setTimeout(() => {
			const state = this.#documents.get(uri);
			if (state) {
				state.validationTimeout = null;
			}
			const currentDocument = this.get(uri);
			if (currentDocument) {
				onReady(currentDocument);
			}
		}, delay);

		const state = this.#documents.get(uri);
		if (!state) {
			// Document was closed before timeout was set
			clearTimeout(timeoutId);
			return;
		}
		state.validationTimeout = timeoutId;
	}

	beginValidation(document) {
		const uri = document.uri;
		this.#clearScheduledValidation(uri);

		const state = this.#documents.get(uri);
		if (!state) {
			return NO_DOCUMENT;
		}
		state.latestVersion = document.version;

		if (state.inFlight) {
			state.queuedDocument = document;
			return NO_DOCUMENT;
		}

		state.inFlight = true;
		return document;
	}

	finishValidation(uri) {
		const state = this.#documents.get(uri);
		if (!state) {
			return NO_DOCUMENT;
		}

		state.inFlight = false;
		const queuedDocument = state.queuedDocument;
		if (!queuedDocument) {
			return NO_DOCUMENT;
		}

		state.queuedDocument = null;
		return queuedDocument;
	}

	hasLatestVersion(uri, version) {
		const state = this.#documents.get(uri);
		return state?.latestVersion === version;
	}

	#clearScheduledValidation(uri) {
		const state = this.#documents.get(uri);
		if (state?.validationTimeout) {
			clearTimeout(state.validationTimeout);
			state.validationTimeout = null;
		}
	}
}
