/**
 * swarm-image-gen — SwarmUI text-to-image generation for SillyTavern.
 *
 * Transport:
 *   - `direct` : the browser calls SwarmUI itself (requires SwarmUI to allow the
 *                SillyTavern origin, i.e. AccessControlAllowOrigin).
 *   - `proxy`  : requests go through SillyTavern's own /proxy/ route, which is
 *                server-side, so SwarmUI's CORS check never applies.
 *                Requires `enableCorsProxy: true` (or `--corsProxy`) in SillyTavern.
 *   - `auto`   : tries `direct` first and falls back to `proxy` (default).
 *
 * Only one import is used on purpose (kept intentionally small so that the
 * extension keeps working across SillyTavern updates).
 */

import { saveBase64AsFile } from '../../../utils.js';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Key inside extension_settings. Never rename this without a migration. */
const EXTENSION_KEY = 'swarm_image_gen';
/** Key used to store per-character look tags on the character card. */
const LOOK_TAGS_KEY = 'swarm_look_tags';
/** Prefix for all console output. */
const LOG = '[swarm]';
const DEFAULT_BASE_URL = 'http://127.0.0.1:7801';
/** Mirrors scripts/script.js systemUserName. */
const SYSTEM_USER_NAME = 'SillyTavern System';

const REQUEST_TIMEOUT_MS = 30_000;
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
const LOOK_TAGS_SAVE_DELAY_MS = 600;
const SCROLL_DELAY_MS = 200;

/** Media enum values (scripts/constants.js). */
const MEDIA_TYPE_IMAGE = 'image';
const MEDIA_SOURCE_GENERATED = 'generated';
const MEDIA_DISPLAY_GALLERY = 'gallery';
/** generationMode.MESSAGE from the built-in Stable Diffusion extension. */
const GENERATION_TYPE_MESSAGE = -1;

const ALLOWED_IMAGE_FORMATS = ['bmp', 'png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif'];

const DEFAULT_LLM_INSTRUCTION = [
    'You write image generation prompts for a Stable Diffusion model.',
    'Read the end of the chat and describe the current scene as a single comma-separated list of visual tags.',
    'Include: shot framing (close-up, portrait, upper body, full body),',
    'each visible character\'s appearance (hair colour and style, eye colour, clothing, accessories),',
    'pose, expression, what they are doing, location, time of day, lighting and mood.',
    'Use Danbooru-style tags (e.g. "1girl, solo, long black hair, brown eyes, red kimono"),',
    'never sentences, never quotes, never explanations, never markdown.',
    'Only output the tags themselves, on one line, separated by commas. Use at most 60 tags.',
].join(' ');

/**
 * "Send me a picture of:" sources — the same entries the built-in Image Generation
 * extension offers in its wand-menu submenu. They travel through `generateImage({ source })`
 * and `/swarm <key>` accepts them as well.
 */
const PICTURE_SOURCES = {
    you: 'Yourself',
    face: 'Your Face',
    me: 'Me',
    scene: 'The Whole Story',
    last: 'The Last Message',
    raw_last: 'Raw Last Message',
    background: 'Background',
};

/**
 * Instructions for the sources that the chat model has to describe. These are the built-in
 * extension's own prompt templates, so each entry produces the same kind of prompt as
 * SillyTavern's "Generate Image" menu. "Raw Last Message" is not here: it uses the message
 * text itself and never calls the model.
 */
const SOURCE_INSTRUCTIONS = {
    you: 'In the next response I want you to provide only a detailed comma-delimited list of keywords and phrases which describe {{char}}. The list must include all of the following items in this order: name, species and race, gender, age, clothing, occupation, physical features and appearances. Do not include descriptions of non-visual qualities such as personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase \'full body portrait,\'',
    face: 'In the next response I want you to provide only a detailed comma-delimited list of keywords and phrases which describe {{char}}. The list must include all of the following items in this order: name, species and race, gender, age, facial features and expressions, occupation, hair and hair accessories (if any), what they are wearing on their upper body (if anything). Do not describe anything below their neck. Do not include descriptions of non-visual qualities such as personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase \'close up facial portrait,\'',
    me: 'Ignore previous instructions and provide a detailed description of {{user}}\'s physical appearance from the perspective of {{char}} in the form of a comma-delimited list of keywords and phrases. The list must include all of the following items in this order: name, species and race, gender, age, clothing, occupation, physical features and appearances. Do not include descriptions of non-visual qualities such as personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase \'full body portrait,\'. Ignore the rest of the story when crafting this description. Do not reply as {{char}} when writing this description, and do not attempt to continue the story.',
    scene: 'Ignore previous instructions and provide a detailed description for all of the following: a brief recap of recent events in the story, {{char}}\'s appearance, and {{char}}\'s surroundings. Do not reply as {{char}} while writing this description.',
    last: [
        'Ignore previous instructions. Your next response must be formatted as a single comma-delimited list of concise keywords. The list will describe the visual details included in the last chat message.',
        '',
        'Only mention characters by using pronouns (\'he\',\'his\',\'she\',\'her\',\'it\',\'its\') or neutral nouns (\'male\', \'the man\', \'female\', \'the woman\').',
        '',
        'Ignore non-visible things such as feelings, personality traits, thoughts, and spoken dialog.',
        '',
        'Add keywords in this precise order:',
        'a keyword to describe the location of the scene,',
        'a keyword to mention how many characters of each gender or type are present in the scene (minimum of two characters: {{user}} and {{char}}, example: \'2 men \' or \'1 man 1 woman \', \'1 man 3 robots\'),',
        'keywords to describe the relative physical positioning of the characters to each other (if a commonly known term for the positioning is known use it instead of describing the positioning in detail) + \'POV\',',
        'a single keyword or phrase to describe the primary act taking place in the last chat message,',
        'keywords to describe {{char}}\'s physical appearance and facial expression,',
        'keywords to describe {{char}}\'s actions,',
        'keywords to describe {{user}}\'s physical appearance and actions.',
        '',
        'If character actions involve direct physical interaction with another character, mention specifically which body parts interacting and how.',
        '',
        'A correctly formatted example response would be:',
        '\'(location),(character list by gender),(primary action), (relative character position) POV, (character 1\'s description and actions), (character 2\'s description and actions)\'',
    ].join('\n'),
    background: 'Ignore previous instructions and provide a detailed description of {{char}}\'s surroundings in the form of a comma-delimited list of keywords and phrases. The list must include all of the following items in this order: location, time of day, weather, lighting, and any other relevant details. Do not include descriptions of characters and non-visual qualities such as names, personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase \'background,\'. Ignore the rest of the story when crafting this description. Do not reply as {{char}} when writing this description, and do not attempt to continue the story.',
};

/** Sources that must not get the character's look tags - "Me" and "Background" are not the character. */
const SOURCES_WITHOUT_LOOK_TAGS = new Set(['me', 'background']);

const defaultSettings = {
    base_url: DEFAULT_BASE_URL,
    transport: 'auto',
    model: '',
    /**
     * '' means "let SwarmUI use the model's baked-in VAE".
     * SwarmUI rejects the UI-only value "Automatic" when it is sent to the API,
     * so the empty string is the correct "automatic" value for API clients.
     */
    vae: '',
    width: 832,
    height: 1216,
    steps: 25,
    cfg: 6,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    seed: -1,
    images: 1,
    prefix_tags: '',
    suffix_tags: '',
    negative_prompt: '',
    /** @type {{name: string, weight: number}[]} */
    loras: [],
    /** Weight pre-filled in the "add LoRA" box. */
    lora_weight: 0.8,
    /** Include per-character look tags in the prompt. */
    use_look_tags: true,
    /** Optional: hide SillyTavern's built-in image buttons so only this extension's button remains. */
    hide_builtin_buttons: false,
    /** Show an editable popup with the finished prompt right before the request is sent. */
    edit_before_generation: false,
    /** Watch outgoing user messages for image requests ("send me a picture of a cat") and generate automatically. */
    interactive_mode: false,
    /** Offer image generation to the chat model as a callable function tool. */
    function_tool: false,
    llm_prompt: false,
    llm_instruction: DEFAULT_LLM_INSTRUCTION,
    /** Cached dropdown contents so the UI is not empty after a reload. */
    resources: {
        models: [],
        loras: [],
        vaes: [],
        samplers: [],
        schedulers: [],
    },
};

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

/** @returns {any} SillyTavern context object */
function ctx() {
    return SillyTavern.getContext();
}

function log(...args) {
    console.log(LOG, ...args);
}

function warn(...args) {
    console.warn(LOG, ...args);
}

function logError(...args) {
    console.error(LOG, ...args);
}

/**
 * SwarmUI cleans parameter IDs by lowercasing and dropping everything that is
 * not a letter (T2IParamTypes.cs -> CleanTypeName).
 * @param {string} name Parameter display name, e.g. "CFG Scale"
 * @returns {string} Parameter ID, e.g. "cfgscale"
 */
function cleanTypeName(name) {
    return String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/** Converts a UI value to a number; an empty value falls back instead of becoming 0. */
function asNumber(value, fallback) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
        return fallback;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function asBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    return ['true', 'on', 'yes', '1'].includes(String(value ?? '').trim().toLowerCase());
}

