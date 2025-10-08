import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'


export class ThisOrThat extends Workers {

    async doThisOrThat(page: Page) {
        this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'Trying to complete ThisOrThat')

        try {
            // Human-like delay before starting (1-3 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

            // Check if the quiz has been started or not
            const quizNotStarted = await page.waitForSelector('#rqStartQuiz', { state: 'visible', timeout: 120000 }).then(() => true).catch(() => false)
            if (quizNotStarted) {
                // Human-like delay before clicking start (1-2 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))
                await page.click('#rqStartQuiz')
            } else {
                this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'ThisOrThat has already been started, trying to finish it')
            }

            // Human-like delay after starting/continuing (2-4 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000))

            // Solving
            const quizData = await this.bot.browser.func.getQuizData(page)
            const questionsRemaining = quizData.maxQuestions - (quizData.currentQuestionNumber - 1) // Amount of questions remaining

            for (let question = 0; question < questionsRemaining; question++) {
                // Human-like delay before answering (1-3 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

                // Since there's no solving logic yet, randomly guess to complete
                const buttonId = `#rqAnswerOption${Math.floor(this.bot.utils.randomNumber(0, 1))}`

                // Human-like delay before clicking (0.5-1.5 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

                await page.click(buttonId)

                const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page)
                if (!refreshSuccess) {
                    // Human-like delay before closing on error (1-2 seconds)
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))
                    await page.close()
                    this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'An error occurred, refresh was unsuccessful', 'error')
                    return
                }

                // Human-like delay after answering (2-5 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000))
            }

            // Human-like delay before completion (2-4 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000))

            this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'Completed the ThisOrThat successfully')
        } catch (error) {
            // Human-like delay before closing on error (1-2 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))
            await page.close()
            this.bot.log(this.bot.isMobile, 'THIS-OR-THAT', 'An error occurred:' + error, 'error')
        }
    }

}