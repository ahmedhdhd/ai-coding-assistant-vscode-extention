import * as vscode from 'vscode';
import { AIService, ChatMessage } from './aiService';
import { ContextProvider } from './contextProvider';
import { AgentService } from './AgentService';
import { FileCreator } from './fileCreator';

export interface Suggestion {
    id: string;
    content: string;
    type: 'code' | 'text';
    accepted?: boolean;
    declined?: boolean;
    language?: string;
}

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private messages: ChatMessage[] = [];
    private suggestions: Map<string, Suggestion> = new Map();
    private fileCreator: FileCreator;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly aiService: AIService,
        private readonly contextProvider: ContextProvider,
        private readonly agentService: AgentService
    ) {
        console.log('ChatWebviewProvider constructor called');
        this.fileCreator = new FileCreator();
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
                    case 'createFile':
                        console.log('Processing createFile:', data.suggestionId);
                        await this.createFileFromSuggestion(data.suggestionId);
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
            if (!this.aiService.isConfigured()) {
                const providerName = this.aiService.getCurrentProviderName();
                throw new Error(`${providerName} API key is not configured. Please set it in the extension settings.`);
            }
            
            console.log('Calling AI API...');
            // Generate AI response
            const response = await this.aiService.generateResponse(
                this.messages,
                customContext
            );
            console.log('Received response from AI. Length:', response.length);

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
            
            // Check if response contains file creation requests
            console.log('Checking for file creation requests...');
            const filesToCreate = this.fileCreator.extractFileCreationRequests(response);
            console.log('Files detected:', filesToCreate.length);
            
            if (filesToCreate.length > 0) {
                // Prompt user to create files after a short delay
                setTimeout(() => {
                    this.fileCreator.promptFileCreation(filesToCreate);
                }, 500);
            }

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
        // Extract code blocks from the response
        const codeBlockRegex = /```(\w+)?\n?([\s\S]*?)```/g;
        let match;
        
        // Clear existing suggestions for this response
        this.suggestions.clear();
        
        while ((match = codeBlockRegex.exec(response)) !== null) {
            const suggestionId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
            const language = match[1] || 'text';
            const suggestion: Suggestion = {
                id: suggestionId,
                content: match[2].trim(),
                type: 'code',
                language: language
            };
            
            this.suggestions.set(suggestionId, suggestion);
        }
        
        console.log('Extracted', this.suggestions.size, 'code suggestions');
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

    private async createFileFromSuggestion(suggestionId: string) {
        const suggestion = this.suggestions.get(suggestionId);
        if (!suggestion) return;

        // Prompt for filename
        const filename = await vscode.window.showInputBox({
            prompt: 'Enter filename',
            placeHolder: `file.${suggestion.language || 'txt'}`,
            value: `file.${suggestion.language || 'txt'}`
        });

        if (!filename) return;

        const fileToCreate = {
            filename: filename,
            content: suggestion.content,
            language: suggestion.language || 'text'
        };

        await this.fileCreator.createFile(fileToCreate);
    }

    private updateWebview() {
        console.log('=== updateWebview called ===');
        if (this._view) {
            console.log('Posting updateChat message');
            console.log('Messages count:', this.messages.length);
            console.log('Suggestions count:', this.suggestions.size);
            
            const currentAgent = this.agentService.getCurrentAgent();
            
            this.postMessage({
                type: 'updateChat',
                messages: this.messages,
                suggestions: Array.from(this.suggestions.values()),
                contextCount: this.contextProvider.getContextCount(),
                agentName: currentAgent.name,
                agentIcon: currentAgent.icon
            });
        } else {
            console.log('WARNING: _view is undefined');
        }
    }

    public updateWebviewWithAgentInfo() {
        this.updateWebview();
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
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/11.1.1/marked.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 12px;
            height: 100vh;
            display: flex;
            flex-direction: column;
            line-height: 1.6;
        }
        
        .chat-container {
            flex: 1;
            overflow-y: auto;
            margin-bottom: 12px;
            padding: 4px;
            scroll-behavior: smooth;
        }
        
        .agent-header {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 10px 14px;
            border-radius: 6px;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 600;
        }
        
        .agent-icon {
            font-size: 1.2em;
        }
        
        .message {
            margin-bottom: 16px;
            padding: 12px 14px;
            border-radius: 8px;
            animation: fadeIn 0.3s ease-in;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .message.user {
            background: linear-gradient(135deg, #1e3a5f 0%, #2d5a7b 100%);
            margin-left: 20px;
            border-left: 3px solid #4a9eff;
        }
        
        .message.assistant {
            background: var(--vscode-editor-selectionBackground);
            margin-right: 20px;
            border-left: 3px solid var(--vscode-textLink-foreground);
        }
        
        .message-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            font-size: 0.85em;
            opacity: 0.8;
        }
        
        .message-role {
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .message-time {
            font-size: 0.9em;
        }
        
        .message-content {
            line-height: 1.6;
        }
        
        .message-content p {
            margin-bottom: 10px;
        }
        
        .message-content ul, .message-content ol {
            margin-left: 20px;
            margin-bottom: 10px;
        }
        
        .message-content li {
            margin-bottom: 4px;
        }
        
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 10px 0;
            border: 1px solid var(--vscode-panel-border);
        }
        
        .message-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }
        
        .message-content pre code {
            background: transparent;
            padding: 0;
            display: block;
        }
        
        .code-block-wrapper {
            position: relative;
            margin: 12px 0;
        }
        
        .code-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: var(--vscode-titleBar-activeBackground);
            padding: 6px 12px;
            border-radius: 6px 6px 0 0;
            font-size: 0.85em;
            border: 1px solid var(--vscode-panel-border);
            border-bottom: none;
        }
        
        .code-language {
            opacity: 0.7;
            text-transform: uppercase;
            font-weight: 600;
            letter-spacing: 0.5px;
        }
        
        .code-actions {
            display: flex;
            gap: 6px;
        }
        
        .code-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85em;
            transition: all 0.2s;
        }
        
        .code-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            transform: translateY(-1px);
        }
        
        .code-btn.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .code-btn.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .code-block-wrapper pre {
            margin: 0;
            border-radius: 0 0 6px 6px;
        }
        
        .input-container {
            display: flex;
            gap: 8px;
            background: var(--vscode-input-background);
            padding: 8px;
            border-radius: 8px;
            border: 1px solid var(--vscode-input-border);
        }
        
        #messageInput {
            flex: 1;
            padding: 10px 12px;
            border: none;
            background: transparent;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            outline: none;
        }
        
        #sendButton {
            padding: 10px 20px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.2s;
        }
        
        #sendButton:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
            transform: translateY(-1px);
        }
        
        #sendButton:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .loading {
            text-align: center;
            padding: 16px;
            opacity: 0.7;
            font-style: italic;
        }
        
        .loading::after {
            content: '...';
            animation: dots 1.5s steps(3, end) infinite;
        }
        
        @keyframes dots {
            0%, 20% { content: '.'; }
            40% { content: '..'; }
            60%, 100% { content: '...'; }
        }
        
        /* Scrollbar */
        .chat-container::-webkit-scrollbar {
            width: 10px;
        }
        
        .chat-container::-webkit-scrollbar-track {
            background: transparent;
        }
        
        .chat-container::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 5px;
        }
        
        .chat-container::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }
        
        .context-badge {
            display: inline-block;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 0.75em;
            margin-left: 8px;
        }
    </style>
