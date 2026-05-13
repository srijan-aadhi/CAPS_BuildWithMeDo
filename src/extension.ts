import * as vscode from 'vscode';
import axios, { isAxiosError } from 'axios';

const SECRET_SNIPPETS_API_URL = 'caps.snippetsApiUrl';
const SECRET_SNIPPETS_API_BEARER = 'caps.snippetsApiBearer';
const SECRET_DIRECT_URL = 'caps.directSupabaseUrl';
const SECRET_DIRECT_KEY = 'caps.directApiKey';
const SECRET_SUPABASE_ANON_KEY = 'caps.supabaseAnonKey';

const DEFAULT_REST_URL = 'https://zrcciaqiewveljumkcvz.supabase.co/rest/v1/prompts?select=id,title,prompt_text,category,tags,vote_count&order=vote_count.desc';
// Public anon key — safe to ship in client code (role: anon, expires 2036).
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpyY2NpYXFpZXd2ZWxqdW1rY3Z6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjYzODcsImV4cCI6MjA5Mzc0MjM4N30.pq5tcsWHzoLQ7BvSQIbyf9Cjlgd8Vy-L-X4cfxbYYK4';

type SnippetRow = {
    title: string;
    category: string;
    promptText: string;
}; 

function normalizeSnippet(raw: unknown): SnippetRow | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const s = raw as Record<string, unknown>;
    const title = typeof s.title === 'string' ? s.title : String(s.title ?? '');
    const category = typeof s.category === 'string' ? s.category : String(s.category ?? '');
    const promptText =
        typeof s.promptText === 'string'
            ? s.promptText
            : typeof s.prompt_text === 'string'
              ? s.prompt_text
              : '';
    if (!title && !promptText) {
        return undefined;
    }
    return { title, category, promptText };
}

function looksLikeHtml(body: string): boolean {
    const t = body.trimStart().toLowerCase();
    return t.startsWith('<!doctype') || t.startsWith('<html');
}

/** Unwraps either a plain array or a { prompts: [...] } envelope. */
function extractRows(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (parsed && typeof parsed === 'object' && 'prompts' in parsed && Array.isArray((parsed as { prompts: unknown }).prompts)) {
        return (parsed as { prompts: unknown[] }).prompts;
    }
    return [];
}

async function resolveFetchMode(
    secrets: vscode.SecretStorage,
    log: (m: string) => void
): Promise<
    { mode: 'api'; url: string; bearer?: string } | { mode: 'direct'; url: string; apiKey: string }
> {
    const [apiUrlSec, bearerSec, directUrlSec, directKeySec, anonKeySec] = await Promise.all([
        secrets.get(SECRET_SNIPPETS_API_URL),
        secrets.get(SECRET_SNIPPETS_API_BEARER),
        secrets.get(SECRET_DIRECT_URL),
        secrets.get(SECRET_DIRECT_KEY),
        secrets.get(SECRET_SUPABASE_ANON_KEY)
    ]);

    const apiUrl = (apiUrlSec?.trim() || process.env.CAPS_SNIPPETS_API_URL?.trim()) ?? '';
    const bearer = (bearerSec?.trim() || process.env.CAPS_SNIPPETS_API_BEARER?.trim()) || undefined;
    const directUrl = (directUrlSec?.trim() || process.env.CAPS_SNIPPETS_URL?.trim()) ?? '';
    const directKey = (directKeySec?.trim() || process.env.CAPS_API_KEY?.trim()) ?? '';
    const anonKey = (anonKeySec?.trim() || process.env.CAPS_SUPABASE_ANON_KEY?.trim()) || undefined;

    if (apiUrl) {
        log(`mode=api; url from secret/env (${apiUrl.length} chars); bearer=${bearer ? 'yes' : 'no'}`);
        return { mode: 'api', url: apiUrl, bearer };
    }
    if (directUrl && directKey) {
        log(`mode=direct; url (${directUrl.length} chars); key length=${directKey.length}`);
        return { mode: 'direct', url: directUrl, apiKey: directKey };
    }
    const effectiveAnonKey = anonKey ?? DEFAULT_SUPABASE_ANON_KEY;
    log(`mode=direct; using built-in Supabase REST URL; key=${anonKey ? 'from secret/env' : 'built-in default'}`);
    return { mode: 'direct', url: DEFAULT_REST_URL, apiKey: effectiveAnonKey };
}

