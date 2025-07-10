import { lint } from "markdownlint/promise";
import {
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocumentSyncKind,
  TraceValues,
  DidChangeWatchedFilesNotification,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { readConfig, MARKDOWNLINT_CLI2_CONFIG_FILENAMES } from "./config.js";

export class Server {
  #connection;
  #documents = new Map();
  #config = {
    default: true,
  };
  #trace = TraceValues.Off;
  #rootPath = null;
  #workspaceFolders = [];
  #initializationOptions = {};
  #hasDidChangeWatchedFilesCapability = false;
  #configCache = new Map();

  constructor() {
    this.#connection = createConnection(ProposedFeatures.all);
    this.setupEventHandlers();
  }
	setupEventHandlers() {
	  this.#connection.onInitialize(async (params) => {
	    this.#logTrace("Initializing server...");

	    this.#hasDidChangeWatchedFilesCapability =
	      params.capabilities.workspace?.didChangeWatchedFiles
	        ?.dynamicRegistration ?? false;

	  	this.#hasWorkspaceFoldersCapability =
	  		params.capabilities.workspace?.workspaceFolders ?? false;

	  	if (params.trace) {
	  	  this.#trace = params.trace;
	  	}

	    this.#rootPath = params.rootPath;
	    this.#workspaceFolders = params.workspaceFolders || [];
	    
	    const dir = this.#getWorkspaceRoot();
	    const loadedConfig = await this.#getCachedConfig(dir);

	    this.#initializationOptions = params.initializationOptions || {};
	    this.#config = {
	      ...this.#config,
	      ...loadedConfig,
	      ...this.#initializationOptions.config,
	    };

	    this.#logTrace(
	      `Initial configuration: ${JSON.stringify(this.#config)}`,
	      true,
	    );

	    return {
	      capabilities: {
	        textDocumentSync: TextDocumentSyncKind.Incremental,
	        workspace: {
	          workspaceFolders: {
	            supported: true,
	            changeNotifications: true,
	          },
	        },
	      },
	    };
	  });

	  this.#connection.onInitialized(() => {
	    this.#logTrace("Server initialized.");
	    if (this.#hasDidChangeWatchedFilesCapability) {
	      this.#connection.client.register(
	        DidChangeWatchedFilesNotification.type,
	        {
	          watchers: MARKDOWNLINT_CLI2_CONFIG_FILENAMES.map((pattern) => ({
	            globPattern: `**/${pattern}`,
	          })),
	        },
	      );
	    }
	  });

	  this.#connection.onDidChangeWatchedFiles(async () => {
	    this.#logTrace(
	      "Configuration file changed. Reloading and re-validating.",
	    );

	    // Clear cache when config files change
	    this.#configCache.clear();

	    const dir = this.#getWorkspaceRoot();
	    const loadedConfig = await this.#getCachedConfig(dir);

	    this.#config = {
	      default: true,
	      ...loadedConfig,
	      ...this.#initializationOptions.config,
	    };

	    try {
	      const settings =
	        await this.#connection.workspace.getConfiguration("markdownlint");
	      this.#config = { ...this.#config, ...settings };
	    } catch (error) {
	      this.#logTrace(`Could not fetch configuration from client: ${error}`);
	    }

	    this.#logTrace(
	      `Reloaded configuration: ${JSON.stringify(this.#config)}`,
	      true,
	    );

	    for (const document of this.#documents.values()) {
	      this.validateDocument(document);
	    }
	  });

	  this.#connection.onDidOpenTextDocument((params) => {
	    const document = TextDocument.create(
	      params.textDocument.uri,
	      params.textDocument.languageId,
	      params.textDocument.version,
	      params.textDocument.text,
	    );
	    this.#documents.set(params.textDocument.uri, document);
	    this.#logTrace(`Document opened: ${params.textDocument.uri}`);
	    this.validateDocument(document);
	  });

	  this.#connection.onDidChangeTextDocument((params) => {
	    const document = this.#documents.get(params.textDocument.uri);
	    if (document) {
	      const updatedDocument = TextDocument.update(
	        document,
	        params.contentChanges,
	        params.textDocument.version,
	      );
	      this.#documents.set(params.textDocument.uri, updatedDocument);
	      this.#logTrace(
	        `Document changed: ${params.textDocument.uri} v${params.textDocument.version}`,
	      );
	      this.validateDocument(updatedDocument);
	    }
	  });

	  this.#connection.onDidCloseTextDocument((params) => {
	    this.#documents.delete(params.textDocument.uri);
	    this.#connection.sendDiagnostics({
	      uri: params.textDocument.uri,
	      diagnostics: [],
	    });
	    this.#logTrace(`Document closed: ${params.textDocument.uri}`);
	  });

	  this.#connection.onDidChangeConfiguration(async () => {
	    this.#logTrace("Configuration changed. Re-validating all documents.");
	    try {
	      const settings =
	        await this.#connection.workspace.getConfiguration("markdownlint");
	      this.#config = { ...this.#config, ...settings };
	      this.#logTrace(
	        `New configuration: ${JSON.stringify(this.#config)}`,
	        true,
	      );
	      for (const document of this.#documents.values()) {
	        this.validateDocument(document);
	      }
	    } catch (error) {
	      this.#logTrace(`Error fetching configuration: ${error}`, true);
	    }
	  });

		if (this.#hasWorkspaceFoldersCapability) {
			this.setupWorkspaceEventHandlers();
		}
	}
	async validateDocument(document) {
	  if (document.languageId !== "markdown") {
	    this.#logTrace(`Unsupported languageId: ${document.languageId}`);
	    return;
	  }
	  this.#logTrace(`Validating: ${document.uri}`);

	  const content = document.getText();
	  const options = {
	    strings: {
	      [document.uri]: content,
	    },
	    config: this.#config,
	    handleRuleFailures: true,
	  };

	  try {
	    const results = await lint(options);
	    const issues = results[document.uri] || [];
	    const diagnostics = issues.map((issue) => {
	      const line = (issue.lineNumber || 1) - 1;
	      const [startChar, length] = issue.errorRange
	        ? [(issue.errorRange[0] || 1) - 1, issue.errorRange[1]]
	        : [0, 1];

	      return Diagnostic.create(
	        {
	          start: { line, character: startChar },
	          end: { line, character: startChar + length },
	        },
	        `${issue.ruleDescription} (${issue.ruleNames.join("/")})`,
	        DiagnosticSeverity.Warning,
	        issue.ruleNames[0],
	        "markdownlint",
	      );
	    });

	    this.#connection.sendDiagnostics({ uri: document.uri, diagnostics });
	    this.#logTrace(
	      `Sent ${diagnostics.length} diagnostics for ${document.uri}`,
	      true,
	    );
	  } catch (error) {
	    this.#logTrace(`Linting error for ${document.uri}: ${error}`, true);
	  }
	}
	listen() {
	  this.#connection.onNotification("$/setTrace", (params) => {
	    this.#trace = params.value;
	    this.#logTrace(`Trace level set to: ${this.#trace}`);
	  });
	  this.#connection.listen();
	  this.#logTrace("Server listening for connections.");
	}
	#logTrace(message, verbose = false) {
	  if (this.#trace === TraceValues.Off) {
	    return;
	  }
	  this.#connection.tracer.log(message, verbose ? "verbose" : undefined);
	}
	#getWorkspaceRoot() {
	  if (this.#workspaceFolders.length > 0) {
	    // Use the first workspace folder as the primary root
	    const firstFolder = this.#workspaceFolders[0];
	    // Convert file URI to path if needed
	    return firstFolder.uri.replace(/^file:\/\//, '');
	  }
	  return this.#rootPath ?? process.cwd();
	}
  #getWorkspaceFolderForDocument(documentUri) {
    for (const folder of this.#workspaceFolders) {
      if (documentUri.startsWith(folder.uri)) {
        return folder;
      }
    }
    return null;
  }