/** @returns {string} URL without a trailing slash, with a scheme. */
function normalizeBaseUrl(url) {
    let base = String(url ?? '').trim();
    if (!base) {
        base = DEFAULT_BASE_URL;
    }
    if (!/^https?:\/\//i.test(base)) {
        base = `http://${base}`;
    }
    return base.replace(/\/+$/, '');
}

/** Encodes a SwarmUI output path ("View/local/raw/...") for use in a URL. */
function encodeImagePath(path) {
    return String(path)
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

/** Collapses a blob into raw base64 (no data URL prefix). */
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result ?? '');
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the image data'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Pulls SwarmUI's prompt-parser warnings (unknown LoRA name, broken weight, …) out of a
 * generated PNG. SwarmUI only reports these inside the image metadata, so without this the
 * generation just silently ignores the offending tag.
 * @param {string} base64 Raw image data, no data URL prefix
 * @returns {string[]}
 */
function readParserWarnings(base64) {
    try {
        const text = atob(base64);
        const key = text.indexOf('parser_warnings');
        if (key < 0) {
            return [];
        }
        const start = text.indexOf('[', key);
        if (start < 0) {
            return [];
        }
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const char = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') inString = true;
            else if (char === '[' || char === '{') depth++;
            else if (char === ']' || char === '}') {
                depth--;
                if (depth === 0) {
                    const parsed = JSON.parse(text.slice(start, i + 1));
                    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
                }
            }
        }
        return [];
    } catch (error) {
        warn('Could not read the SwarmUI prompt warnings from the image.', error);
        return [];
    }
}

/**
 * Normalizes a comma separated tag list: collapses whitespace, removes empty
 * entries and duplicate commas. Mirrors Agnai's fixImagePrompt().
 * @param {string} prompt
 * @returns {string}
 */
function fixImagePrompt(prompt) {
    if (!prompt) {
        return '';
    }
    return String(prompt)
        .replace(/\s+/g, ' ')
        .replace(/,+/g, ',')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .join(', ');
}