async function fetchSnippetRows(
    mode:
        | { mode: 'api'; url: string; bearer?: string }
        | { mode: 'direct'; url: string; apiKey: string },
    log: (m: string) => void
): Promise<SnippetRow[]> {
    if (mode.mode === 'direct') {
        const res = await axios.get(mode.url, {
            headers: {
                apikey: mode.apiKey,
                Authorization: `Bearer ${mode.apiKey}`
            }
        });
        const rows = extractRows(res.data);
        log(`direct fetch ok: ${rows.length} items`);
        return rows.map(normalizeSnippet).filter((x): x is SnippetRow => x !== undefined);
    }

    const headers: Record<string, string> = {};
    if (mode.bearer) {
        headers.Authorization = `Bearer ${mode.bearer}`;
    }

    const res = await axios.get(mode.url, { headers, responseType: 'text', transformResponse: [(d) => d] });
    const raw = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    if (looksLikeHtml(raw)) {
        throw new Error(
            'Response looks like HTML (SPA fallback?). Use your Deno/edge function URL or real GET /api/snippets, not the dashboard page.'
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('Response is not valid JSON');
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed) {
        const msg = (parsed as { error?: string }).error ?? 'Unknown error';
        throw new Error(msg);
    }

    const rows = extractRows(parsed);
    if (rows.length === 0 && !Array.isArray(parsed) && !(parsed && typeof parsed === 'object' && 'prompts' in parsed)) {
        throw new Error('Expected a JSON array or { prompts: [] } envelope from the API');
    }

    const snippets = rows.map(normalizeSnippet).filter((x): x is SnippetRow => x !== undefined);
    log(`API fetch ok: ${snippets.length} items`);
    return snippets;
}

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('CAPS');
    const logCaps = (message: string) => {
        const line = `[CAPS] ${message}`;
        console.log(line);
        output.appendLine(line);
    };

    logCaps('activate');

    const setSnippetsApiUrl = vscode.commands.registerCommand('caps.setSnippetsApiUrl', async () => {
        const current = (await context.secrets.get(SECRET_SNIPPETS_API_URL)) ?? '';
        const value = await vscode.window.showInputBox({
            title: 'CAPS snippets API URL',
            prompt:
                'GET URL returning JSON array or { prompts: [] } (title, prompt_text, category). Clear to use built-in default. Stored securely.',
            value: current,
            ignoreFocusOut: true,
            validateInput: (s) => {
                const t = s.trim();
                if (!t) {
                    return undefined;
                }
                return URL.canParse(t) ? undefined : 'Enter a valid URL';
            }
        });
        if (value === undefined) {
            return;
        }
        if (!value.trim()) {
            await context.secrets.delete(SECRET_SNIPPETS_API_URL);
            logCaps('snippetsApiUrl cleared — using built-in default');
            vscode.window.showInformationMessage('CAPS snippets API URL cleared; using built-in default.');
            return;
        }
        await context.secrets.store(SECRET_SNIPPETS_API_URL, value.trim());
        logCaps('snippetsApiUrl stored');
        vscode.window.showInformationMessage('CAPS snippets API URL saved.');
    });

    const setSnippetsApiBearer = vscode.commands.registerCommand('caps.setSnippetsApiBearer', async () => {
        const value = await vscode.window.showInputBox({
            title: 'CAPS API Bearer (optional)',
            prompt:
                'Authorization Bearer for a custom API URL. Leave empty to clear. For the default Supabase URL, use "CAPS: Set Supabase anon key" instead.',
            password: true,
            ignoreFocusOut: true
        });
        if (value === undefined) {
            return;
        }
        const t = value.trim();
        if (!t) {
            await context.secrets.delete(SECRET_SNIPPETS_API_BEARER);
            logCaps('snippetsApiBearer cleared');
            vscode.window.showInformationMessage('CAPS API Bearer cleared.');
            return;
        }
        await context.secrets.store(SECRET_SNIPPETS_API_BEARER, t);
        logCaps('snippetsApiBearer stored');
        vscode.window.showInformationMessage('CAPS API Bearer saved.');
    });

    const setSupabaseAnonKey = vscode.commands.registerCommand('caps.setSupabaseAnonKey', async () => {
        const value = await vscode.window.showInputBox({
            title: 'CAPS: Supabase anon key',
            prompt:
                'Supabase anon/public key — find it in Supabase Dashboard → Settings → API → Project API keys → anon public. Stored securely. Also settable via CAPS_SUPABASE_ANON_KEY env var.',
            password: true,
            ignoreFocusOut: true,
            validateInput: (s) => (s.trim() ? undefined : 'Enter a non-empty key')
        });
        if (value === undefined) {
            return;
        }
        const t = value.trim();
        if (!t) {
            await context.secrets.delete(SECRET_SUPABASE_ANON_KEY);
            logCaps('supabaseAnonKey cleared');
            vscode.window.showInformationMessage('CAPS Supabase anon key cleared.');
            return;
        }
        await context.secrets.store(SECRET_SUPABASE_ANON_KEY, t);
        logCaps('supabaseAnonKey stored');
        vscode.window.showInformationMessage('CAPS Supabase anon key saved.');
    });

    const setDirectUrl = vscode.commands.registerCommand('caps.setDirectSupabaseUrl', async () => {
        const current = (await context.secrets.get(SECRET_DIRECT_URL)) ?? '';
        const value = await vscode.window.showInputBox({
            title: 'CAPS direct Supabase REST URL',
            prompt: 'Full Supabase REST URL (e.g. .../rest/v1/prompts?select=...). Used when no custom API URL is set. Stored securely.',
            value: current,
            ignoreFocusOut: true,
            validateInput: (s) => (s.trim() ? undefined : 'Enter a non-empty URL')
        });
        if (value === undefined) {
            return;
        }
        await context.secrets.store(SECRET_DIRECT_URL, value.trim());
        logCaps('direct Supabase URL stored');
        vscode.window.showInformationMessage('CAPS direct URL saved.');
    });

    const setDirectKey = vscode.commands.registerCommand('caps.setDirectApiKey', async () => {
        const value = await vscode.window.showInputBox({
            title: 'CAPS direct Supabase API key',
            prompt: 'Only used with direct REST URL. Stored securely.',
            password: true,
            ignoreFocusOut: true,
            validateInput: (s) => (s.trim() ? undefined : 'Enter a non-empty key')
        });
        if (value === undefined) {
            return;
        }
        await context.secrets.store(SECRET_DIRECT_KEY, value.trim());
        logCaps('direct API key stored');
        vscode.window.showInformationMessage('CAPS direct API key saved.');
    });

    const clearSecrets = vscode.commands.registerCommand('caps.clearCapsSecrets', async () => {
        await context.secrets.delete(SECRET_SNIPPETS_API_URL);
        await context.secrets.delete(SECRET_SNIPPETS_API_BEARER);
        await context.secrets.delete(SECRET_DIRECT_URL);
        await context.secrets.delete(SECRET_DIRECT_KEY);
        await context.secrets.delete(SECRET_SUPABASE_ANON_KEY);
        logCaps('all CAPS secrets cleared');
        vscode.window.showInformationMessage('CAPS secrets cleared.');
    });

    const openInlineChat = vscode.commands.registerCommand('caps.openInlineChat', async (promptText: string) => {
        const attempts: Array<{ command: string; args: any[] }> = [
            { command: 'inlineChat.start', args: [{ message: promptText, autoSend: false }] },
            { command: 'inlineChat.start', args: [{ prompt: promptText, autoSend: false }] },
            { command: 'inlineChat.start', args: [promptText] },
            { command: 'editor.action.inlineChat.start', args: [{ message: promptText, autoSend: false }] },
            { command: 'editor.action.inlineChat.start', args: [{ prompt: promptText, autoSend: false }] },
            { command: 'editor.action.inlineChat.start', args: [promptText] }
        ];

        for (const attempt of attempts) {
            try {
                await vscode.commands.executeCommand(attempt.command, ...attempt.args);
                return;
            } catch {
                // Try next command/argument shape.
            }
        }

        try {
            await vscode.commands.executeCommand('inlineChat.start');
            return;
        } catch {
            // Try alternate command id used in some builds.
        }

        try {
            await vscode.commands.executeCommand('editor.action.inlineChat.start');
            return;
        } catch {
            await vscode.env.clipboard.writeText(promptText);
            await vscode.commands.executeCommand('workbench.action.chat.open');
            vscode.window.showWarningMessage('Could not prefill inline chat. Prompt copied to clipboard and chat opened.');
        }
    });

    const provider = vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', language: '*' },
        {
            async provideCompletionItems(document, position) {
                vscode.window.showInformationMessage('CAPS is looking for snippets...');
                const linePrefix = document.lineAt(position).text.substr(0, position.character);
                if (!linePrefix.endsWith('//?')) {
                    return undefined;
                }

                logCaps('completion //?');

                const cfg = await resolveFetchMode(context.secrets, logCaps);

                try {
                    const rows = await fetchSnippetRows(cfg, logCaps);

                    return rows.map((s) => {
                        const item = new vscode.CompletionItem(s.title, vscode.CompletionItemKind.Snippet);
                        item.detail = `[CAPS] ${s.category}`;
                        item.insertText = '';
                        item.command = {
                            command: 'caps.openInlineChat',
                            title: 'Open Inline Chat',
                            arguments: [s.promptText]
                        };
                        item.documentation = new vscode.MarkdownString(
                            `**Category:** ${s.category}\n\n${s.promptText}`
                        );
                        return item;
                    });
                } catch (error) {
                    if (isAxiosError(error)) {
                        const status = error.response?.status;
                        const data = error.response?.data;
                        const body =
                            typeof data === 'string'
                                ? data.slice(0, 500)
                                : JSON.stringify(data ?? '').slice(0, 500);
                        logCaps(`HTTP error: ${error.message}; status=${status ?? 'n/a'}; body: ${body}`);
                    } else {
                        logCaps(`Error: ${String(error)}`);
                    }
                    output.show(true);
                    vscode.window.showErrorMessage('CAPS failed to fetch: ' + error);
                    return [];
                }
            }
        },
        '?'
    );

    context.subscriptions.push(
        provider,
        openInlineChat,
        output,
        setSnippetsApiUrl,
        setSnippetsApiBearer,
        setSupabaseAnonKey,
        setDirectUrl,
        setDirectKey,
        clearSecrets
    );
}
