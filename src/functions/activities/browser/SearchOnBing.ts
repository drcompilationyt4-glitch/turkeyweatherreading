import axios from 'axios'
import { randomInt } from 'crypto'
import type { Page } from 'patchright'
import * as fs from 'fs'
import path from 'path'

import { Workers } from '../../Workers'
import { QueryCore } from '../../QueryEngine'

import type { BasePromotion } from '../../../interface/DashboardData'

export class SearchOnBing extends Workers {

    private gainedPoints: number = 0
    private success: boolean = false
    private oldBalance: number = this.bot.userData.currentPoints

    // Model configuration with weights
    private readonly modelConfig = [
        { name: 'nvidia/nemotron-3-super-120b-a12b:free', weight: 1 / 4, supportsReasoning: false },
        { name: 'stepfun/step-3.5-flash:free', weight: 1 / 4, supportsReasoning: false },
        { name: 'minimax/minimax-m2.5:free', weight: 1 / 4, supportsReasoning: false },
        { name: 'nvidia/nemotron-nano-12b-v2-vl:free', weight: 1 / 4, supportsReasoning: false },
    ]

    public async doSearchOnBing(promotion: BasePromotion, page: Page) {
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-ON-BING',
            `Starting SearchOnBing | ${promotion.title}`
        )

