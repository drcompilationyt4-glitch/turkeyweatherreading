// src/functions/activities/SearchOnBing.ts  (updated to include description in LLM context and disable proxy)
import { Page } from 'rebrowser-playwright'
import * as fs from 'fs'
import path from 'path'
import axios, { AxiosRequestConfig } from 'axios';

// If you want to load .env automatically when running locally, either
// call require('dotenv').config() in your app entry or uncomment the line below:
// import 'dotenv/config'

import { Workers } from '../Workers'

import { MorePromotion, PromotionalItem } from '../../interface/DashboardData'

// --- Hard disable proxying for axios in this module to avoid upstream 502 via corporate proxies ---
// This helps when environment variables like HTTP_PROXY/HTTPS_PROXY are present.
try {
    // global axios default
    (axios as any).defaults = (axios as any).defaults || {}
    ;(axios as any).defaults.proxy = false
} catch (e) {
    // ignore if we can't set it
}
try {
    // remove common env proxy vars in-process so node/http(s) libs won't pick them up
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
} catch { /* ignore */ }

export class SearchOnBing extends Workers {
    /**
     * Main flow to perform "Search on Bing" activity.
     */
    async doSearchOnBing(page: Page, activity: MorePromotion | PromotionalItem) {
        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'Trying to complete SearchOnBing')

