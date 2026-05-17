import * as vscode from 'vscode';
import * as path from 'path';
import axios, { isAxiosError } from 'axios';

const SECRET_SNIPPETS_API_URL = 'caps.snippetsApiUrl';
const SECRET_SNIPPETS_API_BEARER = 'caps.snippetsApiBearer';
const SECRET_DIRECT_URL = 'caps.directSupabaseUrl';
const SECRET_DIRECT_KEY = 'caps.directApiKey';
const SECRET_SUPABASE_ANON_KEY = 'caps.supabaseAnonKey';
const SECRET_ANTHROPIC_KEY = 'caps.anthropicApiKey';

const BOOST_SYSTEM_PROMPT =
    `You are an expert prompt engineer for AI coding assistants (GitHub Copilot, Claude, Cursor, etc.).

Transform the user's rough or vague coding prompt into a precise, effective prompt that will produce better results from an AI coding assistant.

Rules:
- Preserve the original intent exactly
- Be specific: mention language, framework, and context where relevant
- Add useful constraints where appropriate (e.g. "do not install new packages", "keep existing API surface")
- Specify expected output format when it helps (e.g. "return only the changed function")
- Return ONLY the enhanced prompt — no explanation, no preamble, no wrapping quotes`;

const DEFAULT_REST_URL = 'https://zrcciaqiewveljumkcvz.supabase.co/rest/v1/prompts?select=id,title,prompt_text,category,tags,vote_count&order=vote_count.desc';
// Public anon key — safe to ship in client code (role: anon, expires 2036).
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpyY2NpYXFpZXd2ZWxqdW1rY3Z6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjYzODcsImV4cCI6MjA5Mzc0MjM4N30.pq5tcsWHzoLQ7BvSQIbyf9Cjlgd8Vy-L-X4cfxbYYK4';

