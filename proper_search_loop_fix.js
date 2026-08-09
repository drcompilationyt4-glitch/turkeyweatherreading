// ✅ ✅ ✅ PROPER SCROLL + CHECK LOOP - THIS IS WHAT YOU NEED TO REPLACE WITH ✅ ✅ ✅

// Remove old scroll code completely and put this instead:

let cardElement = null
const maxScrollAttempts = 45
const isDashboardPage = page.url().includes('rewards.bing.com/') && !page.url().includes('/earn')

// Start at absolute top
await page.evaluate(() => window.scrollTo(0, 0))
await this.bot.utils.wait(300)

for (let scrollIteration = 0; scrollIteration < maxScrollAttempts; scrollIteration++) {
    // Exit if found
    if (cardElement) break

    // ✅ CHECK DAILY SET TOGGLE ON EVERY SINGLE ITERATION (only on dashboard)
    if (isDashboardPage) {
        try {
            const dailySetToggle = page.locator('text=/Daily set/i').first()
                .locator('xpath=ancestor::*[contains(@class, "group") or contains(@class, "header")][1]')
                .locator('button')
                .filter({ hasNotText: /.+/ }) // Automatically filters out "See more tasks" button
                .first()

            if (await dailySetToggle.count() > 0 && await dailySetToggle.isVisible()) {
                const isExpanded = await dailySetToggle.getAttribute('aria-expanded').catch(() => 'true')
                
                if (isExpanded === 'false') {
                    this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Daily set is collapsed, expanding...')
                    await dailySetToggle.click({ timeout: 1500 }).catch(() => {})
                    await this.bot.utils.wait(750)
                }
            }
        } catch {}
    }

    // ✅ CHECK FOR OUR TARGET CARD NOW
    for (const selector of selectors) {
        try {
            const elements = page.locator(selector)
            const count = await elements.count()

            for (let i = 0; i < count; i++) {
                const el = elements.nth(i)

                if (await el.isVisible()) {
                    const text = await el.innerText().catch(() => '')
                    const href = await el.getAttribute('href').catch(() => null)

                    if (
                        text.toLowerCase().includes(activity.title.toLowerCase()) ||
                        (href && href.includes(activity.offerId))
                    ) {
                        cardElement = el
                        break
                    }
                }
            }
            if (cardElement) break
        } catch {}
    }

    // If found exit loop
    if (cardElement) break

    // Scroll tiny amount only
    await page.evaluate(() => window.scrollBy(0, 65 + Math.random() * 35))
    await this.bot.utils.wait(550)
}