        try {
            const queries = await this.getSearchQueries(promotion)
            await this.searchBing(page, queries)

            if (this.success) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Completed | gained=${this.gainedPoints}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-ON-BING',
                `Error: ${error}`
            )
        }
    }

    private async searchBing(page: Page, queries: string[]) {
        queries = [...new Set(queries)]

        for (const query of queries) {
            try {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Searching for: "${query}"`
                )

                // ✅ Go to Bing homepage first
                await page.goto('https://bing.com', { waitUntil: 'domcontentloaded' }).catch(() => {})
                await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())

                await this.bot.browser.utils.tryDismissAllMessages(page)

                // ✅ USE ALT+D THAT ALWAYS WORKS!
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING', 'Pressing Alt + D')
                await page.keyboard.press('Alt+D')
                await this.bot.utils.wait(500)

                // Fallback: try Ctrl+L if Alt+D didn't work
                try {
                    const isFocused = await page.evaluate(() => document.activeElement?.tagName === 'INPUT')
                    if (!isFocused) {
                        this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING', 'Fallback: Pressing Ctrl + L')
                        await page.keyboard.press('Control+L')
                        await this.bot.utils.wait(500)
                    }
                } catch {}

                // ✅ Type query human like
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING', 'Typing query...')
                await page.keyboard.type(query, {
                    delay: this.bot.utils.randomDelay(60, 120)
                })

                await this.bot.utils.wait(this.bot.utils.humanActivityDelay())

                // ✅ Press Enter
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING', 'Pressing Enter')
                await page.keyboard.press('Enter')

                await page.waitForLoadState('domcontentloaded').catch(() => {})
                await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())

                await this.bot.browser.utils.tryDismissAllMessages(page)

                const newBalance = await this.bot.browser.func.getCurrentPoints()
                const gained = newBalance - this.oldBalance

                if (gained > 0) {
                    this.gainedPoints = gained
                    this.bot.userData.currentPoints = newBalance
                    this.success = true
                    return
                }
            } catch (err) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Query failed: ${query}`
                )
            }

            await this.bot.utils.wait(this.bot.utils.randomDelay(4000, 9000))
        }
    }

    // 🔥 UPDATED: Hybrid Query System
    private async getSearchQueries(promotion: BasePromotion): Promise<string[]> {
        interface Queries {
            title: string
            queries: string[]
        }

        let queries: Queries[] = []
        let originalQuery = promotion.title

        try {
            // -----------------------------
            // LOAD ORIGINAL QUERY
            // -----------------------------
            if (this.bot.config.searchOnBingLocalQueries) {
                const data = fs.readFileSync(
                    path.join(__dirname, '../../bing-search-activity-queries.json'),
                    'utf8'
                )
                queries = JSON.parse(data)
            } else {
                const response = await this.bot.axios.request({
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/TheNetsky/Microsoft-Rewards-Script/refs/heads/v3/src/functions/bing-search-activity-queries.json'
                })
                queries = response.data
            }

            const match = queries.find(
                x => this.bot.utils.normalizeString(x.title) ===
                     this.bot.utils.normalizeString(promotion.title)
            )

            if (match && match.queries.length > 0) {
                originalQuery = this.bot.utils.shuffleArray(match.queries)[0]!
            } else {
                // ✅ WHEN QUERY NOT FOUND LOCALLY: USE LLM DIRECTLY
                const apiKey = process.env.OPENROUTER_API_KEY 
                if (apiKey) {
                    this.bot.logger.info(this.bot.isMobile, 'SEARCH-ON-BING', `No local query found, requesting from LLM: ${promotion.title}`)
                    const llmResult = await this.callLLM(promotion.title, promotion.description || '', promotion.title, apiKey)
                    if (llmResult) {
                        originalQuery = llmResult
                    } else {
                        // Fallback to suggestion system if LLM fails
                        const queryCore = new QueryCore(this.bot)
                        const desc = promotion.description?.toLowerCase().replace('search on bing', '').trim() || ''
                        const suggestions = await queryCore.getBingSuggestions(desc)
                        if (suggestions.length) {
                            originalQuery = this.bot.utils.shuffleArray(suggestions)[0]!
                        }
                    }
                } else {
                    // No API key, use original suggestion system
                    const queryCore = new QueryCore(this.bot)
                    const desc = promotion.description?.toLowerCase().replace('search on bing', '').trim() || ''
                    const suggestions = await queryCore.getBingSuggestions(desc)
                    if (suggestions.length) {
                        originalQuery = this.bot.utils.shuffleArray(suggestions)[0]!
                    }
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-QUERY',
                `Original: ${originalQuery}`
            )

            // -----------------------------
            // LLM PART
            // -----------------------------
            let llmQuery: string | null = null

            const apiKey =
                process.env.OPENROUTER_API_KEY 

            if (apiKey) {
                llmQuery = await this.callLLM(
                    promotion.title,
                    promotion.description || '',
                    originalQuery,
                    apiKey
                )
            }

            // -----------------------------
            // 60/40 DECISION
            // -----------------------------
            const useLLM = llmQuery && randomInt(0, 100) < 60
            const finalQuery = useLLM ? llmQuery! : originalQuery

            this.bot.logger.info(
                this.bot.isMobile,
                'SEARCH-QUERY',
                `Final (${useLLM ? 'LLM' : 'ORIGINAL'}): ${finalQuery}`
            )

            return [finalQuery]

        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-QUERY',
                `Error: ${error}`
            )
            return [promotion.title]
        }
    }

    private selectRandomModel(): { name: string, supportsReasoning: boolean } {
        const random = randomInt(0, 1000000) / 1000000
        let cumulativeWeight = 0
        for (const model of this.modelConfig) {
            cumulativeWeight += model.weight
            if (random <= cumulativeWeight) {
                return { name: model.name, supportsReasoning: model.supportsReasoning }
            }
        }
        return this.modelConfig[0]!
    }

    // 🔥 CLEAN LLM CALL
    private async callLLM(
        title: string,
        description: string,
        originalQuery: string,
        apiKey: string
    ): Promise<string | null> {
        try {
            const client = axios.create({
                baseURL: 'https://openrouter.ai/api/v1',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                proxy: false,
                timeout: 20000
            })

            const selectedModel = this.selectRandomModel()

            const prompt = `
Generate a natural Bing search query.

Title: "${title}"
Description: "${description}"
Original query: "${originalQuery}"

Improve it to sound human.
2-8 words only.
Return ONLY the query.
`

            const res = await client.post('/chat/completions', {
                model: selectedModel.name,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 50
            })

            const text = res.data?.choices?.[0]?.message?.content?.trim()
            if (!text) return null

            return text.split('\n')[0].trim()

        } catch (err) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LLM',
                `Failed: ${err}`
            )
            return null
        }
    }
}