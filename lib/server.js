import { lint } from "markdownlint/promise";
import {
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocumentSyncKind,
  TraceValues,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";

export class Server {
  #connection;
  #documents = new Map();
  #config = {
    default: true,
  };
  #trace = TraceValues.Off;

  constructor() {
    this.#connection = createConnection(ProposedFeatures.all);
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.#connection.onInitialize((params) => {
      this.#logTrace("Initializing server...");

      if (params.trace) {
        this.#trace = params.trace;
      }

      // Get initial configuration from initialization options
      const initializationOptions = params.initializationOptions || {};
      this.#config = { ...this.#config, ...initializationOptions.config };

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
            },
          },
        },
      };
    });

    this.#connection.onInitialized(() => {
      this.#logTrace("Server initialized.");
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
}