/** Removes text that we never want inside an image prompt. */
function stripFormatting(text) {
    if (!text) {
        return '';
    }
    let out = String(text);
    out = out.replace(/<think[\s\S]*?<\/think>/gi, ' ');
    out = out.replace(/<thinking[\s\S]*?<\/thinking>/gi, ' ');
    out = out.replace(/<reasoning[\s\S]*?<\/reasoning>/gi, ' ');
    out = out.replace(/```[\s\S]*?```/g, ' ');
    out = out.replace(/^[\s\S]*?<\/think>/i, ' '); // unterminated <think> block
    out = out.replace(/["“”]/g, ' ');
    out = out.replace(/\r?\n/g, ', ');
    // Decompose accents so "café" becomes "cafe" instead of losing the letter.
    out = out.normalize('NFD');
    // Keep model syntax characters: , . : _ ( ) { } < > [ ] / - ' | #
    // Everything else (markdown asterisks, quotes, punctuation, CJK) becomes a space.
    out = out.replace(/[^a-zA-Z0-9.,:_(){}<>[\]/\-'|#]+/g, ' ');
    return fixImagePrompt(out);
}

/** Applies SillyTavern macros to a user supplied tag list without ever throwing. */
function substituteSafe(text) {
    if (!text) {
        return '';
    }
    try {
        return ctx().substituteParamsExtended(String(text)) ?? String(text);
    } catch (error) {
        warn('Macro substitution failed, using the raw text.', error);
        return String(text);
    }
}

function toastrSafe(kind, message, title = 'Swarm Image Gen') {
    try {
        toastr[kind](message, title);
    } catch {
        log(kind, message);
    }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/** @returns {any} The settings object, created/migrated on demand. */
function getSettings() {
    const context = ctx();
    if (!context.extensionSettings[EXTENSION_KEY] || typeof context.extensionSettings[EXTENSION_KEY] !== 'object') {
        context.extensionSettings[EXTENSION_KEY] = structuredClone(defaultSettings);
        log('Created default settings.');
    }

    const settings = context.extensionSettings[EXTENSION_KEY];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }

    // An early build had "hide the built-in image buttons" switched on by default and quietly removed
    // SillyTavern's own button. It is off by default now, and a stored "on" nobody actually chose is
    // dropped. Once the checkbox is used, hide_builtin_chosen remembers the real choice.
    if (settings.hide_builtin_buttons === true && settings.hide_builtin_chosen !== true) {
        settings.hide_builtin_buttons = false;
    }

    if (!Array.isArray(settings.loras)) {
        settings.loras = [];
    }
    settings.loras = settings.loras
        .filter((lora) => lora && typeof lora.name === 'string' && lora.name.length > 0)
        .map((lora) => ({ name: lora.name, weight: asNumber(lora.weight, 1) }));

    if (!settings.resources || typeof settings.resources !== 'object') {
        settings.resources = structuredClone(defaultSettings.resources);
    }
    for (const key of Object.keys(defaultSettings.resources)) {
        if (!Array.isArray(settings.resources[key])) {
            settings.resources[key] = [];
        }
    }

    if (typeof settings.llm_instruction !== 'string' || !settings.llm_instruction.trim()) {
        settings.llm_instruction = DEFAULT_LLM_INSTRUCTION;
    }

    // Migration: "Automatic" is a SwarmUI UI-only value and is rejected by the API.
    if (settings.vae === 'Automatic') {
        settings.vae = '';
    }

    return settings;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

/* ------------------------------------------------------------------ *
 * SwarmUI session / transport layer
 * ------------------------------------------------------------------ */

/** Current SwarmUI session id, or null. */
let sessionId = null;
/** Transport that last worked ('direct' | 'proxy'), or null when unknown. */
let resolvedTransport = null;
/** True while an image is being generated. */
let busy = false;

/** @returns {string[]} Transports to try, in order. */
function transportCandidates(override) {
    if (override) {
        return [override];
    }
    const preferred = resolvedTransport;
    const configured = getSettings().transport;
    const base = configured === 'direct' ? ['direct']
        : configured === 'proxy' ? ['proxy']
            : ['direct', 'proxy'];
    if (preferred && base.includes(preferred)) {
        return [preferred, ...base.filter((t) => t !== preferred)];
    }
    return base;
}

/**
 * Builds the request URL for a SwarmUI API endpoint.
 * @param {string} endpoint e.g. `/API/GetNewSession`
 * @param {'direct'|'proxy'} transport
 */
function buildApiUrl(endpoint, transport) {
    const base = normalizeBaseUrl(getSettings().base_url);
    const target = `${base}${endpoint}`;
    return transport === 'proxy' ? `/proxy/${target}` : target;
}

/**
 * Performs a single SwarmUI API call over a specific transport.
 * @param {string} endpoint API path
 * @param {object} payload JSON body
 * @param {{transport: string, timeout: number, signal?: AbortSignal}} options
 * @returns {Promise<object>} Parsed JSON body
 */
async function requestOnce(endpoint, payload, { transport, timeout, signal }) {
    const url = buildApiUrl(endpoint, transport);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout);
    const onAbort = () => controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        const text = await response.text();

        if (!response.ok) {
            let detail = text || response.statusText;
            let errorId = null;
            try {
                const parsed = JSON.parse(text);
                detail = parsed.error || parsed.detail || detail;
                errorId = parsed.error_id ?? null;
            } catch { /* not JSON */ }

            if (transport === 'proxy' && response.status === 404 && /CORS proxy is disabled/i.test(text)) {
                const err = new Error('CORS proxy is disabled');
                err.code = 'PROXY_DISABLED';
                err.errorId = 'proxy_disabled';
                throw err;
            }

            // SillyTavern's proxy returns a bare 500 when it cannot reach the target.
            if (transport === 'proxy' && response.status === 500 && /^\s*Internal Server Error\s*$/i.test(text)) {
                const err = new Error('SillyTavern could not reach SwarmUI through the proxy (is SwarmUI running at that URL?)');
                err.code = 'PROXY_UNREACHABLE';
                err.errorId = 'proxy_unreachable';
                throw err;
            }

            const err = new Error(`SwarmUI (${transport}) responded ${response.status}: ${String(detail).slice(0, 400)}`);
            err.status = response.status;
            err.errorId = errorId;
            err.transport = transport;
            throw err;
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(`SwarmUI (${transport}) returned a non-JSON response: ${String(text).slice(0, 200)}`);
        }

        if (data && typeof data === 'object' && data.error) {
            const err = new Error(String(data.error));
            err.errorId = data.error_id ?? null;
            err.transport = transport;
            throw err;
        }

        return data;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** True when a fetch failed because the request never reached the server. */
function isNetworkError(error) {
    if (!error) {
        return false;
    }
    if (error.code === 'PROXY_DISABLED' || error.code === 'PROXY_UNREACHABLE') {
        return true;
    }
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        return false;
    }
    // fetch() rejects with a TypeError for CORS violations and connection failures.
    return error instanceof TypeError || error.name === 'TypeError';
}

/**
 * Calls a SwarmUI API endpoint, handling transport fallback and expired sessions.
 * @param {string} endpoint `/API/...`
 * @param {object} payload JSON body (session_id is added automatically)
 * @param {{timeout?: number, signal?: AbortSignal, needsSession?: boolean, sessionRetry?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function apiCall(endpoint, payload = {}, options = {}) {
    const {
        timeout = REQUEST_TIMEOUT_MS,
        signal = null,
        needsSession = true,
        sessionRetry = true,
    } = options;

    if (needsSession && !sessionId) {
        await openSession();
    }

    const body = needsSession ? { session_id: sessionId, ...payload } : { ...payload };
    const errors = [];

    for (const transport of transportCandidates(null)) {
        try {
            const data = await requestOnce(endpoint, body, { transport, timeout, signal });
            if (resolvedTransport !== transport) {
                log(`Using "${transport}" transport for SwarmUI.`);
                resolvedTransport = transport;
            }
            return data;
        } catch (error) {
            if (error?.errorId === 'invalid_session_id' && needsSession && sessionRetry) {
                warn('SwarmUI session expired, opening a new one.');
                sessionId = null;
                await openSession(transport);
                const retryBody = { session_id: sessionId, ...payload };
                const retried = await requestOnce(endpoint, retryBody, { transport, timeout, signal });
                resolvedTransport = transport;
                return retried;
            }

            errors.push(error);

            if (error?.code === 'PROXY_DISABLED') {
                // Pointless to retry the same transport, but direct may still work.
                warn('SillyTavern CORS proxy is disabled.');
            }

            const retryable = isNetworkError(error);
            log(`Transport "${transport}" failed${retryable ? ' (network/CORS)' : ''}:`, error?.message ?? error);

            if (!retryable) {
                throw error;
            }
        }
    }

    const last = errors.at(-1);
    const aggregate = new Error(buildTransportErrorMessage(errors));
    aggregate.cause = last;
    aggregate.transports = errors.map((e) => e.transport ?? 'direct');
    throw aggregate;
}

function buildTransportErrorMessage(errors) {
    const hasProxyDisabled = errors.some((e) => e?.code === 'PROXY_DISABLED');
    const unreachable = errors.some((e) => e?.code === 'PROXY_UNREACHABLE');
    const parts = ['Could not reach SwarmUI.'];
    if (unreachable) {
        parts.push('SillyTavern\'s proxy could not connect to that address.');
    }
    if (hasProxyDisabled) {
        parts.push('SillyTavern\'s CORS proxy is disabled, so enable it in config.yaml (enableCorsProxy: true) or start SillyTavern with --corsProxy.');
    }
    if (errors.length > 1 || hasProxyDisabled || unreachable) {
        parts.push('If SwarmUI is running, allow this page\'s origin in SwarmUI (AccessControlAllowOrigin) or use the proxy transport.');
    }
    const details = errors.map((e) => `• ${e?.transport ?? '?'}: ${e?.message ?? e}`).join('\n');
    return `${parts.join(' ')}\n${details}`;
}

/** Opens a new SwarmUI session (and remembers which transport worked). */
async function openSession(transportOverride = null) {
    const payload = {};
    const errors = [];
    for (const transport of transportCandidates(transportOverride)) {
        try {
            const data = await requestOnce('/API/GetNewSession', payload, {
                transport,
                timeout: REQUEST_TIMEOUT_MS,
                signal: null,
            });
            if (!data?.session_id) {
                throw new Error(`SwarmUI did not return a session id: ${JSON.stringify(data).slice(0, 200)}`);
            }
            sessionId = data.session_id;
            resolvedTransport = transport;
            log(`New SwarmUI session ${sessionId} over "${transport}" (SwarmUI ${data.version ?? '?'}).`);
            return sessionId;
        } catch (error) {
            errors.push(error);
            if (!isNetworkError(error)) {
                throw error;
            }
        }
    }
    const aggregate = new Error(buildTransportErrorMessage(errors));
    aggregate.cause = errors.at(-1);
    throw aggregate;
}

/** Drops the cached session so the next call creates a fresh one. */
function invalidateSession() {
    sessionId = null;
    resolvedTransport = null;
}

/* ------------------------------------------------------------------ *
 * Resource loading (Connect)
 * ------------------------------------------------------------------ */

/**
 * @param {'Stable-Diffusion'|'LoRA'|'VAE'|'Embedding'} subtype
 * @returns {Promise<object[]>} Model file entries
 */
async function listModels(subtype) {
    const data = await apiCall('/API/ListModels', { path: '', depth: 12, subtype });
    return Array.isArray(data?.files) ? data.files : [];
}

/**
 * Loads models/LoRAs/VAEs/samplers from SwarmUI into the settings cache.
 * @param {{silent?: boolean}} [options] Silent mode only updates the status line.
 */
async function connect({ silent = false } = {}) {
    const settings = getSettings();
    const status = $('#swarm_status');
    status.removeClass('swarm-ok swarm-error').text('Connecting…');

    invalidateSession();

    try {
        await openSession();

        const [sdFiles, loraFiles, vaeFiles, params] = await Promise.all([
            listModels('Stable-Diffusion'),
            listModels('LoRA'),
            listModels('VAE'),
            apiCall('/API/ListT2IParams'),
        ]);

        const paramList = Array.isArray(params?.list) ? params.list : [];
        const findParam = (name) => paramList.find((p) => p.name === name);
        const samplerParam = findParam('Sampler');
        const schedulerParam = findParam('Scheduler');

        settings.resources = {
            models: sdFiles.map((f) => String(f.name)).filter(Boolean).sort((a, b) => a.localeCompare(b)),
            loras: loraFiles.map((f) => ({
                name: String(f.name),
                title: f.title ? String(f.title) : String(f.name).replace(/\.[^.]+$/, ''),
                trigger: f.trigger_phrase ? String(f.trigger_phrase) : '',
                // SwarmUI reports "" when the LoRA has no default weight of its own.
                default_weight: String(f.lora_default_weight ?? '').trim() === ''
                    ? null
                    : asNumber(f.lora_default_weight, null),
            })),
            vaes: vaeFiles.map((f) => String(f.name)).filter(Boolean).sort((a, b) => a.localeCompare(b)),
            samplers: Array.isArray(samplerParam?.values) ? samplerParam.values.map(String) : [],
            schedulers: Array.isArray(schedulerParam?.values) ? schedulerParam.values.map(String) : [],
        };
        settings.sampler_names = Array.isArray(samplerParam?.value_names) ? samplerParam.value_names.map(String) : [];
        settings.scheduler_names = Array.isArray(schedulerParam?.value_names) ? schedulerParam.value_names.map(String) : [];
        if (!settings.model && settings.resources.models.length > 0) {
            settings.model = settings.resources.models[0];
        }
        saveSettings();
        renderAllControls();

        const transportLabel = resolvedTransport === 'proxy' ? 'via SillyTavern proxy' : 'direct';
        const summary = `${settings.resources.models.length} checkpoint(s), ${settings.resources.loras.length} LoRA(s), ${settings.resources.samplers.length} sampler(s) — ${transportLabel}`;
        status.addClass('swarm-ok').text(`Connected. ${summary}`);
        log('Connect finished.', summary);
        if (!silent) {
            toastrSafe('success', `Connected to SwarmUI (${transportLabel}).`);
        }
        return true;
    } catch (error) {
        logError('Connect failed.', error);
        status.addClass('swarm-error').text(String(error?.message ?? error).split('\n')[0]);
        if (!silent) {
            toastrSafe('error', String(error?.message ?? error).split('\n')[0]);
        }
        return false;
    }
}

/* ------------------------------------------------------------------ *
 * Settings UI
 * ------------------------------------------------------------------ */

/**
 * Fills a <select> with values, keeping the current selection when possible.
 * @param {string} selector
 * @param {string[]} values
 * @param {string} current
 * @param {{labels?: string[], lead?: (string|{value: string, label: string})[], placeholder?: string}} [options]
 */
function fillSelect(selector, values, current, options = {}) {
    const { labels = null, lead = [], placeholder = '— click Connect —' } = options;
    const $select = $(selector);
    if (!$select.length) {
        return;
    }

    const items = [];
    for (const entry of lead) {
        items.push(typeof entry === 'string' ? { value: entry, label: entry } : entry);
    }
    values.forEach((value, index) => {
        items.push({ value, label: labels?.[index] ? `${labels[index]} (${value})` : value });
    });

    const known = new Set(items.map((item) => item.value));
    const keepCurrent = Boolean(current) && !known.has(current);
    $select.empty();

    if (items.length === 0 && !keepCurrent) {
        $('<option></option>').val('').text(placeholder).appendTo($select);
        return;
    }

    for (const item of items) {
        $('<option></option>').val(item.value).text(item.label).appendTo($select);
    }

    if (keepCurrent) {
        const label = items.length > 0 ? `${current} (not on server)` : current;
        $('<option></option>').val(current).text(label).appendTo($select);
    }

    // Keep the stored value selected, otherwise fall back to the first entry.
    $select.val(current || $select.find('option').first().val());
}

/** Repaints every dynamic control from the settings object. */
function renderAllControls() {
    const settings = getSettings();

    fillSelect('#swarm_model', settings.resources.models, settings.model);
    fillSelect('#swarm_vae', settings.resources.vaes, settings.vae, {
        lead: [
            { value: '', label: 'Automatic (use the model\'s own VAE)' },
            { value: 'None', label: 'None' },
        ],
    });
    fillSelect('#swarm_sampler', settings.resources.samplers, settings.sampler, {
        labels: settings.sampler_names ?? [],
    });
    fillSelect('#swarm_scheduler', settings.resources.schedulers, settings.scheduler, {
        labels: settings.scheduler_names ?? [],
    });

    fillLoraSelect();

    $('#swarm_base_url').val(settings.base_url);
    $('#swarm_transport').val(settings.transport);
    $('#swarm_width').val(settings.width);
    $('#swarm_height').val(settings.height);
    $('#swarm_steps').val(settings.steps);
    $('#swarm_cfg').val(settings.cfg);
    $('#swarm_seed').val(settings.seed);
    $('#swarm_images').val(settings.images);
    $('#swarm_prefix_tags').val(settings.prefix_tags);
    $('#swarm_suffix_tags').val(settings.suffix_tags);
    $('#swarm_negative_prompt').val(settings.negative_prompt);
    $('#swarm_llm_prompt').prop('checked', !!settings.llm_prompt);
    $('#swarm_llm_instruction').val(settings.llm_instruction);
    $('#swarm_lora_weight').val(settings.lora_weight);

    if (!settings.resources.models.length) {
        $('#swarm_status').text('Not connected. Set the URL and press Connect.');
    }

    renderLoraChips();
    updateLookTagsUi();
}

/** SwarmUI resolves LoRAs by name, so the file extension is stripped from the tag. */
function loraTagName(lora) {
    return String(lora?.name ?? '').replace(/\.(safetensors|sft|ckpt|pt)$/i, '');
}

/**
 * Builds the `<lora:name:weight>` tags for every active LoRA chip.
 * @param {{loras?: {name: string, weight: number}[]}} [settings]
 * @returns {string} Comma separated tags, or '' when no LoRA is active
 */
function buildLoraTags(settings = getSettings()) {
    return (settings.loras ?? []).map((lora) => `<lora:${loraTagName(lora)}:${lora.weight}>`).join(', ');
}

/**
 * Removes `<lora:...>` tags for LoRAs that are active in the panel from a hand edited
 * chat prompt. The chips stay authoritative: buildPrompt() appends their own tags and
 * weights, so a tag typed by hand would otherwise apply the same LoRA twice.
 * @param {string} scene
 * @returns {string}
 */
function removeActiveLoraTags(scene) {
    const active = getSettings().loras ?? [];
    if (!active.length || !/<lora:/i.test(String(scene ?? ''))) {
        return String(scene ?? '');
    }

    const removed = [];
    const out = String(scene).replace(/<lora:[^>]*>/gi, (tag) => {
        const lora = active.find((entry) => tag.toLowerCase().includes(loraTagName(entry).toLowerCase()));
        if (!lora) {
            return tag;
        }
        removed.push(loraTagName(lora));
        return '';
    });

    if (removed.length === 0) {
        return String(scene);
    }
    log('Removed hand-written LoRA tag(s) from the chat prompt, the active LoRAs are used instead:', removed.join(', '));
    return fixImagePrompt(out);
}

/**
 * Repaints the LoRA dropdown, ticking the LoRAs that are active. The tick in the list is the
 * only feedback some phones show, since the chip row can sit below the visible area.
 */
function fillLoraSelect() {
    const settings = getSettings();
    const loras = Array.isArray(settings.resources.loras) ? settings.resources.loras : [];
    const $select = $('#swarm_lora_select');
    if (!$select.length) {
        return;
    }

    const current = String($select.val() ?? '');
    const active = new Set((settings.loras ?? []).map((lora) => lora.name));
    $select.empty();

    if (loras.length === 0) {
        $('<option></option>').val('').text('— no LoRAs found —').appendTo($select);
        return;
    }

    for (const lora of loras) {
        // "Title (file.safetensors)" only when the title adds something over the file name.
        const plainName = String(lora.name).replace(/\.[^.]+$/, '');
        const label = lora.title && lora.title !== plainName ? `${lora.title} (${lora.name})` : lora.name;
        $('<option></option>')
            .val(lora.name)
            .text(`${active.has(lora.name) ? '✓ ' : ''}${label}`)
            .appendTo($select);
    }

    $select.val(loras.some((lora) => lora.name === current) ? current : loras[0].name);
}

function renderLoraChips() {
    const settings = getSettings();
    const $chips = $('#swarm_lora_chips');
    if (!$chips.length) {
        return;
    }
    $chips.empty();

    if (!settings.loras.length) {
        $chips.append($('<span class="swarm-chips-empty"></span>').text('No active LoRAs — choose one above to activate it.'));
        return;
    }

    settings.loras.forEach((lora, index) => {
        const $chip = $('<span class="swarm-chip"></span>');
        $chip.append($('<span class="swarm-chip-name"></span>').text(lora.name).attr('title', lora.name));
        $chip.append($('<span class="swarm-chip-weight"></span>').text(`:${lora.weight}`));
        const $remove = $('<i class="fa-solid fa-xmark swarm-chip-remove" title="Remove"></i>');
        $remove.on('click', () => {
            settings.loras.splice(index, 1);
            saveSettings();
            renderLoraChips();
            fillLoraSelect();
        });
        $chip.append($remove);
        $chips.append($chip);
    });
}

function addLoraFromUi() {
    const settings = getSettings();
    const name = String($('#swarm_lora_select').val() ?? '').trim();
    if (!name) {
        toastrSafe('warning', 'Pick a LoRA first (press Connect if the list is empty).');
        return;
    }
    const weight = asNumber($('#swarm_lora_weight').val(), settings.lora_weight);
    const existing = settings.loras.find((l) => l.name === name);
    if (existing) {
        existing.weight = weight;
    } else {
        settings.loras.push({ name, weight });
    }
    settings.lora_weight = weight;
    saveSettings();
    renderLoraChips();
    fillLoraSelect();
    if (weight === 0) {
        toastrSafe('warning', 'A LoRA weight of 0 disables the LoRA; use a value like 0.8.');
    }
    log(`LoRA set: ${name}:${weight}`);
}

/* ------------------------------------------------------------------ *
 * Per-character look tags
 * ------------------------------------------------------------------ */

/** @type {Map<string, string>} avatar -> tags, avoids repeated server reads */
const lookTagsCache = new Map();
let lookTagsSaveTimer = null;

/**
 * @param {{characterId?: number|string, avatar?: string}} [target]
 * @returns {{avatar: string|null, character: any|null}}
 */
function resolveCharacter(target = {}) {
    const context = ctx();
    if (target.avatar) {
        const character = context.characters?.find((c) => c?.avatar === target.avatar) ?? null;
        return { avatar: target.avatar, character };
    }
    const id = target.characterId ?? context.characterId;
    if (id === undefined || id === null || id === '' || !context.characters?.[id]) {
        return { avatar: null, character: null };
    }
    return { avatar: context.characters[id].avatar ?? null, character: context.characters[id] };
}

/** @returns {string} Look tags for an avatar, from cache or the character card. */
function readLookTags(avatar) {
    if (!avatar) {
        return '';
    }
    if (lookTagsCache.has(avatar)) {
        return lookTagsCache.get(avatar);
    }
    const character = ctx().characters?.find((c) => c?.avatar === avatar);
    const raw = character?.data?.extensions?.[LOOK_TAGS_KEY];
    const value = typeof raw === 'string' ? raw : '';
    lookTagsCache.set(avatar, value);
    return value;
}

/** Persists look tags on the character card. */
async function writeLookTags(avatar, value) {
    const context = ctx();
    const index = context.characters?.findIndex((c) => c?.avatar === avatar) ?? -1;
    if (index < 0) {
        warn('Cannot save look tags: character not found for avatar', avatar);
        return;
    }
    lookTagsCache.set(avatar, value);
    try {
        await context.writeExtensionField(index, LOOK_TAGS_KEY, value);
    } catch (error) {
        logError('Failed to save look tags.', error);
        toastrSafe('error', 'Could not save the character look tags.');
    }
}

function queueLookTagsSave(avatar, value) {
    lookTagsCache.set(avatar, value);
    if (lookTagsSaveTimer) {
        clearTimeout(lookTagsSaveTimer);
    }
    lookTagsSaveTimer = setTimeout(() => {
        lookTagsSaveTimer = null;
        writeLookTags(avatar, value);
    }, LOOK_TAGS_SAVE_DELAY_MS);
}

/** Currently displayed character in the look tags box. */
function currentLookTagsAvatar() {
    const context = ctx();
    if (context.groupId) {
        return null;
    }
    return resolveCharacter().avatar;
}

function updateLookTagsUi() {
    const $target = $('#swarm_look_tags_target');
    const $input = $('#swarm_look_tags');
    if (!$target.length || !$input.length) {
        return;
    }

    const context = ctx();
    if (context.groupId) {
        $target.text('Group chat: look tags are taken from the character that wrote the message.');
        $input.val('').prop('disabled', true);
        return;
    }

    const { avatar, character } = resolveCharacter();
    if (!avatar || !character) {
        $target.text('No character selected.');
        $input.val('').prop('disabled', true);
        return;
    }

    $target.text(`Editing look tags for: ${character.name ?? avatar}`);
    $input.prop('disabled', false);
    $input.val(readLookTags(avatar));
}

/* ------------------------------------------------------------------ *
 * Prompt building
 * ------------------------------------------------------------------ */

/**
 * Assembles the final SwarmUI prompt.
 * @param {{scene: string, lookTags?: string, settings?: any}} options
 * @returns {string}
 */
function buildPrompt({ scene, lookTags = '', settings = getSettings() }) {
    const parts = [
        substituteSafe(lookTags),
        substituteSafe(settings.prefix_tags),
        scene,
        substituteSafe(settings.suffix_tags),
    ].filter((part) => part && String(part).trim().length > 0);

    const base = fixImagePrompt(parts.join(', '));
    // LoRA tags are appended after cleanup so they are never mangled.
    const loraTags = buildLoraTags(settings);

    return loraTags ? (base ? `${base}, ${loraTags}` : loraTags) : base;
}

function buildNegativePrompt() {
    const settings = getSettings();
    return fixImagePrompt(substituteSafe(settings.negative_prompt));
}

/** @returns {any|null} The most recent usable chat message (the built-in extension's "last message"). */
function lastUsableMessage() {
    const context = ctx();
    return (context.chat ?? []).slice().reverse().find((m) => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) ?? null;
}

/** @returns {any|null} The character card that belongs to the last usable message. */
function characterOfLastMessage() {
    const context = ctx();
    const message = lastUsableMessage();
    if (!message) {
        return null;
    }
    if (context.groupId) {
        return (context.characters ?? []).find((c) => c?.avatar === message.original_avatar) ?? null;
    }
    return context.characters?.[context.characterId] ?? null;
}

/** @returns {string} The most recent usable chat message turned into tags. */
function lastMessagePrompt() {
    const message = lastUsableMessage();
    return message ? stripFormatting(message.mes) : '';
}

/**
 * "Raw Last Message": the last message exactly as written, followed by the character's
 * scenario and description with weights - the same composite the built-in extension sends.
 * @returns {string}
 */
function rawLastMessagePrompt() {
    const message = lastUsableMessage();
    if (!message) {
        return '';
    }
    const character = characterOfLastMessage();
    const scenario = stripFormatting(character?.scenario ?? character?.data?.scenario ?? '');
    const description = stripFormatting(character?.description ?? character?.data?.description ?? '');
    const parts = [`((${stripFormatting(message.mes)}))`];
    if (scenario) {
        parts.push(`(${scenario}:0.7)`);
    }
    if (description) {
        parts.push(`(${description}:0.5)`);
    }
    return parts.join(', ');
}

/**
 * Builds the scene part of the prompt for a "Send me a picture of:" source.
 * @param {string} source Key of PICTURE_SOURCES, or '' for the plain generation flow
 * @param {boolean} [forceLlm] Write the scene with the chat model even if the panel says otherwise
 * @returns {Promise<string>}
 */
async function sourceScenePrompt(source, forceLlm = false) {
    const settings = getSettings();
    if (source === 'raw_last') {
        return rawLastMessagePrompt();
    }
    if (source && SOURCE_INSTRUCTIONS[source]) {
        return await writeScenePrompt(substituteSafe(SOURCE_INSTRUCTIONS[source]));
    }
    return (forceLlm || settings.llm_prompt) ? await writeScenePrompt() : lastMessagePrompt();
}

/** @returns {{avatar: string|null}} Character that authored the last usable message. */
function lastMessageCharacter() {
    const context = ctx();
    const message = (context.chat ?? []).slice().reverse().find((m) => m && !m.is_system && !m.is_user);
    if (context.groupId && message?.original_avatar) {
        return { avatar: message.original_avatar };
    }
    if (!context.groupId) {
        return { avatar: resolveCharacter().avatar };
    }
    return { avatar: null };
}

/**
 * Asks the chat LLM to turn the recent chat into image tags.
 * @param {string} [instruction] Overrides the instruction configured in the panel
 * @returns {Promise<string>}
 */
async function writeScenePrompt(instruction = '') {
    const settings = getSettings();
    const quietPrompt = String(instruction || settings.llm_instruction || DEFAULT_LLM_INSTRUCTION);
    log('Asking the chat model for a prompt…');
    const result = await ctx().generateQuietPrompt({
        quietPrompt,
        quietToLoud: false,
        removeReasoning: true,
    });
    const cleaned = stripFormatting(result);
    log('LLM prompt:', cleaned);
    return cleaned;
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

/**
 * "Edit prompts before generation": shows the chat prompt - the text taken from the chat
 * (or typed by hand), without the look tags, prefix tags, suffix tags, LoRA tags and the
 * negative prompt - so it can be corrected, or the generation cancelled, before anything
 * reaches SwarmUI. Everything else is added afterwards, exactly as configured in the panel.
 * @param {string} sceneText The chat prompt to review
 * @returns {Promise<string>} The edited chat prompt
 * @throws {Error} An error with `.cancelled` set when the user cancels
 */
async function reviewSceneBeforeSending(sceneText) {
    const popupShow = ctx().Popup?.show;
    const cancelled = (message) => {
        const error = new Error(message);
        error.cancelled = true;
        return error;
    };

    if (typeof popupShow?.input !== 'function') {
        warn('This SillyTavern version has no popup API; sending the prompt as it is.');
        return String(sceneText ?? '');
    }

    const edited = await popupShow.input(
        'Review and edit the prompt:',
        'Press "Cancel" to abort the image generation.<br><small>Only the chat prompt is shown here — your look tags, prefix/suffix tags, LoRA tags and the negative prompt are added automatically.</small>',
        String(sceneText ?? '').trim(),
        {
            rows: 8,
            okButton: 'Continue',
            cancelButton: 'Cancel',
        },
    );

    if (edited === null || edited === undefined) {
        throw cancelled('Image generation cancelled.');
    }

    const scene = String(edited).trim();
    if (!scene) {
        throw cancelled('The prompt is empty; generation cancelled.');
    }

    log('Chat prompt reviewed before generation:', scene);
    return scene;
}

/**
 * Runs a full generation and posts the result to chat.
 * @param {{sceneText?: string, forceLlm?: boolean, quiet?: boolean, overrides?: object, targetAvatar?: string|null, source?: string}} options
 * @returns {Promise<string>} The saved image path (empty on failure).
 */
async function generateImage({ sceneText = '', forceLlm = false, quiet = false, overrides = {}, targetAvatar = null, source = '' } = {}) {
    if (busy) {
        toastrSafe('warning', 'An image is already being generated.');
        return '';
    }

    const settings = getSettings();
    busy = true;
    updateBusyUi(true);

    try {
        if (!settings.model && settings.resources.models.length === 0) {
            await connect();
        }
        if (!settings.model) {
            throw new Error('No checkpoint model selected. Press Connect and pick a model.');
        }

        // 1. The chat prompt: either the text we were given (message button, /swarm <text>,
        //    function tool) or what the chosen "Send me a picture of:" source produces.
        let scene = stripFormatting(sceneText);
        if (!scene) {
            scene = await sourceScenePrompt(source, forceLlm);
        }
        if (!scene) {
            throw new Error('No prompt text available. Send a chat message, or use /swarm <prompt>.');
        }

        // 2. Look tags for the right character ("Me" and "Background" are not the character)
        const skipLookTags = SOURCES_WITHOUT_LOOK_TAGS.has(source);
        const avatar = targetAvatar ?? lastMessageCharacter().avatar;
        const lookTags = settings.use_look_tags && !skipLookTags && avatar ? readLookTags(avatar) : '';
        if (sceneText && settings.use_look_tags && !skipLookTags && !avatar) {
            log('No character resolved for look tags; generating without them.');
        }

        // 3. Optional: show only the chat prompt and let it be corrected before sending.
        if (settings.edit_before_generation) {
            scene = removeActiveLoraTags(await reviewSceneBeforeSending(scene));
        }

        // 4. Parameters. Prefix, suffix, look and LoRA tags are added here - after the
        //    review - so the popup only ever shows the chat prompt itself.
        const params = {
            prompt: buildPrompt({ scene, lookTags, settings }),
            negativeprompt: buildNegativePrompt(),
            model: settings.model,
            sampler: overrides.sampler ?? settings.sampler,
            scheduler: overrides.scheduler ?? settings.scheduler,
            steps: asNumber(overrides.steps ?? settings.steps, 25),
            cfgscale: asNumber(overrides.cfg ?? settings.cfg, 6),
            width: Math.max(64, Math.round(asNumber(overrides.width ?? settings.width, 832))),
            height: Math.max(64, Math.round(asNumber(overrides.height ?? settings.height, 1216))),
            images: Math.max(1, Math.round(asNumber(overrides.images ?? settings.images, 1))),
            seed: Math.round(asNumber(overrides.seed ?? settings.seed, -1)),
        };
        if (overrides.model) {
            params.model = String(overrides.model);
        }
        const vae = overrides.vae ?? settings.vae;
        if (vae) {
            params.vae = String(vae);
        }

        log('Request:', {
            model: params.model,
            sampler: params.sampler,
            scheduler: params.scheduler,
            width: params.width,
            height: params.height,
            steps: params.steps,
            cfg: params.cfgscale,
            seed: params.seed,
            images: params.images,
            prompt: params.prompt,
            negative: params.negativeprompt,
        });

        // 5. Generate
        const started = performance.now();
        const result = await apiCall('/API/GenerateText2Image', params, {
            timeout: GENERATION_TIMEOUT_MS,
        });
        const seconds = ((performance.now() - started) / 1000).toFixed(1);

        const imagePath = Array.isArray(result?.images) && result.images.length > 0 ? String(result.images[0]) : '';
        if (!imagePath) {
            throw new Error(`SwarmUI did not return an image: ${JSON.stringify(result).slice(0, 300)}`);
        }
        log(`Generated ${imagePath} in ${seconds}s.`);

        // 6. Download and store inside SillyTavern's user images folder
        const { base64, format } = await downloadImage(imagePath);
        const chatIdBefore = ctx().getCurrentChatId();

        const context = ctx();
        const folder = context.groupId
            ? String(context.groupId)
            : (context.characters?.[context.characterId]?.name ?? '');
        const filename = `swarm_${folder || 'chat'}_${context.humanizedDateTime()}`;
        const savedPath = await saveBase64AsFile(base64, folder, filename, format);
        log(`Saved to ${savedPath}`);

        if (source === 'background') {
            await applyChatBackground(savedPath);
        }

        if (!quiet) {
            if (ctx().getCurrentChatId() !== chatIdBefore) {
                toastrSafe('warning', 'Chat changed, the generated image was not posted.');
                return savedPath;
            }
            await postImageToChat({ imageUrl: savedPath, prompt: params.prompt, negative: params.negativeprompt, width: params.width, height: params.height });
        }

        toastrSafe('success', `Image generated in ${seconds}s.`);
        return savedPath;
    } catch (error) {
        if (error?.cancelled) {
            toastrSafe('info', String(error.message ?? 'Image generation cancelled.'));
            return '';
        }
        if (error?.name === 'AbortError') {
            toastrSafe('info', 'Generation stopped.');
            return '';
        }
        logError('Generation failed.', error);
        toastrSafe('error', String(error?.message ?? error).split('\n')[0]);
        return '';
    } finally {
        busy = false;
        updateBusyUi(false);
    }
}

/**
 * The built-in extension treats "Background" as "make this the chat's background image",
 * so the picture generated with that source is applied here too.
 * @param {string} imagePath Path of the saved image inside SillyTavern's user images
 * @returns {Promise<void>}
 */
async function applyChatBackground(imagePath) {
    const context = ctx();
    const source = context.eventSource;
    const event = context.eventTypes?.FORCE_SET_BACKGROUND;
    if (!source?.emit || !event) {
        return;
    }
    try {
        await source.emit(event, { url: `url("${encodeURI(imagePath)}")`, path: imagePath });
        log('Set the generated image as the chat background.');
    } catch (error) {
        warn('Could not set the chat background.', error);
    }
}

/** Fetches a generated image from SwarmUI and returns it as base64 + format. */
async function downloadImage(imagePath) {
    const transport = resolvedTransport ?? 'direct';
    const base = normalizeBaseUrl(getSettings().base_url);
    const path = imagePath.replace(/^\/+/, '');
    const url = transport === 'proxy'
        ? `/proxy/${base}/${encodeImagePath(path)}`
        : `${base}/${encodeImagePath(path)}`;

    let response;
    try {
        response = await fetch(url, { headers: ctx().getRequestHeaders() });
    } catch (error) {
        // The API call worked but the image fetch did not: retry once over the  other transport.
        const fallback = transport === 'proxy' ? 'direct' : 'proxy';
        warn(`Image download over "${transport}" failed, retrying with "${fallback}".`, error);
        const fallbackUrl = fallback === 'proxy'
            ? `/proxy/${base}/${encodeImagePath(path)}`
            : `${base}/${encodeImagePath(path)}`;
        response = await fetch(fallbackUrl, { headers: ctx().getRequestHeaders() });
    }

    if (!response.ok) {
        throw new Error(`Could not download the generated image (HTTP ${response.status}).`);
    }

    const blob = await response.blob();
    const base64 = await blobToBase64(blob);
    const parserWarnings = readParserWarnings(base64);
    if (parserWarnings.length > 0) {
        warn('SwarmUI prompt warnings:', parserWarnings);
        toastrSafe('warning', parserWarnings.join(' ').slice(0, 300));
    }
    const extension = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png').toLowerCase();
    const format = ALLOWED_IMAGE_FORMATS.includes(extension) ? extension : 'png';
    return { base64, format };
}

/** Posts the generated image into the chat as a hidden-from-LLM system message. */
async function postImageToChat({ imageUrl, prompt, negative, width, height }) {
    const context = ctx();
    const name = context.groupId ? SYSTEM_USER_NAME : (context.name2 ?? SYSTEM_USER_NAME);

    const mediaAttachment = {
        url: imageUrl,
        type: MEDIA_TYPE_IMAGE,
        title: prompt,
        generation_type: GENERATION_TYPE_MESSAGE,
        negative: negative,
        source: MEDIA_SOURCE_GENERATED,
        width: width,
        height: height,
    };

    const message = {
        name: name,
        is_user: false,
        // System messages never reach the language model prompt.
        is_system: true,
        send_date: new Date().toISOString(),
        mes: prompt,
        extra: {
            media: [mediaAttachment],
            media_display: MEDIA_DISPLAY_GALLERY,
            media_index: 0,
            inline_image: false,
            swarm_image: true,
        },
    };

    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await context.eventSource.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
    setTimeout(() => {
        try {
            context.scrollOnMediaLoad();
        } catch { /* not fatal */ }
    }, SCROLL_DELAY_MS);
}

function updateBusyUi(isBusy) {
    $('.swarm_mes_gen').attr('data-swarm-busy', isBusy ? 'true' : 'false');
    $('#swarm_generate_now').attr('data-swarm-busy', isBusy ? 'true' : 'false');
}

/* ------------------------------------------------------------------ *
 * Message buttons
 * ------------------------------------------------------------------ */

const MESSAGE_BUTTON_CLASS = 'swarm_mes_gen';
// The wand icon is also used by this extension's own "Generate now" button, and it is
// deliberately different from the paintbrush of SillyTavern's built-in image extension,
// so the two buttons in a message's action row can never be confused with each other.
const MESSAGE_BUTTON_HTML = `<div title="Generate an image for this message (SwarmUI)" class="mes_button ${MESSAGE_BUTTON_CLASS} fa-solid fa-wand-magic-sparkles" data-i18n="[title]Generate an image for this message (SwarmUI)"></div>`;

/** Entry in SillyTavern's wand menu - the one next to the chat box that holds "Attach a File" and friends. */
const WAND_MENU_ITEM_HTML = `<div id="swarm_menu_gen" class="list-group-item flex-container flexGap5">
    <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton" title="Generate an image from the current chat with SwarmUI" data-i18n="[title]Generate an image from the current chat with SwarmUI"></div>
    <span data-i18n="Generate Image (SwarmUI)">Generate Image (SwarmUI)</span>
    <div id="swarm_source_toggle" class="extensionsMenuExtensionButton fa-solid fa-caret-right swarm-source-toggle" title="Choose what the picture should show (Yourself, Your Face, Me, the last message, ...)" data-i18n="[title]Choose what the picture should show (Yourself, Your Face, Me, the last message, ...)"></div>
</div>`;

/**
 * The "Send me a picture of:" list, with the same entries as the built-in Image Generation
 * extension. Like the built-in one it is appended to <body> so the wand menu's own scroll
 * container can never clip it.
 */
const SOURCE_MENU_HTML = `<ul id="swarm_source_menu" class="list-group">
    <span data-i18n="Send me a picture of:">Send me a picture of:</span>
    ${Object.entries(PICTURE_SOURCES).map(([key, label]) => `<li class="list-group-item" id="swarm_source_${key}" data-value="${key}" data-i18n="${label}">${label}</li>`).join('\n    ')}
</ul>`;

/** Guards against adding the source list twice (SillyTavern activates once per page load). */
let sourceMenuInstalled = false;

/**
 * Shows or hides the "Send me a picture of:" list above the caret. The built-in extension
 * anchors its version with Popper; a fixed position keeps this extension free of extra
 * dependencies and behaves the same on phones.
 * @param {boolean} [force] `true` shows, `false` hides, omitted toggles
 * @returns {void}
 */
function toggleSourceMenu(force) {
    const $menu = $('#swarm_source_menu');
    if (!$menu.length) {
        return;
    }

    const open = typeof force === 'boolean' ? force : $menu.css('display') !== 'block';
    if (!open) {
        $menu.css('display', 'none');
        return;
    }

    $menu.css({ display: 'block', left: '0px', top: '0px' });

    const element = $('#swarm_source_toggle').get(0);
    const rect = element?.getBoundingClientRect?.();
    const viewport = globalThis.window;
    if (!rect || !viewport) {
        return;
    }

    const menuHeight = $menu.get(0)?.offsetHeight || 280;
    const menuWidth = $menu.get(0)?.offsetWidth || 260;
    const above = rect.top - menuHeight > 8;
    const top = above ? rect.top - menuHeight : rect.bottom + 8;
    const left = Math.max(8, Math.min(rect.left, viewport.innerWidth - menuWidth - 8));
    $menu.css({
        left: `${Math.round(left)}px`,
        top: `${Math.round(Math.max(8, Math.min(top, viewport.innerHeight - menuHeight - 8)))}px`,
    });
}

/** Adds the "Send me a picture of:" list and wires it to the caret next to the menu entry. */
function installSourceMenu() {
    if (sourceMenuInstalled) {
        return;
    }
    sourceMenuInstalled = true;

    $('body').append(SOURCE_MENU_HTML);

    // The caret sits inside the wand menu entry, so the row's own click handler (which
    // generates an image) must not also fire when the list is opened.
    $(document).on('click', '#swarm_source_toggle', (event) => {
        event?.stopPropagation?.();
        toggleSourceMenu();
    });

    for (const [key, label] of Object.entries(PICTURE_SOURCES)) {
        $(`#swarm_source_${key}`).on('click', () => {
            toggleSourceMenu(false);
            log(`Picture source: ${label} (${key})`);
            return generateImage({ source: key });
        });
    }

    // Any click outside the caret and the list closes it again.
    $(document).on('click', (event) => {
        const target = $(event?.target);
        if (target.closest('#swarm_source_menu, #swarm_source_toggle').length) {
            return;
        }
        toggleSourceMenu(false);
    });
}

/** Adds the per-message button to the message template and to rendered messages. */
function injectMessageButtons() {
    const $templateButtons = $('#message_template .extraMesButtons');
    if ($templateButtons.length && !$templateButtons.find(`.${MESSAGE_BUTTON_CLASS}`).length) {
        $(MESSAGE_BUTTON_HTML).appendTo($templateButtons);
    }

    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find(`.${MESSAGE_BUTTON_CLASS}`).length) {
            $(MESSAGE_BUTTON_HTML).appendTo(this);
        }
    });
}

/** Ensures the button exists on a single message element. */
function ensureMessageButton(messageId) {
    const $buttons = $(`#chat .mes[mesid="${messageId}"] .extraMesButtons`);
    if ($buttons.length && !$buttons.find(`.${MESSAGE_BUTTON_CLASS}`).length) {
        $(MESSAGE_BUTTON_HTML).appendTo($buttons);
    }
}

async function onMessageButtonClick(event) {
    const $icon = $(event.currentTarget);
    const messageId = Number($icon.closest('.mes').attr('mesid'));
    const context = ctx();
    const message = context.chat?.[messageId];
    if (!message) {
        logError('Could not find the message for the SwarmUI button.', messageId);
        return;
    }

    if (message.extra?.swarm_image) {
        toastrSafe('info', 'This message is a generated image. Use /swarm or the message above it.');
        return;
    }

    const avatar = message.original_avatar ?? null;
    const scene = stripFormatting(message.mes);
    await generateImage({ sceneText: scene, targetAvatar: avatar });
}
/* ------------------------------------------------------------------ *
 * Slash command
 * ------------------------------------------------------------------ */

/**
 * Turns "/swarm you", "/swarm face", ... into the matching picture source, the same
 * shortcuts the built-in "/sd" command accepts.
 * @param {string} text The command's value
 * @returns {string} A key of PICTURE_SOURCES, or '' when the text is a normal prompt
 */
function pictureSourceOf(text) {
    const key = String(text ?? '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(PICTURE_SOURCES, key) ? key : '';
}

function registerSlashCommand() {
    const context = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, SlashCommandArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser || !SlashCommand) {
        warn('Slash command API is unavailable, /swarm is not registered.');
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'swarm',
        returns: 'URL of the generated image, or an empty string if the generation failed',
        callback: async (args, value) => {
            const text = String(value ?? '').trim();
            // "/swarm you", "/swarm face", ... use the same shortcuts as the source menu.
            const source = pictureSourceOf(text);
            const prompt = source ? '' : text;
            const overrides = {};
            for (const key of ['model', 'sampler', 'scheduler', 'vae', 'width', 'height', 'steps', 'cfg', 'seed', 'images']) {
                if (args?.[key] !== undefined && args[key] !== '' && args[key] !== null) {
                    overrides[key] = String(args[key]);
                }
            }
            return await generateImage({
                sceneText: prompt,
                source,
                forceLlm: !prompt && !source,
                quiet: asBoolean(args?.quiet),
                overrides,
            });
        },
        aliases: ['swarmui', 'swarmimage'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'do not post the generated image to the chat',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'model',
                description: 'checkpoint model override',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'sampler',
                description: 'sampler override',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'scheduler',
                description: 'scheduler override',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'vae',
                description: 'VAE override',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'width',
                description: 'image width',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'height',
                description: 'image height',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'steps',
                description: 'number of sampling steps',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cfg',
                description: 'CFG scale',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'seed',
                description: 'seed (-1 for random)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'images',
                description: 'how many images to generate',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                acceptsMultiple: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('prompt', [ARGUMENT_TYPE.STRING], false, false, null, null),
        ],
        helpString: `
            <div>
                Generates an image with SwarmUI and posts it to the chat as a system message (hidden from the model).
            </div>
            <div>
                <code>/swarm a cat on a throne</code> uses the given text as the scene prompt.<br>
                <code>/swarm</code> with no text asks the chat model to write the scene prompt from the recent chat
                (or uses the last message if "Let the chat LLM write the scene prompt" is disabled).<br>
                <code>/swarm you</code> (or <code>face</code>, <code>me</code>, <code>scene</code>, <code>last</code>,
                <code>raw_last</code>, <code>background</code>) uses the same "Send me a picture of:" sources as
                SillyTavern's built-in image menu.
            </div>
            <div>
                Active SwarmUI LoRAs, prefix/suffix tags and the current character's look tags are always applied.
            </div>
        `,
    }));

    log('Registered the /swarm slash command.');
}

