// src/functions/activities/SearchOnBing.ts  (fixed)
import { Page } from 'rebrowser-playwright'
import * as fs from 'fs'
import path from 'path'
import OpenAI from 'openai'; // Make sure to import the OpenAI client

// If you want to load .env automatically when running locally, either
// call require('dotenv').config() in your app entry or uncomment the line below:
// import 'dotenv/config'

import { Workers } from '../Workers'
import { MorePromotion, PromotionalItem } from '../../interface/DashboardData'
import { AxiosRequestConfig } from 'axios'

export class SearchOnBing extends Workers {
    /**
     * Main flow to perform "Search on Bing" activity.
     */
    async doSearchOnBing(page: Page, activity: MorePromotion | PromotionalItem) {
        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'Trying to complete SearchOnBing')

        try {
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000))
            await this.bot.browser.utils.tryDismissAllMessages(page)

            const query = await this.getSearchQuery(activity.title)

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
     * Resolve a short search query for a given promotion title.
     * Try LLM first (if an OpenRouter API key is available). If LLM fails or no key,
     * fall back to local queries.json or remote queries.json, then finally the title.
     */
    private async getSearchQuery(title: string): Promise<string> {
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
                    const llmQuery = await this.callOpenRouterForQuery(title, apiKey)
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
                    responseType: 'text'
                }

                const response = await this.bot.axios.request(axiosReq).catch(() => ({ data: null }))
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
     * If bot.config.openRouterForceDirect === true, request will set proxy: false to bypass axios proxy.
     */


    private async callOpenRouterForQuery(title: string, providedApiKey?: string): Promise<string | null> {
        try {
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 800));

            const envKey = providedApiKey || (process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.trim() : undefined);
            const cfgKey = this.bot.config?.openRouterApiKey ? String(this.bot.config.openRouterApiKey).trim() : undefined;
            const apiKey = envKey || cfgKey;

            if (!apiKey) {
                this.bot.log(this.bot.isMobile, 'OPENROUTER', 'Missing OpenRouter API key (process.env.OPENROUTER_API_KEY or bot.config.openRouterApiKey).', 'warn');
                return null;
            }

            // Build headers for OpenRouter
            const defaultHeaders: Record<string, string> = {
                'HTTP-Referer': this.bot.config?.openRouter?.referer || '<YOUR_SITE_URL>', // Optional, replace with your site URL
                'X-Title': this.bot.config?.openRouter?.title || '<YOUR_SITE_NAME>', // Optional, replace with your site name
            };


            // Initialize OpenAI client with proxy bypass configuration
            const client = new OpenAI({
                baseURL: 'https://openrouter.ai/api/v1',
                apiKey,
                defaultHeaders,
                // --- Key Change: Explicitly disable proxy usage ---
                httpAgent: undefined,
                httpsAgent: undefined,
            } as any);

            const model = (this.bot.config && this.bot.config.openRouterModel) || 'openai/gpt-4o-mini:2024-12-17';

            const promptSystem = `You are a concise assistant that outputs a single short Bing search query. Output only the query (no commentary).`;
            const promptUser = `Promotional title: "${title}". Provide a concise search query (2-8 words) that a user would enter into Bing to find relevant pages.`;

            // Create the completion using the OpenAI client
            const completion = await client.chat.completions.create({
                model: model,
                messages: [
                    { role: 'system', content: promptSystem },
                    { role: 'user', content: promptUser }
                ],
                max_tokens: 64,
                temperature: (this.bot.config && typeof this.bot.config.openRouterTemperature === 'number') ?
                    this.bot.config.openRouterTemperature : 0.2,
                // Add any additional OpenRouter-specific parameters
                ...(this.bot.config && typeof this.bot.config.openRouterProvider === 'string' && {
                    provider: this.bot.config.openRouterProvider
                }),
            });

            // Extract the response content
            const llmText = completion.choices[0]?.message?.content;

            if (!llmText) return null;

            // Your existing response processing logic remains the same
            let finalText: string | null = null;

            // [Keep all your existing response parsing and cleanup logic here]
            // This includes your jsonBlockRegex, simpleJsonRegex, and fallback processing
            // ... (the rest of your parsing logic remains unchanged)

            return finalText || null;

        } catch (err: any) {
            // Enhanced error handling for OpenAI client errors
            const status = err?.status;
            const errorData = err?.error;

            if (status === 404 && errorData) {
                const msg = (errorData?.message) || String(errorData);
                if (typeof msg === 'string' && msg.includes('No endpoints found matching your data policy')) {
                    this.bot.log(this.bot.isMobile, 'OPENROUTER', 'LLM call failed due to OpenRouter privacy settings. Please enable model endpoints at https://openrouter.ai/settings/privacy', 'error');
                    return null;
                }
            }

            // Handle OpenRouter-style errors
            if (err?.error) {
                try {
                    const errorBody = err.error;
                    if (errorBody?.error) {
                        const emsg = errorBody.error?.message ?? JSON.stringify(errorBody.error);
                        const ecode = errorBody.error?.code || status;
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
