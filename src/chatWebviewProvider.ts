import * as vscode from 'vscode';
import { GeminiService, ChatMessage } from './geminiService';
import { ContextProvider } from './contextProvider';

export interface Suggestion {
    id: string;
    content: string;
    type: 'code' | 'text';
    accepted?: boolean;
    declined?: boolean;
}

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private messages: ChatMessage[] = [];
    private suggestions: Map<string, Suggestion> = new Map();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly geminiService: GeminiService,
        private readonly contextProvider: ContextProvider
    ) {
        console.log('ChatWebviewProvider constructor called');
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        console.log('=== Resolving webview view ===');
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        console.log('HTML set for webview');

        // Set up message listener
        webviewView.webview.onDidReceiveMessage(
            async (data) => {
                console.log('=== Received message from webview ===');
                console.log('Message type:', data.type);
                console.log('Full data:', JSON.stringify(data));
                
                switch (data.type) {
                    case 'sendMessage':
                        console.log('Processing sendMessage with content:', data.message);
                        await this.handleUserMessage(data.message);
                        break;
                    case 'acceptSuggestion':
                        console.log('Processing acceptSuggestion:', data.suggestionId);
                        this.acceptSuggestion(data.suggestionId);
                        break;
                    case 'declineSuggestion':
                        console.log('Processing declineSuggestion:', data.suggestionId);
                        this.declineSuggestion(data.suggestionId);
                        break;
                    case 'applySuggestion':
                        console.log('Processing applySuggestion:', data.suggestionId);
                        await this.applySuggestionToEditor(data.suggestionId);
                        break;
                    case 'ready':
                        console.log('Webview is ready');
                        break;
                    default:
                        console.log('Unknown message type:', data.type);
                }
            },
            undefined,
            []
        );

        console.log('Message listener registered');
    }

    private async handleUserMessage(message: string) {
        console.log('=== handleUserMessage called ===');
        console.log('Message:', message);
        
        if (!message.trim()) {
            console.log('Message is empty, returning');
            return;
        }

        // Add user message to chat
        const userMessage: ChatMessage = {
            role: 'user',
            content: message,
            timestamp: Date.now()
        };
        
        this.messages.push(userMessage);
        console.log('User message added. Total messages:', this.messages.length);
        
        this.updateWebview();

        try {
            // Show loading state
            console.log('Setting loading state to true');
            this.postMessage({
                type: 'setLoading',
                loading: true
            });

            // Get custom context
            const customContext = this.contextProvider.getContextItems();
            console.log('Custom context items:', customContext.length);
            
            // Check if API key is configured
            if (!this.geminiService.isConfigured()) {
                throw new Error('Gemini API key is not configured. Please set it in the extension settings.');
            }
            
            console.log('Calling Gemini API...');
            // Generate AI response
            const response = await this.geminiService.generateResponse(
                this.messages,
                customContext
            );
            console.log('Received response from Gemini. Length:', response.length);

            // Add AI response to chat
            const aiMessage: ChatMessage = {
                role: 'assistant',
                content: response,
                timestamp: Date.now()
            };
            
            this.messages.push(aiMessage);
            console.log('AI message added. Total messages:', this.messages.length);

            // Check if response contains code and create suggestions
            this.extractSuggestions(response);

        } catch (error: any) {
            console.error('=== Error in handleUserMessage ===');
            console.error('Error:', error);
            console.error('Error message:', error.message);
            
            vscode.window.showErrorMessage(`AI Assistant Error: ${error.message}`);
            
            // Add error message to chat
            const errorMessage: ChatMessage = {
                role: 'assistant',
                content: `Sorry, I encountered an error: ${error.message}`,
                timestamp: Date.now()
            };
            this.messages.push(errorMessage);
        } finally {
            console.log('Setting loading state to false');
            this.postMessage({
                type: 'setLoading',
                loading: false
            });
            this.updateWebview();
        }
    }

    private extractSuggestions(response: string) {
        const codeBlockRegex = /```(\w+)?\n?([\s\S]*?)```/g;
        let match;
        
        while ((match = codeBlockRegex.exec(response)) !== null) {
            const suggestionId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
            const suggestion: Suggestion = {
                id: suggestionId,
                content: match[2].trim(),
                type: 'code'
            };
            
            this.suggestions.set(suggestionId, suggestion);
        }
    }

    public acceptSuggestion(suggestionId: string) {
        const suggestion = this.suggestions.get(suggestionId);
        if (suggestion) {
            suggestion.accepted = true;
            this.updateWebview();
            vscode.window.showInformationMessage('Suggestion accepted');
        }
    }

    public declineSuggestion(suggestionId: string) {
        const suggestion = this.suggestions.get(suggestionId);
        if (suggestion) {
            suggestion.declined = true;
            this.updateWebview();
            vscode.window.showInformationMessage('Suggestion declined');
        }
    }

    private async applySuggestionToEditor(suggestionId: string) {
        const suggestion = this.suggestions.get(suggestionId);
        if (!suggestion) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor to apply suggestion');
            return;
        }

        const selection = editor.selection;
        await editor.edit(editBuilder => {
            if (selection.isEmpty) {
                editBuilder.insert(selection.start, suggestion.content);
            } else {
                editBuilder.replace(selection, suggestion.content);
            }
        });

        this.acceptSuggestion(suggestionId);
        vscode.window.showInformationMessage('Suggestion applied to editor');
    }

    private updateWebview() {
        console.log('=== updateWebview called ===');
        if (this._view) {
            console.log('Posting updateChat message');
            console.log('Messages count:', this.messages.length);
            console.log('Suggestions count:', this.suggestions.size);
            
            this.postMessage({
                type: 'updateChat',
                messages: this.messages,
                suggestions: Array.from(this.suggestions.values()),
                contextCount: this.contextProvider.getContextCount()
            });
        } else {
            console.log('WARNING: _view is undefined');
        }
    }

    private postMessage(message: any) {
        if (this._view) {
            console.log('Posting message to webview:', message.type);
            this._view.webview.postMessage(message);
        } else {
            console.log('WARNING: Cannot post message, _view is undefined');
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini Assistant</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 10px;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .chat-container {
            flex: 1;
            overflow-y: auto;
            margin-bottom: 10px;
            padding: 5px;
            border: 1px solid var(--vscode-panel-border);
        }
        .message {
            margin-bottom: 10px;
            padding: 8px;
            border-radius: 4px;
        }
        .message.user {
            background-color: #2d5a7b;
            margin-left: 20px;
        }
        .message.assistant {
            background-color: #3a3d41;
            margin-right: 20px;
        }
        .input-container {
            display: flex;
            gap: 5px;
        }
        #messageInput {
            flex: 1;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        #sendButton {
            padding: 8px 16px;
            background-color: #0e639c;
            color: white;
            border: none;
            cursor: pointer;
        }
        #sendButton:hover {
            background-color: #1177bb;
        }
        #sendButton:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .loading {
            text-align: center;
            padding: 10px;
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="chat-container" id="chatContainer">
        <div style="padding: 10px; background: #2a2d2e; border-radius: 4px; margin-bottom: 10px;">
            Ready to chat! Click the button or press Enter to send.
        </div>
    </div>
    
    <div class="input-container">
        <input type="text" id="messageInput" placeholder="Type your message..." />
        <button id="sendButton">Send</button>
    </div>

    <script>
        (function() {
            console.log('Script starting...');
            
            // Acquire VS Code API
            const vscode = acquireVsCodeApi();
            console.log('VS Code API acquired');
            
            // Get DOM elements
            const chatContainer = document.getElementById('chatContainer');
            const messageInput = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            
            console.log('DOM elements:', {
                chatContainer: !!chatContainer,
                messageInput: !!messageInput,
                sendButton: !!sendButton
            });
            
            let isLoading = false;

            function sendMessage() {
                console.log('sendMessage called');
                const message = messageInput.value.trim();
                console.log('Message value:', message);
                
                if (message && !isLoading) {
                    console.log('Posting message to extension');
                    try {
                        vscode.postMessage({
                            type: 'sendMessage',
                            message: message
                        });
                        console.log('Message posted successfully');
                        messageInput.value = '';
                    } catch (error) {
                        console.error('Error posting message:', error);
                    }
                } else {
                    console.log('Message not sent. Empty:', !message, 'Loading:', isLoading);
                }
            }

            // Add event listeners
            console.log('Adding event listeners...');
            
            sendButton.addEventListener('click', function(e) {
                console.log('Button clicked!');
                sendMessage();
            });
            
            messageInput.addEventListener('keypress', function(e) {
                console.log('Key pressed:', e.key);
                if (e.key === 'Enter') {
                    e.preventDefault();
                    sendMessage();
                }
            });
            
            console.log('Event listeners added');

            // Listen for messages from extension
            window.addEventListener('message', function(event) {
                const message = event.data;
                console.log('Message from extension:', message.type);
                
                switch (message.type) {
                    case 'updateChat':
                        console.log('Updating chat with', message.messages.length, 'messages');
                        updateChat(message.messages);
                        break;
                    case 'setLoading':
                        console.log('Setting loading:', message.loading);
                        isLoading = message.loading;
                        sendButton.disabled = isLoading;
                        sendButton.textContent = isLoading ? 'Sending...' : 'Send';
                        
                        if (isLoading) {
                            const loadingDiv = document.createElement('div');
                            loadingDiv.className = 'loading';
                            loadingDiv.id = 'loadingIndicator';
                            loadingDiv.textContent = 'Thinking...';
                            chatContainer.appendChild(loadingDiv);
                        } else {
                            const loadingIndicator = document.getElementById('loadingIndicator');
                            if (loadingIndicator) {
                                loadingIndicator.remove();
                            }
                        }
                        break;
                }
            });

            function updateChat(messages) {
                let html = '<div style="padding: 10px; background: #2a2d2e; border-radius: 4px; margin-bottom: 10px;">Chat Messages: ' + messages.length + '</div>';
                
                messages.forEach(function(msg) {
                    const time = new Date(msg.timestamp).toLocaleTimeString();
                    const roleText = msg.role === 'user' ? 'You' : 'Assistant';
                    html += '<div class="message ' + msg.role + '">';
                    html += '<strong>' + roleText + '</strong> (' + time + ')<br>';
                    html += escapeHtml(msg.content);
                    html += '</div>';
                });
                
                chatContainer.innerHTML = html;
                chatContainer.scrollTop = chatContainer.scrollHeight;
            }

            function escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }

            // Send ready message
            messageInput.focus();
            console.log('Sending ready message');
            vscode.postMessage({ type: 'ready' });
            console.log('Script initialization complete');
        })();
    </script>
</body>
</html>`;
    }
}