/* ------------------------------------------------------------------ *
 * UI wiring
 * ------------------------------------------------------------------ */

function bindSettingsEvents() {
    const settings = getSettings();

    $('#swarm_connect').on('click', async () => {
        settings.base_url = String($('#swarm_base_url').val() ?? '').trim() || DEFAULT_BASE_URL;
        saveSettings();
        await connect();
    });

    $('#swarm_transport').on('change', () => {
        settings.transport = String($('#swarm_transport').val() ?? 'auto');
        invalidateSession();
        saveSettings();
        log(`Transport set to "${settings.transport}".`);
    });

    $('#swarm_base_url').on('input', () => {
        const value = String($('#swarm_base_url').val() ?? '').trim();
        if (settings.base_url !== value) {
            settings.base_url = value;
            invalidateSession();
            saveSettings();
        }
    });

    $('#swarm_model').on('change', () => {
        settings.model = String($('#swarm_model').val() ?? '');
        saveSettings();
    });

    $('#swarm_vae').on('change', () => {
        settings.vae = String($('#swarm_vae').val() ?? '');
        saveSettings();
    });

    const numberBindings = {
        '#swarm_width': 'width',
        '#swarm_height': 'height',
        '#swarm_steps': 'steps',
        '#swarm_cfg': 'cfg',
        '#swarm_seed': 'seed',
        '#swarm_images': 'images',
    };
    for (const [selector, key] of Object.entries(numberBindings)) {
        $(selector).on('input change', () => {
            settings[key] = asNumber($(selector).val(), settings[key]);
            saveSettings();
        });
    }

    $('#swarm_sampler').on('change', () => {
        settings.sampler = String($('#swarm_sampler').val() ?? '');
        saveSettings();
    });

    $('#swarm_scheduler').on('change', () => {
        settings.scheduler = String($('#swarm_scheduler').val() ?? '');
        saveSettings();
    });

    const textBindings = {
        '#swarm_prefix_tags': 'prefix_tags',
        '#swarm_suffix_tags': 'suffix_tags',
        '#swarm_negative_prompt': 'negative_prompt',
    };
    for (const [selector, key] of Object.entries(textBindings)) {
        $(selector).on('input', () => {
            settings[key] = String($(selector).val() ?? '');
            saveSettings();
        });
    }

    $('#swarm_llm_prompt').on('change', () => {
        settings.llm_prompt = !!$('#swarm_llm_prompt').prop('checked');
        saveSettings();
    });

    $('#swarm_llm_instruction').on('input', () => {
        settings.llm_instruction = String($('#swarm_llm_instruction').val() ?? '') || DEFAULT_LLM_INSTRUCTION;
        saveSettings();
    });

    $('#swarm_lora_add').on('click', () => addLoraFromUi());
    // Choosing a LoRA in the list activates it immediately: the dropdown and the weight box are
    // the live controls. The "+ Add" button only exists to re-apply the weight.
    $('#swarm_lora_select').on('change', () => {
        const settings = getSettings();
        const loras = settings.resources.loras ?? [];
        const selected = loras.find((lora) => lora.name === String($('#swarm_lora_select').val() ?? ''));
        const serverWeight = asNumber(selected?.default_weight, null);
        if (serverWeight !== null && serverWeight > 0) {
            $('#swarm_lora_weight').val(serverWeight);
        }
        addLoraFromUi();
    });
    // Retyping the weight updates the active chip of the selected LoRA on the fly.
    $('#swarm_lora_weight').on('input', () => {
        const settings = getSettings();
        const name = String($('#swarm_lora_select').val() ?? '');
        const lora = (settings.loras ?? []).find((entry) => entry.name === name);
        if (!lora) {
            return;
        }
        const weight = asNumber($('#swarm_lora_weight').val(), lora.weight);
        if (weight === lora.weight) {
            return;
        }
        lora.weight = weight;
        settings.lora_weight = weight;
        saveSettings();
        renderLoraChips();
    });
    $('#swarm_lora_weight').on('keydown', (event) => {
        if (event.key === 'Enter') {
            addLoraFromUi();
        }
    });

    const $lookTags = $('#swarm_look_tags');
    $lookTags.on('input', () => {
        const avatar = currentLookTagsAvatar();
        if (!avatar) {
            return;
        }
        queueLookTagsSave(avatar, String($lookTags.val() ?? ''));
    });

    $('#swarm_generate_now').on('click', async () => {
        await generateImage({});
    });

    $('#swarm_hide_builtin').prop('checked', settings.hide_builtin_buttons === true);
    $('#swarm_hide_builtin').on('change', () => {
        settings.hide_builtin_buttons = !!$('#swarm_hide_builtin').prop('checked');
        settings.hide_builtin_chosen = true;
        saveSettings();
        applyBuiltinImageUiVisibility();
    });

    const checkboxBindings = {
        '#swarm_edit_before_generation': 'edit_before_generation',
        '#swarm_interactive_mode': 'interactive_mode',
        '#swarm_function_tool': 'function_tool',
    };
    for (const [selector, key] of Object.entries(checkboxBindings)) {
        $(selector).prop('checked', settings[key] === true);
        $(selector).on('change', () => {
            settings[key] = !!$(selector).prop('checked');
            saveSettings();
            registerSwarmFunctionTool();
        });
    }

    $(document).on('click', '#swarm_menu_gen', () => generateImage({}));

    $(document).on('click', `.mes_button.${MESSAGE_BUTTON_CLASS}`, (event) => {
        if (busy) {
            toastrSafe('warning', 'An image is already being generated.');
            return;
        }
        onMessageButtonClick(event);
    });
}