;
	#hasWorkspaceFoldersCapability = false
	setupWorkspaceEventHandlers() {
		this.#connection.workspace.onDidChangeWorkspaceFolders((event) => {
		  this.#logTrace("Workspace folders changed.");
		  
		  // Remove folders
		  for (const folder of event.removed) {
		    this.#workspaceFolders = this.#workspaceFolders.filter(
		      (f) => f.uri !== folder.uri
		    );
		  }
		  
		  // Add new folders
		  this.#workspaceFolders.push(...event.added);
		  
		  // Clear config cache when workspace folders change
		  this.#clearConfigCache();
		  
		  this.#logTrace(
		    `Updated workspace folders: ${this.#workspaceFolders.map(f => f.uri).join(", ")}`,
		    true
		  );
		});
	}
  async #getCachedConfig(dir) {
    if (this.#configCache.has(dir)) {
      this.#logTrace(`Using cached config for: ${dir}`, true);
      return this.#configCache.get(dir);
    }

    this.#logTrace(`Loading config for: ${dir}`, true);
    const config = await readConfig(dir, this.#logTrace.bind(this));
    this.#configCache.set(dir, config);
    return config;
  }
  #clearConfigCache() {
    this.#configCache.clear();
    this.#logTrace("Config cache cleared", true);
  }
}