        try {
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000))
            await this.bot.browser.utils.tryDismissAllMessages(page)

            // Pass both title and description (description may be undefined or empty)
            const query = await this.getSearchQuery(activity.title, (activity as any).description || '')

            const searchBar = '#sb_form_q'
            const box = page.locator(searchBar)
            await box.waitFor({ state: 'attached', timeout: 50000 }).catch(() => { /* fallback below */ })

            try {
                await this.bot.browser.utils.tryDismissAllMessages(page)
                await this.bot.utils.wait(200)

                await box.focus({ timeout: 60000 }).catch(() => { /* ignore focus errors */ })
                await box.fill('')
                await this.bot.utils.wait(200)
                await page.keyboard.type(query, { delay: 20 })
                await this.bot.utils.wait(this.bot.utils.randomNumber(200, 800))
                await page.keyboard.press('Enter')
            } catch (typeErr) {
                const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
                await page.goto(url).catch(() => { /* last-resort navigation */ })
            }

            await this.bot.utils.wait(this.bot.utils.randomNumber(3000, 5000))
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

            try { await page.close() } catch (e) { /* ignore close errors */ }

            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'Completed the SearchOnBing successfully')
        } catch (error) {
            try { await page.close() } catch { /* ignore */ }
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'An error occurred:' + String(error), 'error')
        }
    }

    /**
     * Resolve a short search query for a given promotion title and optional description.
     * Try LLM first (if an OpenRouter API key is available). If LLM fails or no key,
     * fall back to local queries.json or remote queries.json, then finally the title.
     */
    private async getSearchQuery(title: string, description: string = ''): Promise<string> {
        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

        interface Queries {
            title: string;
            queries: string[]
        }

        let queries: Queries[] = []

        try {
            // --- Attempt LLM first if API key present ---
            const envKey = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.trim() : undefined
            const cfgKey = this.bot.config?.openRouterApiKey ? String(this.bot.config.openRouterApiKey).trim() : undefined
            const apiKey = envKey || cfgKey

            if (apiKey) {
                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Attempting LLM-first fallback for title: ${title}`)
                try {
                    // Pass both title and description through to the LLM caller
                    const llmQuery = await this.callOpenRouterForQuery(title, description, apiKey)
                    if (llmQuery) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `LLM-first answer: ${llmQuery} | question: ${title}`)

                        if (this.bot.config && this.bot.config.cacheGeneratedQueries) {
                            try {
                                const localPath = path.join(__dirname, '../queries.json')
                                let existing: Queries[] = []
                                if (fs.existsSync(localPath)) {
                                    try {
                                        existing = JSON.parse(fs.readFileSync(localPath, 'utf8'))
                                        if (!Array.isArray(existing)) existing = []
                                    } catch {
                                        existing = []
                                    }
                                }
                                existing.push({ title, queries: [llmQuery] })
                                fs.writeFileSync(localPath, JSON.stringify(existing, null, 2), 'utf8')
                                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Cached generated query for title: ${title}`)
                            } catch (cacheErr) {
                                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Caching failed: ${String(cacheErr)}`, 'warn')
                            }
                        }

                        return llmQuery
                    } else {
                        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'LLM-first fallback returned empty or failed; continuing to other sources', 'warn')
                    }
                } catch (llmErr) {
                    // callOpenRouterForQuery already logs details; still note and continue.
                    this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `LLM-first attempt threw: ${String(llmErr)}. Falling back to queries.json`, 'warn')
                }
            } else {
                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'No OpenRouter API key found (process.env.OPENROUTER_API_KEY or bot.config.openRouterApiKey). Skipping LLM-first step.', 'log')
            }

            // --- If we get here, either no API key or LLM failed; proceed to local/remote queries ---

            if (this.bot.config && this.bot.config.searchOnBingLocalQueries) {
                const localPath = path.join(__dirname, '../queries.json')
                try {
                    const data = fs.readFileSync(localPath, 'utf8')
                    const parsed = JSON.parse(data)
                    if (Array.isArray(parsed)) queries = parsed
                    else queries = []
                } catch (err) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Failed to parse local queries.json: ' + String(err), 'warn')
                    queries = []
                }
            } else {
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1000))

                const axiosReq: AxiosRequestConfig = {
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/TheNetsky/Microsoft-Rewards-Script/refs/heads/main/src/functions/queries.json',
                    timeout: 8000,
                    responseType: 'text',
                    proxy: false // ensure axios does not use proxy for this request
                }

                // Use module-local axios (not this.bot.axios which may be configured with proxies)
                const response = await axios.request(axiosReq).catch(() => ({ data: null }))
                let remoteData: any = response && response.data ? response.data : null

                if (typeof remoteData === 'string') {
                    try {
                        remoteData = JSON.parse(remoteData)
                    } catch (parseErr) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Failed to JSON.parse remote queries.json; falling back to empty array', 'warn')
                        remoteData = null
                    }
                }

                if (Array.isArray(remoteData)) {
                    queries = remoteData
                } else if (remoteData && typeof remoteData === 'object') {
                    if (Array.isArray((remoteData as any).queries)) queries = (remoteData as any).queries
                    else if (Array.isArray((remoteData as any).default)) queries = (remoteData as any).default
                    else queries = []
                } else {
                    queries = []
                }
            }

            // Find match (normalized)
            const answers = Array.isArray(queries) ? queries.find(x => this.normalizeString(x.title) === this.normalizeString(title)) : undefined
            if (answers && Array.isArray(answers.queries) && answers.queries.length > 0) {
                const answer = this.bot.utils.shuffleArray(answers.queries)[0] as string
                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Found local/remote answer: ${answer} | question: ${title}`)
                return answer
            }

            // No LLM result earlier and no local/remote queries matched: fall back to title
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `No local/remote query found for: ${title}. Falling back to title for query.`)
            return title

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'An error occurred while resolving query:' + String(error), 'error')
            return title
        }
    }

    private normalizeString(input: string): string {
        // Normalize accents, remove diacritics, keep printable ASCII characters, remove question/exclamation,
        // normalize whitespace and lowercase for consistent comparisons.
        if (typeof input !== 'string') return ''
        const decomposed = input.normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
        const asciiOnly = decomposed.replace(/[^\x20-\x7E]/g, '') // printable ASCII
        const noPunct = asciiOnly.replace(/[?!]/g, '') // remove these punctuation (keep other characters)
        return noPunct.trim().toLowerCase()
    }

    /**
     * Calls OpenRouter's chat completions endpoint to generate a short query.
     * Sends both title and description as context; performs two-step reasoning flow when supported.
     */
    private async callOpenRouterForQuery(title: string, description: string = '', providedApiKey?: string): Promise<string | null> {
        try {
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 800));

            const envKey = providedApiKey || (process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.trim() : undefined);
            const cfgKey = this.bot.config?.openRouterApiKey ? String(this.bot.config.openRouterApiKey).trim() : undefined;
            const apiKey = envKey || cfgKey;

            if (!apiKey) {
                this.bot.log(this.bot.isMobile, 'OPENROUTER', 'Missing OpenRouter API key (process.env.OPENROUTER_API_KEY or bot.config.openRouterApiKey).', 'warn');
                return null;
            }

            // Build headers for OpenRouter (preserve optional config info)
            const defaultHeaders: Record<string, string> = {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            };
            if (this.bot.config?.openRouter?.referer) defaultHeaders['Referer'] = this.bot.config.openRouter.referer;
            else defaultHeaders['Referer'] = '<YOUR_SITE_URL>';
            if (this.bot.config?.openRouter?.title) defaultHeaders['X-Title'] = this.bot.config.openRouter.title;
            else defaultHeaders['X-Title'] = '<YOUR_SITE_NAME>';

            // Choose model and temperature from config if present
            const model = (this.bot.config && this.bot.config.openRouterModel) || 'meta-llama/llama-3.3-70b-instruct:free';
            const temperature = (this.bot.config && typeof this.bot.config.openRouterTemperature === 'number')
                ? this.bot.config.openRouterTemperature : 0.2;

            // Compose instruction and provide subtext including description
            const promptSystem = `You are a concise assistant that outputs a single short Bing search query. Output only the query (no commentary).`;
            const promptUser = `Promotional title: "${title}".`
            const promptSubtext = `Description/context: "${String(description || '').trim()}".
Instructions: Provide a concise search query (2-8 words) that a human would enter into Bing to find pages relevant to the promotion. Keep it natural-language, focused on the user's intent, and avoid including site names or tracking tokens. Output only the query on the first line.`;

            // Use axios to bypass proxy for this request only (and explicit timeout)
            const openRouterClient = axios.create({
                baseURL: 'https://openrouter.ai/api/v1',
                headers: defaultHeaders,
                proxy: false, // explicitly disable axios proxying (ignores HTTP(S)_PROXY env vars)
                timeout: 30_000,
            });

            // Build first-call payload with reasoning enabled where allowed
            const payload1: any = {
                model,
                messages: [
                    { role: 'system', content: promptSystem },
                    { role: 'user', content: `${promptUser}\n\n${promptSubtext}` }
                ],
                max_tokens: 64,
                temperature,
            };
            // include provider routing if configured
            if (this.bot.config && typeof this.bot.config.openRouterProvider !== 'undefined') {
                payload1.provider = this.bot.config.openRouterProvider
            }
            // enable reasoning if configured (many models may ignore this)
            const cfgEnable = typeof this.bot.config?.openRouterReasoningEnabled === 'boolean'
                ? this.bot.config.openRouterReasoningEnabled
                : true
            if (cfgEnable) payload1.reasoning = { enabled: true }

            // First request
            const resp1 = await openRouterClient.post('/chat/completions', payload1);
            const completion1 = resp1?.data;
            const firstMessage = completion1?.choices?.[0]?.message ?? null
            const firstText = firstMessage?.content ?? completion1?.choices?.[0]?.text ?? null

            if (!firstText && !firstMessage) {
                this.bot.log(this.bot.isMobile, 'OPENROUTER', 'OpenRouter returned no text content in first completion.', 'warn');
                // continue to allow fallbacks below
            }

            // If we have an assistant message, preserve any reasoning_details or reasoning and continue
            if (firstMessage && (firstMessage.reasoning_details || firstMessage.reasoning)) {
                const preservedAssistant: any = {
                    role: 'assistant',
                    content: firstMessage.content ?? String(firstText ?? '').trim()
                }
                if (firstMessage.reasoning_details) preservedAssistant.reasoning_details = firstMessage.reasoning_details
                if (firstMessage.reasoning) preservedAssistant.reasoning = firstMessage.reasoning

                // Build followup to refine final concise query
                const followupUser = { role: 'user', content: 'Are you sure? Think carefully and provide the concise final query (2-8 words).' }

                const payload2: any = {
                    model,
                    messages: [
                        { role: 'system', content: promptSystem },
                        { role: 'user', content: `${promptUser}\n\n${promptSubtext}` },
                        preservedAssistant,
                        followupUser
                    ],
                    max_tokens: 64,
                    temperature: Math.max(0.1, Math.min(0.5, (typeof this.bot.config?.openRouterTemperature === 'number' ? this.bot.config.openRouterTemperature : 0.2))),
                }
                if (this.bot.config && typeof this.bot.config.openRouterProvider !== 'undefined') payload2.provider = this.bot.config.openRouterProvider
                if (this.bot.config?.openRouterReasoningEnabled) payload2.reasoning = { enabled: true }

                const resp2 = await openRouterClient.post('/chat/completions', payload2);
                const completion2 = resp2?.data
                const llmText = completion2?.choices?.[0]?.message?.content ?? completion2?.choices?.[0]?.text ?? null

                if (!llmText) {
                    this.bot.log(this.bot.isMobile, 'OPENROUTER', 'OpenRouter returned no text content in second completion.', 'warn');
                    return null
                }

                // Minimal cleaning: remove fences and take the first non-empty line
                const stripFences = (txt: string) => String(txt).replace(/```(?:json)?/g, '').trim();
                const cleanedLines = stripFences(llmText).split(/\r?\n/).map(l => l.trim()).filter(l => l.length);

                const candidate: string = cleanedLines[0] ?? String(llmText).trim();
                const finalText: string | null = candidate === '' ? null : candidate;

                return finalText || null;
            }

            // If we didn't get reasoning_details, but have firstText, return a cleaned first line
            const fallbackText = firstText ?? (completion1 && typeof completion1 === 'string' ? completion1 : null)
            if (fallbackText) {
                const stripFences = (txt: string) => String(txt).replace(/```(?:json)?/g, '').trim();
                const cleanedLines = stripFences(fallbackText).split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
                const candidate: string = cleanedLines[0] ?? String(fallbackText).trim();
                const finalText: string | null = candidate === '' ? null : candidate;
                return finalText || null;
            }

            // No useful content
            this.bot.log(this.bot.isMobile, 'OPENROUTER', 'OpenRouter returned no usable content in completion(s).', 'warn');
            return null;

        } catch (err: any) {
            const status = err?.response?.status ?? err?.status;
            const errorData = err?.response?.data ?? err?.error;

            if (status === 404 && errorData) {
                const msg = (errorData?.message) || String(errorData);
                if (typeof msg === 'string' && msg.includes('No endpoints found matching your data policy')) {
                    this.bot.log(this.bot.isMobile, 'OPENROUTER', 'LLM call failed due to OpenRouter privacy settings. Please enable model endpoints at https://openrouter.ai/settings/privacy', 'error');
                    return null;
                }
            }

            if (errorData) {
                try {
                    const body = errorData;
                    if (body?.error) {
                        const emsg = body.error?.message ?? JSON.stringify(body.error);
                        const ecode = body.error?.code ?? status;
                        this.bot.log(this.bot.isMobile, 'OPENROUTER', `OpenRouter returned error (${ecode}): ${emsg}`, 'error');
                        return null;
                    }
                } catch (parseErr) {
                    this.bot.log(this.bot.isMobile, 'OPENROUTER', `Error parsing OpenRouter error body: ${parseErr}`, 'warn');
                }
            }

            const errMsg = err?.message || String(err);
            this.bot.log(this.bot.isMobile, 'OPENROUTER', 'LLM call failed: ' + errMsg, 'error');
            return null;
        }
    }


}
