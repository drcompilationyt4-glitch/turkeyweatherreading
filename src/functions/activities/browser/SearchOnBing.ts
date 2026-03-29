import axios from 'axios'
import { randomBytes } from 'crypto'
import type { Page } from 'patchright'
import * as fs from 'fs'
import path from 'path'

import { Workers } from '../../Workers'
import { QueryCore } from '../../QueryEngine'

import type { BasePromotion } from '../../../interface/DashboardData'

export class SearchOnBing extends Workers {
    private bingHome = 'https://bing.com'

    private gainedPoints: number = 0
    private success: boolean = false
    private oldBalance: number = this.bot.userData.currentPoints

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
                const cvid = randomBytes(16).toString('hex')
                const url = `${this.bingHome}/search?q=${encodeURIComponent(query)}&cvid=${cvid}`

                await page.goto(url)

                await page.waitForLoadState('networkidle').catch(() => {})
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
                const queryCore = new QueryCore(this.bot)
                const desc = promotion.description?.toLowerCase().replace('search on bing', '').trim() || ''
                const suggestions = await queryCore.getBingSuggestions(desc)

                if (suggestions.length) {
                    originalQuery = this.bot.utils.shuffleArray(suggestions)[0]!
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
            const useLLM = llmQuery && Math.random() < 0.6
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
                model: 'meta-llama/llama-3.3-70b-instruct:free',
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