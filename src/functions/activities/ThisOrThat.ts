import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'
import { DELAYS } from '../../constants'

export class ThisOrThat extends Workers {
    // Fallbacks when DELAYS aren't present
    private static readonly START_TIMEOUT = (DELAYS && typeof DELAYS.THIS_OR_THAT_START === 'number') ? DELAYS.THIS_OR_THAT_START : 120000
    private static readonly AFTER_START_WAIT = (DELAYS && typeof DELAYS.THIS_OR_THAT_AFTER_START === 'number') ? DELAYS.THIS_OR_THAT_AFTER_START : 3000

    private static readonly DEFAULT_PRE_START_MIN = 1000
    private static readonly DEFAULT_PRE_START_MAX = 3000
    private static readonly DEFAULT_BEFORE_ANSWER_MIN = 1000
    private static readonly DEFAULT_BEFORE_ANSWER_MAX = 3000
    private static readonly DEFAULT_BEFORE_CLICK_MIN = 500
    private static readonly DEFAULT_BEFORE_CLICK_MAX = 1500
    private static readonly DEFAULT_AFTER_ANSWER_MIN = 2000
    private static readonly DEFAULT_AFTER_ANSWER_MAX = 5000

    async doThisOrThat(page: Page) {
        this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'Trying to complete ThisOrThat')

        try {
            // Pre-start human-like delay (use DELAYS if provided, otherwise random 1-3s)
            const preStartMin = (DELAYS && typeof DELAYS.THIS_OR_THAT_PRE_START_MIN === 'number') ? DELAYS.THIS_OR_THAT_PRE_START_MIN : ThisOrThat.DEFAULT_PRE_START_MIN
            const preStartMax = (DELAYS && typeof DELAYS.THIS_OR_THAT_PRE_START_MAX === 'number') ? DELAYS.THIS_OR_THAT_PRE_START_MAX : ThisOrThat.DEFAULT_PRE_START_MAX
            await this.bot.utils.wait(this.bot.utils.randomNumber(preStartMin, preStartMax))

            // Check if the quiz has been started or not
            const quizNotStarted = await page.waitForSelector('#rqStartQuiz', { state: 'visible', timeout: ThisOrThat.START_TIMEOUT }).then(() => true).catch(() => false)
            if (quizNotStarted) {
                // small human-like pause before clicking start
                await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))

