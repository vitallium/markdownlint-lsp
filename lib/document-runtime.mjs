import { TextDocument } from "vscode-languageserver-textdocument";

const NO_DOCUMENT = null;

export class DocumentRuntime {
	#documents = new Map();
	#validationDelay;
	#validationTimeouts = new Map();
	#latestVersionByUri = new Map();
	#validationInFlight = new Set();
	#queuedValidations = new Map();

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
		this.#documents.set(textDocument.uri, document);
		return document;
	}

	update(textDocument, contentChanges) {
		const document = this.#documents.get(textDocument.uri);
		if (!document) {
			return NO_DOCUMENT;
		}

		const updatedDocument = TextDocument.update(
			document,
			contentChanges,
			textDocument.version,
		);
		this.#documents.set(textDocument.uri, updatedDocument);
		this.#latestVersionByUri.set(textDocument.uri, updatedDocument.version);
		return updatedDocument;
	}

	save(uri) {
		this.#clearScheduledValidation(uri);
		return this.get(uri);
	}

	close(uri) {
		this.#documents.delete(uri);
		this.#latestVersionByUri.delete(uri);
		this.#queuedValidations.delete(uri);
		this.#validationInFlight.delete(uri);
		this.#clearScheduledValidation(uri);
	}

	get(uri) {
		return this.#documents.get(uri) ?? NO_DOCUMENT;
	}

	getAll() {
		return this.#documents.values();
	}

	scheduleValidation(document, onReady, delay = this.#validationDelay) {
		const uri = document.uri;
		this.#clearScheduledValidation(uri);

		const timeoutId = setTimeout(() => {
			this.#validationTimeouts.delete(uri);
			const currentDocument = this.#documents.get(uri);
			if (currentDocument) {
				onReady(currentDocument);
			}
		}, delay);

		this.#validationTimeouts.set(uri, timeoutId);
	}

	beginValidation(document) {
		const uri = document.uri;
		this.#clearScheduledValidation(uri);
		this.#latestVersionByUri.set(uri, document.version);

		if (this.#validationInFlight.has(uri)) {
			this.#queuedValidations.set(uri, document);
			return NO_DOCUMENT;
		}

		this.#validationInFlight.add(uri);
		return document;
	}

	finishValidation(uri) {
		this.#validationInFlight.delete(uri);
		const queuedDocument = this.#queuedValidations.get(uri);
		if (!queuedDocument) {
			return NO_DOCUMENT;
		}

		this.#queuedValidations.delete(uri);
		return queuedDocument;
	}

	hasLatestVersion(uri, version) {
		return this.#latestVersionByUri.get(uri) === version;
	}

	#clearScheduledValidation(uri) {
		const timeoutId = this.#validationTimeouts.get(uri);
		if (!timeoutId) {
			return;
		}

		clearTimeout(timeoutId);
		this.#validationTimeouts.delete(uri);
	}
}
