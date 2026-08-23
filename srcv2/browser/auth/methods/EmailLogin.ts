import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'

export class EmailLogin {
    private submitButton = 'button[type="submit"]'

    constructor(private bot: MicrosoftRewardsBot) {}

    async enterEmail(page: Page, email: string): Promise<'ok' | 'error'> {
        try {
            const emailInputSelector = 'input[type="email"]'
            const emailField = await page
                .waitForSelector(emailInputSelector, { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!emailField) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', 'Email field not found')
                return 'error'
            }

            await this.bot.utils.wait(1000)

            const prefilledEmail = await page
                .waitForSelector('#userDisplayName', { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!prefilledEmail) {
                await page.fill(emailInputSelector, '').catch(() => {})
                await this.bot.utils.wait(500)
                await page.fill(emailInputSelector, email).catch(() => {})
                await this.bot.utils.wait(1000)
            } else {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', 'Email prefilled')
            }

            await page.waitForSelector(this.submitButton, { state: 'visible', timeout: 2000 }).catch(() => {})

            await this.bot.browser.utils.ghostClick(page, this.submitButton)
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', 'Email submitted')

            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-EMAIL',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }

    async enterPassword(page: Page, password: string): Promise<'ok' | 'needs-2fa' | 'error'> {
        try {
            const passwordInputSelector = 'input[type="password"]'
            const passwordField = await page
                .waitForSelector(passwordInputSelector, { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!passwordField) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', 'Password field not found')
                return 'error'
            }

            await this.bot.utils.wait(1000)
            await page.fill(passwordInputSelector, '').catch(() => {})
            await this.bot.utils.wait(500)
            await page.fill(passwordInputSelector, password).catch(() => {})
            
            // Wait for slow typing to complete - calculate expected time based on password length
            // Using max delay of 500ms per character for slow typing
            const expectedTypingTime = password.length * 500
            const minWaitTime = Math.max(2000, expectedTypingTime) // At least 2 seconds
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', `Waiting ${minWaitTime}ms for slow typing to complete (${password.length} chars)`)
            await this.bot.utils.wait(minWaitTime)

            // Verify password is fully entered before clicking submit
            let passwordVerified = false
            const maxVerifyAttempts = 5
            for (let attempt = 0; attempt < maxVerifyAttempts; attempt++) {
                const currentValue = await page.inputValue(passwordInputSelector).catch(() => '')
                if (currentValue.length === password.length) {
                    passwordVerified = true
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', `Password verified: ${currentValue.length}/${password.length} chars`)
                    break
                }
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', `Password not fully entered yet: ${currentValue.length}/${password.length} chars (attempt ${attempt + 1}/${maxVerifyAttempts})`)
                await this.bot.utils.wait(500)
            }

            if (!passwordVerified) {
                const finalValue = await page.inputValue(passwordInputSelector).catch(() => '')
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', `Password verification failed: ${finalValue.length}/${password.length} chars - submitting anyway`)
            }

            const submitButton = await page
                .waitForSelector(this.submitButton, { state: 'visible', timeout: 2000 })
                .catch(() => null)

            if (submitButton) {
                await this.bot.browser.utils.ghostClick(page, this.submitButton)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', 'Password submitted')
            }

            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-PASSWORD',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }
}