/** Matches chat messages like "send me a picture of a cat" (the built-in extension uses a similar pattern). */
const INTERACTIVE_ACTIVATION_REGEX = /\b(send|mail|imagine|generate|make|create|draw|paint|render|show)\b.{0,10}\b(pic|picture|image|drawing|painting|photo|photograph)\b(?:\s+of)?(?:\s+(?:a|an|the|this|that|those|your)?\s+)?(.+)/i;

/** Name of the function tool offered to the chat model. */
const FUNCTION_TOOL_NAME = 'GenerateImageSwarmUI';
/** Display name of the function tool offered to the chat model. */
const FUNCTION_TOOL_DISPLAY_NAME = 'Generate Image (SwarmUI)';

/**
 * "Interactive mode": when the user's own message asks for a picture, generate it right away,
 * using the detected subject as the scene prompt.
 * @returns {Promise<void>}
 */
async function onMessageSentForInteractiveMode() {
    const settings = getSettings();
    if (!settings.interactive_mode || busy) {
        return;
    }
    // With the function tool enabled, the chat model itself decides when a picture is wanted.
    if (settings.function_tool && ctx().isToolCallingSupported?.()) {
        return;
    }

    const lastMessage = ctx().chat?.at(-1);
    if (!lastMessage?.is_user || !lastMessage.mes) {
        return;
    }

    const subject = String(lastMessage.mes).match(INTERACTIVE_ACTIVATION_REGEX)?.[3]?.trim();
    if (!subject) {
        return;
    }

    log(`Interactive mode: generating "${subject}"`);
    await generateImage({ sceneText: subject });
}

