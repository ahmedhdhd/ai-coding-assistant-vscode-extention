"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileCreator = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
class FileCreator {
    /**
     * Extract file creation requests from AI response
     * Looks for patterns like "create file.html:" or "save as file.js:"
     */
    extractFileCreationRequests(response) {
        const files = [];
        console.log('=== Extracting files from response ===');
        console.log('Response length:', response.length);
        // Pattern 1: Explicit "create filename" or "save as filename"
        const explicitPattern = /(?:create|save\s+(?:as|to)|make)\s+(?:a\s+file\s+)?(?:named\s+|called\s+)?[`'"]*([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`'"]*[:\s]/gi;
        let match;
        const explicitMatches = [];
        while ((match = explicitPattern.exec(response)) !== null) {
            explicitMatches.push(match[1].trim());
            console.log('Found explicit file mention:', match[1]);
        }
        // Pattern 2: Find all code blocks
        const codeBlockPattern = /```([a-zA-Z]*)\n([\s\S]*?)```/g;
        const codeBlocks = [];
        while ((match = codeBlockPattern.exec(response)) !== null) {
            codeBlocks.push({
                language: match[1] || '',
                content: match[2].trim(),
                index: match.index
            });
            console.log('Found code block:', match[1] || 'no-lang', 'at index', match.index);
        }
        // Pattern 3: Find filenames near code blocks (within 200 chars before)
        for (const block of codeBlocks) {
            const beforeBlock = response.substring(Math.max(0, block.index - 200), block.index);
            // Look for filename patterns
            const filenamePattern = /([a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+)/g;
            let filenameMatch;
            let lastFilename = '';
            while ((filenameMatch = filenamePattern.exec(beforeBlock)) !== null) {
                const potentialFilename = filenameMatch[1];
                if (this.isValidFilename(potentialFilename)) {
                    lastFilename = potentialFilename;
                }
            }
            // If we found a filename near this code block
            if (lastFilename) {
                console.log('Matched filename to code block:', lastFilename);
                files.push({
                    filename: lastFilename,
                    content: block.content,
                    language: block.language || this.detectLanguageFromFilename(lastFilename)
                });
            }
            else if (block.language) {
                // No filename found, but we have a language - suggest a default name
                const defaultName = this.getDefaultFilename(block.language);
                console.log('No filename found, suggesting:', defaultName);
                files.push({
                    filename: defaultName,
                    content: block.content,
                    language: block.language
                });
            }
        }
        // Remove duplicates
        const uniqueFiles = files.filter((file, index, self) => index === self.findIndex(f => f.filename === file.filename));
        console.log('Total files extracted:', uniqueFiles.length);
        return uniqueFiles;
    }
    getDefaultFilename(language) {
        const defaults = {
            'javascript': 'script.js',
            'typescript': 'script.ts',
            'html': 'index.html',
            'css': 'styles.css',
            'python': 'script.py',
            'java': 'Main.java',
            'cpp': 'main.cpp',
            'c': 'main.c',
            'json': 'data.json',
            'jsx': 'Component.jsx',
            'tsx': 'Component.tsx'
        };
        return defaults[language.toLowerCase()] || 'file.txt';
    }
    /**
     * Create a file in the workspace
     */
    async createFile(file) {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
                return false;
            }
            // Get workspace root
            const workspaceRoot = workspaceFolders[0].uri;
            // Handle relative paths (e.g., "src/index.html")
            const fileUri = vscode.Uri.joinPath(workspaceRoot, file.filename);
            // Check if file exists
            try {
                await vscode.workspace.fs.stat(fileUri);
                // File exists, ask for confirmation
                const overwrite = await vscode.window.showWarningMessage(`File "${file.filename}" already exists. Overwrite?`, { modal: true }, 'Overwrite', 'Cancel');
                if (overwrite !== 'Overwrite') {
                    return false;
                }
            }
            catch {
                // File doesn't exist, continue
            }
            // Create parent directories if needed
            const dirPath = path.dirname(fileUri.fsPath);
            const dirUri = vscode.Uri.file(dirPath);
            try {
                await vscode.workspace.fs.createDirectory(dirUri);
            }
            catch {
                // Directory might already exist
            }
            // Write file
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(fileUri, encoder.encode(file.content));
            // Open the file
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document);
            vscode.window.showInformationMessage(`Created file: ${file.filename}`);
            return true;
        }
        catch (error) {
            console.error('Error creating file:', error);
            vscode.window.showErrorMessage(`Failed to create file: ${error.message}`);
            return false;
        }
    }
    /**
     * Prompt user to create detected files
     */
    async promptFileCreation(files) {
        if (files.length === 0)
            return;
        if (files.length === 1) {
            // Single file - ask directly
            const file = files[0];
            const create = await vscode.window.showInformationMessage(`Create file "${file.filename}"?`, 'Create', 'Cancel');
            if (create === 'Create') {
                await this.createFile(file);
            }
        }
        else {
            // Multiple files - show quick pick
            const items = files.map(f => ({
                label: f.filename,
                description: `${f.language} file`,
                file: f
            }));
            items.push({
                label: '$(file-add) Create All Files',
                description: `Create all ${files.length} files`,
                file: null
            });
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `${files.length} files detected. Select file(s) to create:`
            });
            if (!selected)
                return;
            if (selected.label.includes('Create All')) {
                // Create all files
                for (const file of files) {
                    await this.createFile(file);
                }
            }
            else {
                // Create single file
                await this.createFile(selected.file);
            }
        }
    }
    detectLanguageFromFilename(filename) {
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const languageMap = {
            'js': 'javascript',
            'ts': 'typescript',
            'jsx': 'javascriptreact',
            'tsx': 'typescriptreact',
            'html': 'html',
            'css': 'css',
            'scss': 'scss',
            'json': 'json',
            'py': 'python',
            'java': 'java',
            'cpp': 'cpp',
            'c': 'c',
            'cs': 'csharp',
            'php': 'php',
            'rb': 'ruby',
            'go': 'go',
            'rs': 'rust',
            'sql': 'sql',
            'md': 'markdown',
            'xml': 'xml',
            'yaml': 'yaml',
            'yml': 'yaml'
        };
        return languageMap[ext] || ext;
    }
    isValidFilename(filename) {
        // Check if it looks like a valid filename
        const validPattern = /^[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+$/;
        return validPattern.test(filename);
    }
}
exports.FileCreator = FileCreator;
//# sourceMappingURL=fileCreator.js.map