</head>
<body>
    <div class="chat-container" id="chatContainer">
        <div class="agent-header" id="agentHeader">
            <span class="agent-icon">🤖</span>
            <span id="agentName">General Assistant</span>
            <span class="context-badge" id="contextBadge">0 context items</span>
        </div>
    </div>
    
    <div class="input-container">
        <input type="text" id="messageInput" placeholder="Ask me anything..." />
        <button id="sendButton">Send</button>
    </div>

    <script>
        (function() {
            console.log('=== Webview script starting ===');
            
            const vscode = acquireVsCodeApi();
            let isLoading = false;

            const chatContainer = document.getElementById('chatContainer');
            const messageInput = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            const agentName = document.getElementById('agentName');
            const contextBadge = document.getElementById('contextBadge');

            // Configure marked for better rendering
            marked.setOptions({
                breaks: true,
                gfm: true
            });

            function sendMessage() {
                console.log('sendMessage called');
                const message = messageInput.value.trim();
                
                if (message && !isLoading) {
                    console.log('Posting message to extension');
                    vscode.postMessage({
                        type: 'sendMessage',
                        message: message
                    });
                    messageInput.value = '';
                }
            }

            sendButton.addEventListener('click', sendMessage);
            
            messageInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });

            window.addEventListener('message', function(event) {
                const message = event.data;
                console.log('Message from extension:', message.type);
                
                switch (message.type) {
                    case 'updateChat':
                        updateChat(message.messages, message.suggestions, message.agentName, message.agentIcon, message.contextCount);
                        break;
                    case 'setLoading':
                        isLoading = message.loading;
                        sendButton.disabled = isLoading;
                        sendButton.textContent = isLoading ? 'Sending...' : 'Send';
                        
                        if (isLoading) {
                            const loadingDiv = document.createElement('div');
                            loadingDiv.className = 'loading';
                            loadingDiv.id = 'loadingIndicator';
                            loadingDiv.textContent = '🤖 Thinking';
                            chatContainer.appendChild(loadingDiv);
                            chatContainer.scrollTop = chatContainer.scrollHeight;
                        } else {
                            const loadingIndicator = document.getElementById('loadingIndicator');
                            if (loadingIndicator) {
                                loadingIndicator.remove();
                            }
                        }
                        break;
                }
            });

            function updateChat(messages, suggestions, currentAgentName, currentAgentIcon, contextCount) {
                // Update agent header
                agentName.textContent = currentAgentName || 'General Assistant';
                document.querySelector('.agent-icon').textContent = currentAgentIcon || '🤖';
                contextBadge.textContent = contextCount + ' context item' + (contextCount !== 1 ? 's' : '');
                
                // Build messages HTML
                let html = '';
                
                messages.forEach(function(msg, index) {
                    const time = new Date(msg.timestamp).toLocaleTimeString();
                    const roleText = msg.role === 'user' ? 'You' : (currentAgentName || 'Assistant');
                    
                    html += '<div class="message ' + msg.role + '">';
                    html += '<div class="message-header">';
                    html += '<span class="message-role">' + roleText + '</span>';
                    html += '<span class="message-time">' + time + '</span>';
                    html += '</div>';
                    html += '<div class="message-content">';
                    
                    if (msg.role === 'user') {
                        html += escapeHtml(msg.content);
                    } else {
                        html += formatMarkdown(msg.content, suggestions);
                    }
                    
                    html += '</div>';
                    html += '</div>';
                });
                
                chatContainer.innerHTML = '<div class="agent-header" id="agentHeader">' +
                    '<span class="agent-icon">' + (currentAgentIcon || '🤖') + '</span>' +
                    '<span id="agentName">' + (currentAgentName || 'General Assistant') + '</span>' +
                    '<span class="context-badge" id="contextBadge">' + contextCount + ' context item' + (contextCount !== 1 ? 's' : '') + '</span>' +
                    '</div>' + html;
                
                // Highlight code blocks
                chatContainer.querySelectorAll('pre code').forEach(function(block) {
                    hljs.highlightElement(block);
                });
                
                chatContainer.scrollTop = chatContainer.scrollHeight;
            }

            function formatMarkdown(content, suggestions) {
                // Parse markdown
                let html = marked.parse(content);
                
                // Wrap code blocks with actions
                const codeBlockRegex = /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g;
                let match;
                let index = 0;
                
                html = html.replace(codeBlockRegex, function(fullMatch, language, code) {
                    const suggestion = suggestions[index++];
                    if (!suggestion) return fullMatch;
                    
                    return '<div class="code-block-wrapper">' +
                        '<div class="code-header">' +
                        '<span class="code-language">' + (language || 'text') + '</span>' +
                        '<div class="code-actions">' +
                        '<button class="code-btn" onclick="copyCode(\'' + suggestion.id + '\')">Copy</button>' +
                        '<button class="code-btn primary" onclick="applyToEditor(\'' + suggestion.id + '\')">Apply</button>' +
                        '<button class="code-btn primary" onclick="createFile(\'' + suggestion.id + '\')">Create File</button>' +
                        '</div>' +
                        '</div>' +
                        '<pre><code class="language-' + language + '">' + code + '</code></pre>' +
                        '</div>';
                });
                
                return html;
            }

            window.copyCode = function(suggestionId) {
                console.log('Copy code:', suggestionId);
                vscode.postMessage({
                    type: 'acceptSuggestion',
                    suggestionId: suggestionId
                });
            };

            window.applyToEditor = function(suggestionId) {
                console.log('Apply to editor:', suggestionId);
                vscode.postMessage({
                    type: 'applySuggestion',
                    suggestionId: suggestionId
                });
            };

            window.createFile = function(suggestionId) {
                console.log('Create file:', suggestionId);
                vscode.postMessage({
                    type: 'createFile',
                    suggestionId: suggestionId
                });
            };

            function escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }

            messageInput.focus();
            vscode.postMessage({ type: 'ready' });
            console.log('=== Webview initialized ===');
        })();
    </script>
</body>
</html>`;
    }
}