/**
 * "Use function tool": lets the chat model itself call SwarmUI through SillyTavern's tool
 * calling when the story calls for a picture.
 * @returns {void}
 */
function registerSwarmFunctionTool() {
    const context = ctx();
    const settings = getSettings();
    if (typeof context.registerFunctionTool !== 'function' || typeof context.unregisterFunctionTool !== 'function') {
        return; // SillyTavern too old for extension function tools.
    }

    context.unregisterFunctionTool(FUNCTION_TOOL_NAME);
    if (!settings.function_tool) {
        return;
    }
    if (typeof context.isToolCallingSupported === 'function' && !context.isToolCallingSupported()) {
        warn('The current chat completion source does not support function tools; the tool is ready but will only be used once one is selected.');
    }

    context.registerFunctionTool({
        name: FUNCTION_TOOL_NAME,
        displayName: FUNCTION_TOOL_DISPLAY_NAME,
        description: [
            'Generate an image from a text prompt with the local SwarmUI server and post it into the chat.',
            'Use it when the user asks for a picture, a photo, a drawing, a selfie, or to imagine a scene.',
        ].join(' '),
        parameters: Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'A comma separated image prompt in booru tag style, e.g. "1girl, red dress, garden, sunset".',
                },
            },
            required: ['prompt'],
        }),
        action: async (args) => {
            if (!args?.prompt) {
                throw new Error('Missing "prompt" argument.');
            }
            const url = await generateImage({ sceneText: String(args.prompt) });
            if (!url) {
                throw new Error('Image generation failed.');
            }
            return encodeURI(url);
        },
    });
}

