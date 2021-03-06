/* --------------------------------------------------------------------------------------------
 * Copyright (c) S-Core Co., Ltd. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import {
    LanguageClient, LanguageClientOptions, SettingMonitor, TransportKind,
    NotificationType, ErrorHandler,
    ErrorAction, CloseAction, State as ClientState,
    RevealOutputChannelOn, VersionedTextDocumentIdentifier, ExecuteCommandRequest, ExecuteCommandParams,
    DocumentSelector
} from 'vscode-languageclient';

import { CommandIds, Status, StatusNotification, StatusParams } from './types';

import disableRuleCodeActionProvider from './actions/disableRulesCodeActionProvider';
import showRuleCodeActionProvider from './actions/showRuleCodeActionProvider';

import { activateDecorations } from './deepscanDecorators';

const packageJSON = vscode.extensions.getExtension('DeepScan.vscode-deepscan').packageJSON;

// For the support of '.vue' support by languageIds, 'vue' language should be installed.
//const languageIds = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue'];
const DEFAULT_FILE_SUFFIXES = ['.js', '.jsx', '.ts', '.tsx', '.vue'];

let supportedFileSuffixes: string[] = null;
let fileSuffixes: string[] = null;

const exitCalled = new NotificationType<[number, string], void>('deepscan/exitCalled');

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    const workspaceRootPath = vscode.workspace.rootPath;
    if (!workspaceRootPath) {
        return;
    }

    activateClient(context);
    console.log(`Congratulations, your extension "${packageJSON.name} ${packageJSON.version}" is now active!`);
}

async function activateClient(context: vscode.ExtensionContext) {
    let statusBarMessage: vscode.Disposable = null;

    function updateStatus(status: Status) {
        let tooltip = statusBarItem.tooltip;
        switch (status) {
            case Status.none:
                statusBarItem.color = undefined;
                break;
            case Status.ok:
                statusBarItem.color = 'lightgreen';
                tooltip = 'Issue-free!';
                break;
            case Status.warn:
                statusBarItem.color = 'yellow';
                tooltip = 'Issue(s) detected!';
                break;
            case Status.fail:
                statusBarItem.color = 'darkred';
                tooltip = 'Inspection failed!';
                break;
        }
        statusBarItem.tooltip = tooltip;
        deepscanStatus = status;
        updateStatusBar(vscode.window.activeTextEditor);
    }

    function clearNotification() {
        if (statusBarMessage) {
            statusBarMessage.dispose();
        }
    }

    function showNotificationIfNeeded(params: StatusParams) {
        clearNotification();

        if (params.state === Status.fail) {
            statusBarMessage = vscode.window.setStatusBarMessage(`A problem occurred communicating with DeepScan server. (${params.error})`);
        }
    }

    function updateStatusBar(editor: vscode.TextEditor): void {
        let show = serverRunning &&
                   (deepscanStatus === Status.fail || (editor && _.includes(supportedFileSuffixes, path.extname(editor.document.fileName))));
        showStatusBarItem(show);
    }

    function showStatusBarItem(show: boolean): void {
        if (show) {
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    }

    function changeConfiguration(): void {
        clearNotification();

        let oldFileSuffixes = fileSuffixes;

        initializeSupportedFileSuffixes(getDeepScanConfiguration());
        // NOTE:
        // To apply changed file suffixes directly, documentSelector of LanguageClient should be changed.
        // But it seems to be impossible, so VS Code needs to restart.
        if (!_.isEqual(fileSuffixes, oldFileSuffixes)) {
            const reload = 'Reload Now';
            vscode.window.showInformationMessage('Restart VS Code before the new \'deepscan.fileSuffixes\' setting will take affect.', ...[reload])
                         .then(selection => {
                             if (selection === reload) {
                                 vscode.commands.executeCommand('workbench.action.reloadWindow');
                             }
                         });;
        }
    }

    function getFileSuffixes(configuration: vscode.WorkspaceConfiguration): string[] {
        return configuration ? configuration.get('fileSuffixes', []) : [];
    }

    function initializeSupportedFileSuffixes(configuration: vscode.WorkspaceConfiguration): void {
        fileSuffixes = getFileSuffixes(configuration);
        supportedFileSuffixes = _.union(DEFAULT_FILE_SUFFIXES, fileSuffixes);
    }

    let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    let deepscanStatus: Status = Status.ok;
    let serverRunning: boolean = false;

    statusBarItem.text = 'DeepScan';
    statusBarItem.command = CommandIds.showOutput;

    vscode.window.onDidChangeActiveTextEditor(updateStatusBar);
    updateStatusBar(vscode.window.activeTextEditor);

    // We need to go two levels up since an extension compile the js code into the output folder.
    let serverModule = path.join(__dirname, '..', '..', 'server', 'src', 'server.js');
    let debugOptions = { execArgv: ["--nolazy", "--debug=6004"] };
    let serverOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    let configuration = getDeepScanConfiguration();
    // Support other file suffixes other than DeepScan server supports.
    initializeSupportedFileSuffixes(configuration);

    let defaultErrorHandler: ErrorHandler;
    let serverCalledProcessExit: boolean = false;
    let staticDocuments: DocumentSelector = _.map(supportedFileSuffixes, fileSuffix => ({ scheme: 'file', pattern: `**/*${fileSuffix}` }));
    let clientOptions: LanguageClientOptions = {
        documentSelector: staticDocuments,
        diagnosticCollectionName: 'deepscan',
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        synchronize: {
            // Synchronize the setting section 'deepscan' to the server
            configurationSection: 'deepscan'
        },
        initializationOptions: () => {
            const defaultUrl = 'https://deepscan.io';
            return {
                server: configuration ? configuration.get('server', defaultUrl) : defaultUrl,
                DEFAULT_FILE_SUFFIXES,
                fileSuffixes: getFileSuffixes(configuration),
                userAgent: `${packageJSON.name}/${packageJSON.version}`
            };
        },
        initializationFailedHandler: (error) => {
            client.error('Server initialization failed.', error);
            client.outputChannel.show(true);
            return false;
        },
        errorHandler: {
            error: (error, message, count): ErrorAction => {
                return defaultErrorHandler.error(error, message, count);
            },
            closed: (): CloseAction => {
                if (serverCalledProcessExit) {
                    return CloseAction.DoNotRestart;
                }
                return defaultErrorHandler.closed();
            }
        }
    };

    let client = new LanguageClient('DeepScan', serverOptions, clientOptions);
    defaultErrorHandler = client.createDefaultErrorHandler();
    const running = 'DeepScan server is running.';
    const stopped = 'DeepScan server stopped.';
    client.onDidChangeState((event) => {
        if (event.newState === ClientState.Running) {
            client.info(running);
            statusBarItem.tooltip = running;
            serverRunning = true;
        } else {
            client.info(stopped);
            statusBarItem.tooltip = stopped;
            serverRunning = false;
        }
        updateStatusBar(vscode.window.activeTextEditor);
    });
    client.onReady().then(() => {
        console.log('Client is ready.');

        let { updateDecorations, disposables } = activateDecorations(client);
        context.subscriptions.push(disposables);

        client.onNotification(StatusNotification.type, (params) => {
            const { state, uri } = params;
            updateStatus(state);
            showNotificationIfNeeded(params);
            updateDecorations(uri);
        });

        client.onNotification(exitCalled, (params) => {
            serverCalledProcessExit = true;
            client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured setup.`, params[1]);
            vscode.window.showErrorMessage(`DeepScan server shut down. See 'DeepScan' output channel for details.`);
        });
    });

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    let inspectCommand = vscode.commands.registerCommand('deepscan.inspect', () => {
        let textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            return;
        }
        let textDocument: VersionedTextDocumentIdentifier = {
            uri: textEditor.document.uri.toString(),
            version: textEditor.document.version
        };
        let params: ExecuteCommandParams = {
            command: 'deepscan.tryInspect',
            arguments: [textDocument]
        }

        client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, (error) => {
            console.error('Server failed', error);
            vscode.window.showErrorMessage('Failed to inspect. Please consider opening an issue with steps to reproduce.');
        });
    });

    let rules = [];
    try {
        let rulesObj = JSON.parse(fs.readFileSync(path.resolve(context.extensionPath, 'resources', 'deepscan-rules.json')).toString());
        rules = rulesObj.rules;
    } catch (e) {
        vscode.window.showWarningMessage(`Can't read or parse rule definitions: ${e.message}`);
    }

    let style: string = '';
    try {
        style = fs.readFileSync(path.resolve(context.extensionPath, 'resources', 'style.css')).toString();
    } catch (e) {
        vscode.window.showWarningMessage(`Can't read a style: ${e.message}`);
    }

    // Register code actions
    const showRuleAction = new showRuleCodeActionProvider(context, {rules, style});
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(clientOptions.documentSelector, showRuleAction));
    const disableRulesAction = new disableRuleCodeActionProvider(context);
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(clientOptions.documentSelector, disableRulesAction));

    context.subscriptions.push(
        new SettingMonitor(client, 'deepscan.enable').start(),
        inspectCommand,
        vscode.commands.registerCommand(CommandIds.showOutput, () => { client.outputChannel.show(); }),
        statusBarItem
    );

    vscode.workspace.onDidChangeConfiguration(changeConfiguration);

    await checkSetting();
}

async function checkSetting() {
    const config = getDeepScanConfiguration();
    const shouldIgnore = config.get('ignoreConfirmWarning') === true;

    if (shouldIgnore) {
        return;
    }

    if (config.get('enable') === true) {
        return;
    }

    const confirm = 'Confirm';
    const neverShowAgain = 'Don\'t show again';
    const choice = await vscode.window.showWarningMessage('Allow the DeepScan extension to transfer your code to the DeepScan server for inspection.', confirm, neverShowAgain);

    if (choice === confirm) {
        await config.update('enable', true, false);
    }
    else if (choice === neverShowAgain) {
        await config.update('ignoreConfirmWarning', true, false);
    }
}

function getDeepScanConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('deepscan');
}