                const started = await this.robustClick(page, '#rqStartQuiz', 3, 8000)
                if (!started) {
                    this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'Failed to click #rqStartQuiz (falling back to direct click)', 'warn')
                    try { await page.click('#rqStartQuiz') } catch { /* ignore */ }
                }
            } else {
                this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'ThisOrThat has already been started, trying to finish it')
            }

            // Wait a little after starting
            const afterStart = ThisOrThat.AFTER_START_WAIT
            await this.bot.utils.wait(afterStart)

            // Solving: prefer shared helper when available
            let quizData: any = null
            try { quizData = await this.bot.browser.func.getQuizData(page) } catch { quizData = null }
            if (!quizData) {
                // best-effort attempt to read quizData from DOM
                try {
                    quizData = await page.evaluate(() => {
                        // attempt to read minimal fields
                        // @ts-ignore
                        const wri = (window as any).rewardsQuizRenderInfo;
                        if (wri) return { maxQuestions: wri.maxQuestions, currentQuestionNumber: wri.currentQuestionNumber };
                        const max = (document.querySelectorAll('#rqAnswerOption').length) || undefined
                        return { maxQuestions: max, currentQuestionNumber: 1 }
                    })
                } catch { quizData = null }
            }

            if (!quizData || typeof quizData.maxQuestions !== 'number' || typeof quizData.currentQuestionNumber !== 'number') {
                this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'Could not determine quiz structure — attempting best-effort random completion', 'warn')
                // fallback: make a reasonable guess (try up to 6 answers)
                const guessMax = 6
                for (let attempt = 0; attempt < guessMax; attempt++) {
                    // human-like pauses
                    await this.bot.utils.wait(this.bot.utils.randomNumber(ThisOrThat.DEFAULT_BEFORE_ANSWER_MIN, ThisOrThat.DEFAULT_BEFORE_ANSWER_MAX))
                    const selected = `#rqAnswerOption${Math.floor(this.bot.utils.randomNumber(0, 1))}`
                    await this.robustClick(page, selected, 2, 8000)
                    const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page).catch(() => false)
                    if (!refreshSuccess) break
                    await this.bot.utils.wait(this.bot.utils.randomNumber(ThisOrThat.DEFAULT_AFTER_ANSWER_MIN, ThisOrThat.DEFAULT_AFTER_ANSWER_MAX))
                }

                try { await page.close() } catch {}
                this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'Completed the ThisOrThat (best-effort fallback)')
                return
            }

            const questionsRemaining = Math.max(0, quizData.maxQuestions - (quizData.currentQuestionNumber - 1))

            for (let question = 0; question < questionsRemaining; question++) {
                // Human-like delay before answering
                const beforeAnswerMin = (DELAYS && typeof DELAYS.THIS_OR_THAT_BEFORE_ANSWER_MIN === 'number') ? DELAYS.THIS_OR_THAT_BEFORE_ANSWER_MIN : ThisOrThat.DEFAULT_BEFORE_ANSWER_MIN
                const beforeAnswerMax = (DELAYS && typeof DELAYS.THIS_OR_THAT_BEFORE_ANSWER_MAX === 'number') ? DELAYS.THIS_OR_THAT_BEFORE_ANSWER_MAX : ThisOrThat.DEFAULT_BEFORE_ANSWER_MAX
                await this.bot.utils.wait(this.bot.utils.randomNumber(beforeAnswerMin, beforeAnswerMax))

                // Since there's no solving logic yet, randomly guess to complete
                const choiceIndex = Math.floor(this.bot.utils.randomNumber(0, 1))
                const buttonId = `#rqAnswerOption${choiceIndex}`

                // Small pause before clicking
                const beforeClickMin = (DELAYS && typeof DELAYS.THIS_OR_THAT_BEFORE_CLICK_MIN === 'number') ? DELAYS.THIS_OR_THAT_BEFORE_CLICK_MIN : ThisOrThat.DEFAULT_BEFORE_CLICK_MIN
                const beforeClickMax = (DELAYS && typeof DELAYS.THIS_OR_THAT_BEFORE_CLICK_MAX === 'number') ? DELAYS.THIS_OR_THAT_BEFORE_CLICK_MAX : ThisOrThat.DEFAULT_BEFORE_CLICK_MAX
                await this.bot.utils.wait(this.bot.utils.randomNumber(beforeClickMin, beforeClickMax))

                const clickedOk = await this.robustClick(page, buttonId, 3, 8000)
                if (!clickedOk) {
                    this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', `Could not click ${buttonId} after retries`, 'warn')
                }

                const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page).catch(() => false)
                if (!refreshSuccess) {
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))
                    try { await page.close() } catch {}
                    this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'An error occurred, refresh was unsuccessful', 'error')
                    return
                }

                // Human-like delay after answering
                const afterAnswerMin = (DELAYS && typeof DELAYS.THIS_OR_THAT_AFTER_ANSWER_MIN === 'number') ? DELAYS.THIS_OR_THAT_AFTER_ANSWER_MIN : ThisOrThat.DEFAULT_AFTER_ANSWER_MIN
                const afterAnswerMax = (DELAYS && typeof DELAYS.THIS_OR_THAT_AFTER_ANSWER_MAX === 'number') ? DELAYS.THIS_OR_THAT_AFTER_ANSWER_MAX : ThisOrThat.DEFAULT_AFTER_ANSWER_MAX
                await this.bot.utils.wait(this.bot.utils.randomNumber(afterAnswerMin, afterAnswerMax))
            }

            // Final human-like delay before finishing
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000))

            try { await page.close() } catch {}
            this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'Completed the ThisOrThat successfully')
        } catch (error) {
            // Human-like delay before closing on error
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))
            try { await page.close() } catch {}
            this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'An error occurred:' + error, 'error')
        }
    }

    /**
     * Small robust click helper used inside this worker. Attempts locator click, evaluate fallback and center mouse click.
     */
    private async robustClick(page: Page, selector: string, maxAttempts = 3, timeout = 5000): Promise<boolean> {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const locator = page.locator(selector).first()
                const visible = await locator.isVisible().catch(() => false)
                if (!visible) {
                    // try a quick attach check
                    await page.waitForSelector(selector, { state: 'attached', timeout: 500 }).catch(() => null)
                }

                await locator.click({ timeout }).catch(async (err) => {
                    // try DOM click fallback
                    const ok = await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null;
                        if (!el) return false;
                        el.click();
                        return true;
                    }, selector).catch(() => false)

                    if (!ok) {
                        // try center mouse click on bounding box
                        const h = await page.$(selector as any)
                        const box = h ? await h.boundingBox() : null
                        if (box) {
                            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
                        } else {
                            throw err
                        }
                    }
                })

                return true
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', `robustClick attempt ${attempt}/${maxAttempts} for ${selector} failed: ${e}`, 'warn')
                await this.tryCloseOverlays(page)
                await this.bot.utils.wait(200 + this.bot.utils.randomNumber(0, 800))
            }
        }
        return false
    }

    // Reuse a conservative overlay closer used across workers
    private async tryCloseOverlays(page: Page) {
        try {
            const overlayCloseSelectors = [
                'button[aria-label="Close"]',
                'button[title="Close"]',
                '.modal .close',
                '.ms-Callout-beakCurtain',
                '.more_btn_popup .close',
                '.close-button',
                '.dialog .close',
                '.overlay .close',
                '.callout .close'
            ]

            for (const sel of overlayCloseSelectors) {
                try {
                    const loc = page.locator(sel).first()
                    const count = await loc.count().catch(() => 0)
                    if (count) {
                        if (await loc.isVisible().catch(() => false)) {
                            await loc.click({ timeout: 2000 }).catch(() => {})
                            await this.bot.utils.wait(120)
                        }
                    }
                } catch { /* ignore */ }
            }

            // safe corner click
            try { await page.mouse.click(6, 6) } catch {}
        } catch { /* swallow */ }
    }
}