function bindChatEvents() {
    const context = ctx();
    const events = context.eventTypes;
    const source = context.eventSource;

    source.on(events.CHARACTER_MESSAGE_RENDERED, (messageId) => ensureMessageButton(messageId));
    source.on(events.USER_MESSAGE_RENDERED, (messageId) => ensureMessageButton(messageId));
    source.on(events.CHAT_CHANGED, () => {
        updateLookTagsUi();
        setTimeout(injectMessageButtons, 50);
    });
    source.on(events.MESSAGE_DELETED, () => setTimeout(injectMessageButtons, 50));
    source.on(events.MORE_MESSAGES_LOADED, () => setTimeout(injectMessageButtons, 50));
    source.on(events.MESSAGE_SENT, () => onMessageSentForInteractiveMode());
    source.on(events.CHARACTER_EDITED, () => {
        lookTagsCache.clear();
        updateLookTagsUi();
    });
}

/** Guards against adding the wand-menu entry twice (SillyTavern activates once per page load). */
let wandMenuInstalled = false;

/**
 * Adds "Generate Image (SwarmUI)" to SillyTavern's wand menu, where the built-in
 * "Generate Image" entry also lives, so the button is where people look for it
 * instead of only inside the Extensions drawer.
 * @returns {void}
 */
function installWandMenuEntry() {
    if (wandMenuInstalled) {
        return;
    }
    const $menu = $('#extensionsMenu');
    if (!$menu.length) {
        return; // SillyTavern moved its menu: skip silently instead of breaking the page.
    }
    wandMenuInstalled = true;

    // Sit exactly where the built-in "Generate Image" entry sits (third item, after
    // "Attach a File") instead of at the bottom of the menu.
    const $builtinSlot = $('#sd_wand_container');
    if ($builtinSlot.length) {
        $builtinSlot.after(WAND_MENU_ITEM_HTML);
    } else {
        $menu.append(WAND_MENU_ITEM_HTML);
    }
}

