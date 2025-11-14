import * as vscode from 'vscode';
import { ChatWebviewProvider } from './chatWebviewProvider';
import { ContextProvider } from './contextProvider';
import { GeminiService } from './geminiService';

let chatProvider: ChatWebviewProvider;
let contextProvider: ContextProvider;
let geminiService: GeminiService;

export function activate(context: vscode.ExtensionContext) {
    console.log('Gemini AI Assistant is now active!');

    geminiService = new GeminiService();
    contextProvider = new ContextProvider(context);
    chatProvider = new ChatWebviewProvider(context.extensionUri, geminiService, contextProvider);
    console.log('Chat provider created');

    const disposable = vscode.window.registerWebviewViewProvider(
        'geminiChat',
        chatProvider,
        {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        }
    );
    console.log('Webview provider registered');
    
    context.subscriptions.push(disposable);

    // Register tree data provider
    vscode.window.registerTreeDataProvider('geminiContext', contextProvider);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('geminiAssistant.openChat', () => {
            vscode.commands.executeCommand('workbench.view.extension.geminiAssistant');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('geminiAssistant.addContext', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter custom context',
                placeHolder: 'e.g., "Use TypeScript interfaces", "Follow React best practices"'
            });
            
            if (input) {
                contextProvider.addContext(input);
                vscode.window.showInformationMessage('Context added successfully!');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('geminiAssistant.clearContext', () => {
            contextProvider.clearContext();
            vscode.window.showInformationMessage('Context cleared!');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('geminiAssistant.acceptSuggestion', (suggestionId: string) => {
            chatProvider.acceptSuggestion(suggestionId);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('geminiAssistant.declineSuggestion', (suggestionId: string) => {
            chatProvider.declineSuggestion(suggestionId);
        })
    );

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('geminiAssistant.apiKey')) {
                geminiService.updateApiKey();
            }
        })
    );
}

export function deactivate() {
    console.log('Gemini AI Assistant deactivated');
}