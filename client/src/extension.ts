'use strict';

import * as fse from 'fs-extra';
import * as path from 'path';
import {
    commands,
    Disposable,
    ExtensionContext,
    MessageItem,
    OutputChannel,
    Progress,
    ProgressLocation,
    Uri,
    window,
    workspace,
    WorkspaceConfiguration
} from 'vscode';
import { UserCancelledError } from 'vscode-azureextensionui';
import {
    CancellationToken,
    DidChangeConfigurationNotification,
    LanguageClient,
    LanguageClientOptions,
    Middleware,
    Proposed,
    ProposedFeatures,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient';
import { extensionGlobalPath, ICheckStyleSettings } from './checkStyleSetting';
import { checkCodeWithCheckstyle } from './command/checkCodeWithCheckstyle';
import {
    setAutoCheckStatus,
    setCheckstyleConfig,
    setCheckstyleProperties,
    setCheckstyleVersion
} from './command/userSettings';
import { DialogResponses } from './DialogResponses';
import {
    CheckStatusNotification,
    DownloadStartNotification,
    DownloadStatus,
    DownloadStatusNotification,
    ICheckStatusParams,
    IDownloadParams,
    IServerStatusParams,
    IVersionInvalidParams,
    ServerStatusNotification,
    VersionInvalidNotification
} from './notifications';
import { StatusController } from './StatusController';

let client: LanguageClient;
let statusController: StatusController;

namespace Configuration {

    let configurationListener: Disposable;

    export function computeConfiguration(params: Proposed.ConfigurationParams, _token: CancellationToken, _next: Function): {}[] {
        if (!params.items) {
            return null;
        }
        const result: (ICheckStyleSettings | null)[] = [];
        for (const item of params.items) {
            if (item.section) {
                result.push(null);
                continue;
            }
            let config: WorkspaceConfiguration;
            if (item.scopeUri) {
                config = workspace.getConfiguration('checkstyle', client.protocol2CodeConverter.asUri(item.scopeUri));
            } else {
                config = workspace.getConfiguration('checkstyle');
            }
            result.push({
                autocheck: config.get<boolean>('autocheck', false),
                version: config.get<string>('version', '8.0'),
                configurationFile: config.get<string>('configurationFile', 'google_checks'),
                propertiesPath: config.get<string>('propertiesPath')
            });
        }
        return result;
    }

    export function initialize(): void {
        configurationListener = workspace.onDidChangeConfiguration(() => {
            client.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
        });
    }

    export function dispose(): void {
        if (configurationListener) {
            configurationListener.dispose();
        }
    }
}

export async function activate(context: ExtensionContext): Promise<void> {
    const resourcesPath: string = path.join(extensionGlobalPath, 'resources');
    await fse.ensureDir(resourcesPath);
    const outputChannel: OutputChannel = window.createOutputChannel('Checkstyle');
    statusController = new StatusController();

    initializeClient(context);

    client.onReady().then(() => {
        Configuration.initialize();
        registerClientListener();
    });

    window.onDidChangeActiveTextEditor(statusController.updateStatusBar, statusController);
    workspace.onDidCloseTextDocument(statusController.onDidCloseTextDocument, statusController);
    workspace.onDidChangeTextDocument(statusController.onDidChangeTextDocument, statusController);

    initCommand(context, outputChannel, 'checkstyle.checkCodeWithCheckstyle', () => checkCodeWithCheckstyle(client));
    initCommand(context, outputChannel, 'checkstyle.setVersion', (uri?: Uri) => setCheckstyleVersion(resourcesPath, uri));
    initCommand(context, outputChannel, 'checkstyle.setConfigurationFile', () => setCheckstyleConfig(context));
    initCommand(context, outputChannel, 'checkstyle.setPropertyFile', setCheckstyleProperties);
    initCommand(context, outputChannel, 'checkstyle.setAutocheck', setAutoCheckStatus);

    context.subscriptions.push(
        client.start()
    );
}

export function deactivate(): Thenable<void> {
    if (!client) {
        return undefined;
    }
    Configuration.dispose();
    if (statusController) {
        statusController.dispose();
    }
    return client.stop();
}

function initCommand(context: ExtensionContext, outputChannel: OutputChannel, commandId: string, callback: (...args: any[]) => any): void {
    context.subscriptions.push(commands.registerCommand(commandId, async (...args: any[]) => {
        try {
            await callback(...args);
        } catch (error) {
            if (error instanceof UserCancelledError) {
                // do nothing here
            } else {
                const errMsg: string = getErrorMessage(error);
                outputChannel.appendLine(errMsg);
                await window.showErrorMessage(errMsg);
            }
        }
    }));
}

function initializeClient(context: ExtensionContext): void {
    const serverModule: string = context.asAbsolutePath(path.join('server', 'server.js'));
    const debugOptions: {} = { execArgv: ['--nolazy', '--inspect=6009'] };

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    const middleware: ProposedFeatures.ConfigurationMiddleware | Middleware = {
        workspace: {
            configuration: Configuration.computeConfiguration
        }
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'java' }],
        middleware: <Middleware>middleware
    };

    client = new LanguageClient('checkstyle', 'Checkstyle', serverOptions, clientOptions);
    client.registerProposedFeatures();
}

function registerClientListener(): void {
    client.onNotification(DownloadStartNotification.notificationType, () => {
        window.withProgress({ location: ProgressLocation.Window }, async (p: Progress<{}>) => {
            return new Promise((resolve: () => void, reject: (e: Error) => void): void => {
                p.report({ message: 'Fetching the download link...' });
                client.onNotification(DownloadStatusNotification.notificationType, async (param: IDownloadParams) => {
                    switch (param.downloadStatus) {
                        case DownloadStatus.downloading:
                            p.report({ message: `Downloading checkstyle... ${param.percent}%` });
                            break;
                        case DownloadStatus.finished:
                            resolve();
                            break;
                        case DownloadStatus.error:
                            await window.showWarningMessage(getErrorMessage(param.error));
                            reject(param.error);
                            break;
                        default:
                            break;
                    }
                });
            });
        });
    });

    client.onNotification(VersionInvalidNotification.notificationType, async (param: IVersionInvalidParams) => {
        const message: string = 'The Checkstyle version does not exist on download server. Would you like to update it?';
        const result: MessageItem | undefined = await window.showWarningMessage(message, DialogResponses.yes, DialogResponses.cancel);
        if (result === DialogResponses.yes) {
            commands.executeCommand('checkstyle.setVersion', client.protocol2CodeConverter.asUri(param.uri));
        }
    });

    client.onNotification(CheckStatusNotification.notificationType, (params: ICheckStatusParams) => {
        statusController.updateStatusBar(window.activeTextEditor, params);
    });

    client.onNotification(ServerStatusNotification.notificationType, (params: IServerStatusParams) => {
        statusController.onServerStatusDidChange(params.status);
    });
}

function getErrorMessage(err: Error): string {
    let errorMessage: string = 'unknown error';
    if (typeof err.message === 'string') {
        errorMessage = <string>err.message;
    } else {
        errorMessage = err.toString();
    }
    return `Checkstyle Error: - '${errorMessage}'`;
}