/**
 * SillyTavern's built-in Image Generation extension always talks to its own backend
 * (ComfyUI, Automatic1111, Extras, ...) and can never use SwarmUI, so its buttons only
 * get in the way. They are hidden by default; the checkbox in the panel brings them back.
 * @returns {void}
 */
function applyBuiltinImageUiVisibility() {
    const hide = getSettings().hide_builtin_buttons === true;
    $('body').toggleClass('swarm-hide-builtin-image', hide);
}

/* ------------------------------------------------------------------ *
 * Entry point (manifest.json -> hooks.activate: "onActivate")
 * ------------------------------------------------------------------ */

/**
 * Loads settings.html from this module's own folder, whatever that folder is
 * called, so the extension keeps working when the folder is renamed by hand,
 * unzipped from a GitHub download (`swarm-image-gen-main`), or cloned under a
 * different repository name.
 * @returns {Promise<string>} The settings panel markup
 */
async function loadSettingsHtml() {
    try {
        const response = await fetch(new URL('settings.html', import.meta.url), { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        warn('Could not fetch settings.html next to the module, using the SillyTavern helper instead.', error);
        return await ctx().renderExtensionTemplateAsync('third-party/swarm-image-gen', 'settings');
    }
}

let activated = false;

/** Called by SillyTavern when the extension is activated. */
export async function onActivate() {
    if (activated) {
        return;
    }
    activated = true;

    try {
        log('Activating…');
    } catch (error) {
        logError('SillyTavern context is not available; the extension cannot start.', error);
        return;
    }

    try {
        getSettings();

        /** Each step is isolated: one failure must not disable the whole extension. */
        const steps = [
            ['settings panel', async () => {
                const html = await loadSettingsHtml();
                $('#extensions_settings2').append(html);
            }],
            ['function tool', async () => registerSwarmFunctionTool()],
            ['wand menu entry', async () => {
                installWandMenuEntry();
                applyBuiltinImageUiVisibility();
            }],
            ['picture sources', async () => installSourceMenu()],
            ['message buttons', async () => injectMessageButtons()],
            ['settings events', async () => bindSettingsEvents()],
            ['chat events', async () => bindChatEvents()],
            ['slash command', async () => registerSlashCommand()],
            ['controls', async () => renderAllControls()],
        ];

        for (const [name, step] of steps) {
            try {
                await step();
            } catch (error) {
                logError(`Failed to initialise the ${name}.`, error);
            }
        }

        log('Ready. Panel added to the Extensions drawer.');

        // Warm the connection up in the background when the extension is already configured,
        // so the model/LoRA lists are up to date without pressing Connect every session.
        const settings = getSettings();
        if (settings.model || settings.resources.models.length > 0) {
            connect({ silent: true });
        }
    } catch (error) {
        logError('Failed to start the extension.', error);
        toastrSafe('error', `Swarm Image Gen failed to start: ${error?.message ?? error}`);
    }
}