type SnippetRow = {
    title: string;
    category: string;
    tags: string[];
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
    const rawTags = s.tags;
    const tags: string[] = Array.isArray(rawTags)
        ? rawTags.filter((t): t is string => typeof t === 'string')
        : typeof rawTags === 'string' && rawTags.trim()
          ? rawTags.split(',').map(t => t.trim()).filter(Boolean)
          : [];
    return { title, category, tags, promptText };
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

const CACHE_TTL_MS = 60_000;

const CONTEXT_PLACEHOLDERS = ['{{selection}}', '{{filename}}', '{{filepath}}', '{{language}}'] as const;

const RECENT_KEY = 'caps.recentlyUsed';
const RECENT_MAX = 5;

function getRecentPrompts(state: vscode.Memento): SnippetRow[] {
    return state.get<SnippetRow[]>(RECENT_KEY, []);
}

async function addRecentPrompt(state: vscode.Memento, row: SnippetRow): Promise<void> {
    const current = getRecentPrompts(state);
    const deduped = current.filter(r => r.title !== row.title);
    await state.update(RECENT_KEY, [row, ...deduped].slice(0, RECENT_MAX));
}

function injectContext(promptText: string, editor: vscode.TextEditor | undefined): string {
    if (!editor) {
        return promptText;
    }
    const doc = editor.document;
    const selectedText = doc.getText(editor.selection);
    const filename = path.basename(doc.fileName);
    const filepath = vscode.workspace.asRelativePath(doc.fileName);
    const language = doc.languageId;

    return promptText
        .replace(/\{\{selection\}\}/gi, selectedText)
        .replace(/\{\{filename\}\}/gi, filename)
        .replace(/\{\{filepath\}\}/gi, filepath)
        .replace(/\{\{language\}\}/gi, language);
}

async function resolveAnthropicKey(secrets: vscode.SecretStorage): Promise<string> {
    const fromSecret = await secrets.get(SECRET_ANTHROPIC_KEY);
    return fromSecret?.trim() || process.env.CAPS_ANTHROPIC_API_KEY?.trim() || '';
}

async function callAnthropicBoost(
    roughPrompt: string,
    apiKey: string,
    log: (m: string) => void
): Promise<string> {
    const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: BOOST_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: roughPrompt }]
        },
        {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            }
        }
    );
    const enhanced: string = (response.data as { content?: Array<{ text?: string }> })?.content?.[0]?.text?.trim() ?? '';
    if (!enhanced) {
        throw new Error('Anthropic returned an empty response');
    }
    log(`boost ok; enhanced length=${enhanced.length}`);
    return enhanced;
}

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('CAPS');
    const logCaps = (message: string) => {
        const line = `[CAPS] ${message}`;
        console.log(line);
        output.appendLine(line);
    };

    output.show(false);
    logCaps('activate');

    type SnippetCacheEntry = { rows: SnippetRow[]; fetchedAt: number; modeKey: string };
    let snippetCache: SnippetCacheEntry | null = null;

    function invalidateCache() { snippetCache = null; }

    async function fetchCached(): Promise<SnippetRow[]> {
        const cfg = await resolveFetchMode(context.secrets, logCaps);
        const modeKey = cfg.mode === 'api' ? cfg.url : cfg.url + cfg.apiKey;
        const now = Date.now();
        if (snippetCache && snippetCache.modeKey === modeKey && now - snippetCache.fetchedAt < CACHE_TTL_MS) {
            logCaps(`cache hit; age=${Math.round((now - snippetCache.fetchedAt) / 1000)}s`);
            return snippetCache.rows;
        }
        const rows = await fetchSnippetRows(cfg, logCaps);
        snippetCache = { rows, fetchedAt: now, modeKey };
        logCaps(`cache updated; ${rows.length} rows`);
        return rows;
    }

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
            invalidateCache();
            logCaps('snippetsApiUrl cleared — using built-in default');
            vscode.window.showInformationMessage('CAPS snippets API URL cleared; using built-in default.');
            return;
        }
        await context.secrets.store(SECRET_SNIPPETS_API_URL, value.trim());
        invalidateCache();
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
            invalidateCache();
            logCaps('snippetsApiBearer cleared');
            vscode.window.showInformationMessage('CAPS API Bearer cleared.');
            return;
        }
        await context.secrets.store(SECRET_SNIPPETS_API_BEARER, t);
        invalidateCache();
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
            invalidateCache();
            logCaps('supabaseAnonKey cleared');
            vscode.window.showInformationMessage('CAPS Supabase anon key cleared.');
            return;
        }
        await context.secrets.store(SECRET_SUPABASE_ANON_KEY, t);
        invalidateCache();
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
        invalidateCache();
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
        invalidateCache();
        logCaps('direct API key stored');
        vscode.window.showInformationMessage('CAPS direct API key saved.');
    });

    const clearSecrets = vscode.commands.registerCommand('caps.clearCapsSecrets', async () => {
        await context.secrets.delete(SECRET_SNIPPETS_API_URL);
        await context.secrets.delete(SECRET_SNIPPETS_API_BEARER);
        await context.secrets.delete(SECRET_DIRECT_URL);
        await context.secrets.delete(SECRET_DIRECT_KEY);
        await context.secrets.delete(SECRET_SUPABASE_ANON_KEY);
        await context.secrets.delete(SECRET_ANTHROPIC_KEY);
        invalidateCache();
        logCaps('all CAPS secrets cleared');
        vscode.window.showInformationMessage('CAPS secrets cleared.');
    });

    const setAnthropicApiKey = vscode.commands.registerCommand('caps.setAnthropicApiKey', async () => {
        const value = await vscode.window.showInputBox({
            title: 'CAPS: Anthropic API key',
            prompt: 'Paste your Anthropic API key (sk-ant-...). Stored securely. Also settable via CAPS_ANTHROPIC_API_KEY env var.',
            password: true,
            ignoreFocusOut: true
        });
        if (value === undefined) {
            return;
        }
        const t = value.trim();
        if (!t) {
            await context.secrets.delete(SECRET_ANTHROPIC_KEY);
            logCaps('anthropicApiKey cleared');
            vscode.window.showInformationMessage('CAPS Anthropic API key cleared.');
            return;
        }
        await context.secrets.store(SECRET_ANTHROPIC_KEY, t);
        logCaps('anthropicApiKey stored');
        vscode.window.showInformationMessage('CAPS Anthropic API key saved.');
    });

    const boostPrompt = vscode.commands.registerCommand('caps.boostPrompt', async () => {
        const editor = vscode.window.activeTextEditor;
        let roughPrompt = '';
        if (editor && !editor.selection.isEmpty) {
            roughPrompt = editor.document.getText(editor.selection).trim();
        }

        if (!roughPrompt) {
            const input = await vscode.window.showInputBox({
                title: 'CAPS: Boost Prompt',
                prompt: 'Enter your rough prompt to enhance with Anthropic AI',
                placeHolder: 'e.g. make a login form with JWT auth',
                ignoreFocusOut: true
            });
            if (!input?.trim()) {
                return;
            }
            roughPrompt = input.trim();
        }

        const apiKey = await resolveAnthropicKey(context.secrets);
        if (!apiKey) {
            const pick = await vscode.window.showErrorMessage(
                'CAPS Boost: No Anthropic API key configured.',
                'Set API Key'
            );
            if (pick === 'Set API Key') {
                await vscode.commands.executeCommand('caps.setAnthropicApiKey');
            }
            return;
        }

        let enhanced = '';
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'CAPS: Boosting prompt...', cancellable: false },
                async () => {
                    enhanced = await callAnthropicBoost(roughPrompt, apiKey, logCaps);
                }
            );
        } catch (error) {
            if (isAxiosError(error)) {
                const status = error.response?.status;
                const body = JSON.stringify(error.response?.data ?? '').slice(0, 300);
                logCaps(`boost command HTTP error: status=${status}; body=${body}`);
                vscode.window.showErrorMessage(`CAPS Boost failed (HTTP ${status ?? 'unknown'}). Check CAPS output channel.`);
            } else {
                logCaps(`boost command error: ${String(error)}`);
                vscode.window.showErrorMessage(`CAPS Boost failed: ${String(error)}`);
            }
            output.show(true);
            return;
        }

        const finalPrompt = await vscode.window.showInputBox({
            title: 'CAPS: Boosted Prompt',
            prompt: 'Edit if needed — press Enter to open in inline chat, Escape to copy to clipboard',
            value: enhanced,
            ignoreFocusOut: true
        });

        if (finalPrompt === undefined) {
            await vscode.env.clipboard.writeText(enhanced);
            vscode.window.showInformationMessage('CAPS: Enhanced prompt copied to clipboard.');
            return;
        }
        if (finalPrompt.trim()) {
            await vscode.commands.executeCommand('caps.openInlineChat', finalPrompt.trim());
        }
    });

    const codeLensEmitter = new vscode.EventEmitter<void>();
    const codeLensProvider = vscode.languages.registerCodeLensProvider(
        { scheme: 'file', language: '*' },
        {
            onDidChangeCodeLenses: codeLensEmitter.event,
            provideCodeLenses(document): vscode.CodeLens[] {
                const editor = vscode.window.activeTextEditor;
                if (!editor || editor.document !== document || editor.selection.isEmpty) {
                    return [];
                }
                const line = editor.selection.start.line;
                return [new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
                    title: '$(sparkle) Boost with CAPS',
                    command: 'caps.boostPrompt',
                    tooltip: 'Enhance selected text as a prompt with Anthropic AI'
                })];
            }
        }
    );
    const selectionListener = vscode.window.onDidChangeTextEditorSelection(() => {
        codeLensEmitter.fire();
    });

    const chatParticipant = vscode.chat.createChatParticipant(
        'caps.assistant',
        async (request, _chatCtx, stream, _token) => {
            const roughPrompt = request.prompt.trim();
            if (!roughPrompt) {
                stream.markdown(
                    'Type a rough prompt after `@caps` and I\'ll enhance it for inline chat.\n\n' +
                    '**Example:** `@caps make a login form with JWT auth`'
                );
                return;
            }

            const apiKey = await resolveAnthropicKey(context.secrets);
            if (!apiKey) {
                stream.markdown(
                    '**CAPS Boost** needs an Anthropic API key.\n\n' +
                    'Run **CAPS: Set Anthropic API key** from the Command Palette (`Ctrl+Shift+P`) and paste your key.'
                );
                stream.button({ command: 'caps.setAnthropicApiKey', title: '$(key) Set Anthropic API key' });
                return;
            }

            stream.progress('Enhancing with Anthropic...');
            try {
                const enhanced = await callAnthropicBoost(roughPrompt, apiKey, logCaps);
                stream.markdown(`**Enhanced prompt:**\n\n\`\`\`\n${enhanced}\n\`\`\``);
                stream.button({ command: 'caps.openInlineChat', arguments: [enhanced], title: '$(sparkle) Open in Inline Chat' });
            } catch (error) {
                if (isAxiosError(error)) {
                    const status = error.response?.status;
                    const body = JSON.stringify(error.response?.data ?? '').slice(0, 300);
                    logCaps(`boost participant HTTP error: status=${status}; body=${body}`);
                    if (status === 401) {
                        stream.markdown('**CAPS Boost**: Invalid or expired Anthropic API key. Re-run **CAPS: Set Anthropic API key** to update it.');
                        stream.button({ command: 'caps.setAnthropicApiKey', title: '$(key) Update API key' });
                    } else {
                        stream.markdown(`**CAPS Boost**: Anthropic API error (HTTP ${status ?? 'unknown'}). Check the CAPS output channel for details.`);
                    }
                } else {
                    logCaps(`boost participant error: ${String(error)}`);
                    stream.markdown(`**CAPS Boost**: ${String(error)}`);
                }
            }
        }
    );
    chatParticipant.iconPath = new vscode.ThemeIcon('sparkle');

    const pickPrompt = vscode.commands.registerCommand('caps.pickPrompt', async () => {
        // Snapshot context immediately — before any async UI that could lose the selection.
        const editor = vscode.window.activeTextEditor;
        const snapshot = editor
            ? {
                selectedText: editor.document.getText(editor.selection),
                filename: path.basename(editor.document.fileName),
                filepath: vscode.workspace.asRelativePath(editor.document.fileName),
                language: editor.document.languageId
            }
            : null;

        type PromptItem = vscode.QuickPickItem & { promptText: string; row?: SnippetRow };

        // Show the picker immediately so the user gets instant feedback.
        const qp = vscode.window.createQuickPick<PromptItem>();
        qp.title = 'CAPS: Pick a prompt';
        qp.placeholder = 'Loading…';
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.busy = true;
        qp.show();

        try {
            const cacheAgeBefore = snippetCache ? Date.now() - snippetCache.fetchedAt : null;
            const rows = await fetchCached();
            const fromCache = cacheAgeBefore !== null && cacheAgeBefore < CACHE_TTL_MS;
            qp.title = fromCache
                ? `CAPS: Pick a prompt  (cached ${Math.round(cacheAgeBefore! / 1000)}s ago)`
                : 'CAPS: Pick a prompt  (refreshed)';
            const recent = getRecentPrompts(context.globalState);

            const toItem = (s: SnippetRow): PromptItem => {
                const tagPart = s.tags.length > 0 ? ` · ${s.tags.join(', ')}` : '';
                const preview = s.promptText.length > 110 ? s.promptText.slice(0, 110) + '…' : s.promptText;
                return {
                    label: s.title,
                    description: `${s.category}${tagPart}`,
                    detail: preview,
                    promptText: s.promptText,
                    row: s
                };
            };

            const items: PromptItem[] = [];

            if (recent.length > 0) {
                items.push({ label: 'Recently Used', kind: vscode.QuickPickItemKind.Separator, promptText: '' });
                for (const r of recent) {
                    items.push(toItem(r));
                }
            }

            // Group remaining by category, sort categories alphabetically.
            const grouped = new Map<string, SnippetRow[]>();
            for (const row of rows) {
                const cat = row.category || 'Uncategorized';
                if (!grouped.has(cat)) { grouped.set(cat, []); }
                grouped.get(cat)!.push(row);
            }
            for (const cat of [...grouped.keys()].sort((a, b) => a.localeCompare(b))) {
                items.push({ label: cat, kind: vscode.QuickPickItemKind.Separator, promptText: '' });
                for (const s of grouped.get(cat)!) {
                    items.push(toItem(s));
                }
            }

            qp.items = items;
            qp.placeholder = rows.length === 0 ? 'No prompts found in library' : 'Search by title, category, tags, or prompt text…';
            qp.busy = false;
        } catch (error) {
            qp.hide();
            qp.dispose();
            logCaps(`pickPrompt fetch error: ${String(error)}`);
            vscode.window.showErrorMessage('CAPS failed to fetch prompts. Check CAPS output channel.');
            output.show(true);
            return;
        }

        const picked = await new Promise<PromptItem | undefined>(resolve => {
            qp.onDidAccept(() => resolve(qp.selectedItems[0]));
            qp.onDidHide(() => resolve(undefined));
        });
        qp.dispose();

        if (!picked || !picked.row) {
            return;
        }

        await addRecentPrompt(context.globalState, picked.row);

        let injected = picked.promptText;
        if (snapshot) {
            injected = injected
                .replace(/\{\{selection\}\}/gi, snapshot.selectedText)
                .replace(/\{\{filename\}\}/gi, snapshot.filename)
                .replace(/\{\{filepath\}\}/gi, snapshot.filepath)
                .replace(/\{\{language\}\}/gi, snapshot.language);
        }

        logCaps(`pickPrompt: "${picked.label}"; context injected=${injected !== picked.promptText}`);
        await vscode.commands.executeCommand('caps.openInlineChat', injected);
    });

    const openInlineChatWithContext = vscode.commands.registerCommand(
        'caps.openInlineChatWithContext',
        async (promptText: string) => {
            const editor = vscode.window.activeTextEditor;
            const injected = injectContext(promptText, editor);
            if (injected !== promptText) {
                logCaps(`context injected: ${promptText.length} → ${injected.length} chars`);
            }
            await vscode.commands.executeCommand('caps.openInlineChat', injected);
        }
    );

    // Fired by the //? completion on accept — records the pick then opens inline chat.
    const completionAccepted = vscode.commands.registerCommand(
        'caps.completionAccepted',
        async (row: SnippetRow) => {
            await addRecentPrompt(context.globalState, row);
            logCaps(`completion accepted: "${row.title}"`);
            await vscode.commands.executeCommand('caps.openInlineChatWithContext', row.promptText);
        }
    );

    const openInlineChat = vscode.commands.registerCommand('caps.openInlineChat', async (promptText: string) => {
        // Keep clipboard as fallback in case the type command misfires.
        await vscode.env.clipboard.writeText(promptText);

        // Collapse selection and nudge cursor off any diagnostic so VS Code doesn't
        // override the inline chat input with "Fix the problem".
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            let safePos = editor.selection.active;
            if (!editor.selection.isEmpty) {
                safePos = editor.selection.start;
                editor.selection = new vscode.Selection(safePos, safePos);
            }
            const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
            const onDiag = diagnostics.some(d => d.range.contains(safePos));
            if (onDiag) {
                const lineStart = new vscode.Position(safePos.line, 0);
                editor.selection = new vscode.Selection(lineStart, lineStart);
            }
        }

        vscode.window.showInformationMessage('CAPS: Prompt copied — Ctrl+A, Ctrl+V to paste it in.');

        const chatCmds: Array<[string, unknown[]]> = [
            ['inlineChat.start', [{ initialInput: promptText, autoSend: false }]],
            ['inlineChat.start', [{ message: promptText, autoSend: false }]],
            ['editor.action.inlineChat.start', [{ initialInput: promptText, autoSend: false }]],
            ['editor.action.inlineChat.start', [{ message: promptText, autoSend: false }]],
            ['inlineChat.start', []],
            ['editor.action.inlineChat.start', []],
        ];
        for (const [cmd, args] of chatCmds) {
            try { await vscode.commands.executeCommand(cmd, ...args); return; } catch { }
        }
        await vscode.commands.executeCommand('workbench.action.chat.open');
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

                try {
                    const rows = await fetchCached();
                    const recentTitles = new Set(getRecentPrompts(context.globalState).map(r => r.title));

                    return rows.map((s) => {
                        const item = new vscode.CompletionItem(s.title, vscode.CompletionItemKind.Snippet);
                        item.detail = `[CAPS] ${s.category}`;
                        item.filterText = [s.title, s.category, ...s.tags].join(' ');
                        item.sortText = recentTitles.has(s.title) ? `0_${s.title}` : `1_${s.title}`;
                        item.insertText = '';
                        item.command = {
                            command: 'caps.completionAccepted',
                            title: 'Open Inline Chat',
                            arguments: [s]
                        };
                        const usedPlaceholders = CONTEXT_PLACEHOLDERS.filter(p =>
                            s.promptText.toLowerCase().includes(p.toLowerCase())
                        );
                        let docContent = `**Category:** ${s.category}`;
                        if (s.tags.length > 0) {
                            docContent += `  \n**Tags:** ${s.tags.join(', ')}`;
                        }
                        if (usedPlaceholders.length > 0) {
                            docContent += `\n\n*Auto-injects: ${usedPlaceholders.join(', ')}*`;
                        }
                        docContent += `\n\n${s.promptText}`;
                        item.documentation = new vscode.MarkdownString(docContent);
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

    // Detect @@ typed in any editor and open the QuickPick immediately.
    const atAtListener = vscode.workspace.onDidChangeTextDocument(async (event) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== event.document) { return; }

        for (const change of event.contentChanges) {
            if (change.text !== '@') { continue; }

            const col = change.range.start.character;
            if (col < 1) { continue; }

            // After the insert, check whether the character just before the new @ is also @.
            const lineText = editor.document.lineAt(change.range.start.line).text;
            if (lineText[col - 1] !== '@') { continue; }

            // Delete the @@ then open the QuickPick.
            const deleteRange = new vscode.Range(
                change.range.start.line, col - 1,
                change.range.start.line, col + 1
            );
            await editor.edit(eb => eb.delete(deleteRange));
            await vscode.commands.executeCommand('caps.pickPrompt');
            break;
        }
    });

    context.subscriptions.push(
        provider,
        openInlineChat,
        output,
        setSnippetsApiUrl,
        setSnippetsApiBearer,
        setSupabaseAnonKey,
        setDirectUrl,
        setDirectKey,
        clearSecrets,
        pickPrompt,
        openInlineChatWithContext,
        completionAccepted,
        setAnthropicApiKey,
        boostPrompt,
        codeLensEmitter,
        codeLensProvider,
        selectionListener,
        chatParticipant,
        atAtListener
    );
}
