import { Workers } from '../../Workers'

// Candidate server-action names that claim all available bonus points.
// Microsoft renames these across bundle releases, so we try known aliases,
// then fall back to a fuzzy name search when none match exactly.
const CLAIM_ALL_ACTION_NAMES = [
    'reportClaimAllPoints',
    'claimAllPoints',
    'reportClaimReward',
    'reportClaimPoints',
    'claimAllRewards',
    'reportBonusPoints',
    'claimBonusPoints'
]

export class ClaimBonusPoints extends Workers {
    public async claimBonusPoints() {
        const resolved = this.resolveActionId()
        if (!resolved) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Skipping: "claimAllPoints" action id not discovered in bundle (looked for [${CLAIM_ALL_ACTION_NAMES.join(', ')}] + any "*claim*all*" key) - trying DOM click fallback`
            )

            await this.claimReadyPointsViaDom()
            return
        }
        const actionId = resolved.id

        const oldBalance = this.bot.userData.currentPoints

        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `Starting ClaimBonusPoints | geo=${this.bot.userData.geoLocale} | currentBalance=${oldBalance}`
        )

        try {
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(actionId, [])

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            const gainedPoints = newBalance - oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Response | status=${status} | acknowledged=${acknowledged} | previousBalance=${oldBalance} | currentBalance=${newBalance} | pointsGained=${gainedPoints}`
            )

            if (acknowledged) {
                // If the server action did not actually credit points, fall back to the DOM path
                if (gainedPoints <= 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'CLAIM-BONUS-POINTS',
                        `Server action acknowledged but no points gained - trying DOM click fallback | status=${status}`
                    )
                    await this.claimReadyPointsViaDom()
                    return
                }

                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Completed ClaimBonusPoints | acknowledged=true | pointsGained=${gainedPoints} | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Nothing claimed | status=${status} | pointsGained=0 | currentBalance=${newBalance}`
                )
            }

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Error in claimBonusPoints | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    /**
     * DOM-based fallback (ported from the older Val-tracker build):
     * 1. Find the "Ready to claim" card
     * 2. Click it to open the claim dialog/side panel
     * 3. Within the dialog, click the "Claim points" button
     * This bypasses the need for a discovered server-action id, so it still works
     * when Microsoft renames/removes the bundle action.
     */
    private async claimReadyPointsViaDom(): Promise<boolean> {
        try {
            const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
            if (!page || page.isClosed()) {
                this.bot.logger.warn(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'DOM fallback: no active page')
                return false
            }

            this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'DOM fallback: opening claim panel')

            // 1. Open the "Ready to claim" card (case-insensitive)
            const readyCard = page.locator('text=/ready to claim/i').first()
            if (!(await readyCard.isVisible().catch(() => false))) {
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'DOM fallback: no claim card found')
                return false
            }

            await readyCard.click()
            await this.bot.utils.wait(this.bot.utils.humanActivityDelay())

            // 2. Scope to the claim dialog / side panel if present
            const dialog = page
                .locator('[role="dialog"], [role="sidebar"], [class*="claim"][class*="panel"]')
                .first()

            const dialogVisible = await dialog.isVisible().catch(() => false)

            if (dialogVisible) {
                // 3. Detect "nothing to claim"
                if (await dialog.locator('text=/no points to claim/i').isVisible().catch(() => false)) {
                    this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'DOM fallback: nothing to claim')
                    await page.goBack().catch(() => {})
                    return false
                }

                // 4. Click the "Claim points" button inside the dialog
                const claimBtn = dialog
                    .getByRole('button', { name: /claim points/i })
                    .or(dialog.locator('button:has-text("Claim points")'))
                    .first()

                if (!(await claimBtn.isVisible().catch(() => false))) {
                    this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'DOM fallback: claim button not found')
                    await page.goBack().catch(() => {})
                    return false
                }

                await claimBtn.click()
                await this.bot.utils.wait(this.bot.utils.humanActivityDelay())
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'DOM fallback: claim successful', 'green')
                return true
            }

            // Fallback: generic "Claim" button on the page (no dialog scope)
            const genericClaim = page
                .getByRole('button', { name: /claim points|claim all|claim/i })
                .or(page.locator('button:has-text("Claim")'))
                .first()
            if (await genericClaim.isVisible().catch(() => false)) {
                await genericClaim.click()
                await this.bot.utils.wait(this.bot.utils.humanActivityDelay())
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'DOM fallback: generic claim clicked', 'green')
                return true
            }

            this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'DOM fallback: nothing claimable found')
            return false
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `DOM fallback skipped: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    /**
     * Locate the server-action id that claims all bonus points.
     * Tries every known alias first, then fuzzy-matches the discovered
     * action names so a Microsoft bundle rename still resolves.
     */
    private resolveActionId(): { name: string; id: string } | null {
        const actions = this.bot.nextActions

        for (const name of CLAIM_ALL_ACTION_NAMES) {
            const id = actions[name]
            if (id) return { name, id }
        }

        const fuzzy = Object.keys(actions).find(
            k => /claim/i.test(k) && /(?:all|every|point|bonus|reward)/i.test(k)
        )
        if (fuzzy) return { name: fuzzy, id: actions[fuzzy]! }

        return null
    }
}
