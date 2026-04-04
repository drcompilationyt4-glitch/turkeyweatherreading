import ms, { StringValue } from 'ms'
import { randomInt } from 'crypto'

export default class Util {
    // Cryptographically secure random float between 0 and 1
    private cryptoRandom(): number {
        return randomInt(0, 1000000) / 1000000
    }

    // Cryptographically secure random integer between min and max (inclusive)
    private cryptoRandomInt(min: number, max: number): number {
        return randomInt(min, max + 1)
    }
    async wait(time: number | string): Promise<void> {
        if (typeof time === 'string') {
            time = this.stringToNumber(time)
        }

        return new Promise<void>(resolve => {
            setTimeout(resolve, time)
        })
    }

    getFormattedDate(ms = Date.now()): string {
        const today = new Date(ms)
        const month = String(today.getMonth() + 1).padStart(2, '0') // January is 0
        const day = String(today.getDate()).padStart(2, '0')
        const year = today.getFullYear()

        return `${month}/${day}/${year}`
    }

    shuffleArray<T>(array: T[]): T[] {
        for (let i = array.length - 1; i > 0; i--) {
            const j = this.cryptoRandomInt(0, i)

            const a = array[i]
            const b = array[j]

            if (a === undefined || b === undefined) continue

            array[i] = b
            array[j] = a
        }

        return array
    }

    randomNumber(min: number, max: number): number {
        return this.cryptoRandomInt(min, max)
    }

    chunkArray<T>(arr: T[], numChunks: number): T[][] {
        const chunkSize = Math.ceil(arr.length / numChunks)
        const chunks: T[][] = []

        for (let i = 0; i < arr.length; i += chunkSize) {
            const chunk = arr.slice(i, i + chunkSize)
            chunks.push(chunk)
        }

        return chunks
    }

    stringToNumber(input: string | number): number {
        if (typeof input === 'number') {
            return input
        }
        const value = input.trim()

        const milisec = ms(value as StringValue)

        if (milisec === undefined) {
            throw new Error(
                `The input provided (${input}) cannot be parsed to a valid time! Use a format like "1 min", "1m" or "1 minutes"`
            )
        }

        return milisec
    }

    normalizeString(string: string): string {
        return string
            .normalize('NFD')
            .trim()
            .toLowerCase()
            .replace(/[^\x20-\x7E]/g, '')
            .replace(/[?!]/g, '')
    }

    getEmailUsername(email: string): string {
        return email.split('@')[0] ?? 'Unknown'
    }

    randomDelay(min: string | number, max: string | number): number {
        const minMs = typeof min === 'number' ? min : this.stringToNumber(min)
        const maxMs = typeof max === 'number' ? max : this.stringToNumber(max)
        return Math.floor(this.randomNumber(minMs, maxMs))
    }

    // Human-like typing delay (200-500ms per keystroke - slow one-finger typist)
    humanTypingDelay(): number {
        // 30% chance of a longer pause (simulating thinking/looking for key)
        if (this.cryptoRandom() < 0.30) {
            return this.randomNumber(1000, 2000)
        }
        // 10% chance of very long pause (looking for key on keyboard)
        if (this.cryptoRandom() < 0.10) {
            return this.randomNumber(2000, 4000)
        }
        return this.randomNumber(200, 500)
    }

    // Human-like page load delay (20-45 seconds - simulating slow internet)
    humanPageLoadDelay(): number {
        return this.randomNumber(20000, 45000)
    }

    // Human-like form input delay (3-6 seconds before/after inputs - slow form filling)
    humanFormInputDelay(): number {
        return this.randomNumber(3000, 6000)
    }

    // Human-like scroll delay (2-4 seconds between scrolls - slow scrolling)
    humanScrollDelay(): number {
        return this.randomNumber(2000, 4000)
    }

    // Human-like click delay (1500-3000ms before clicking - slow deliberate clicking)
    humanClickDelay(): number {
        return this.randomNumber(1500, 3000)
    }

    // Human-like hover delay (400-800ms before hovering)
    humanHoverDelay(): number {
        return this.randomNumber(400, 800)
    }

    // Human-like activity delay (8-15 seconds between activities - slow transitions)
    humanActivityDelay(): number {
        return this.randomNumber(8000, 15000)
    }

    // Human-like navigation delay (10-20 seconds after navigation - slow internet)
    humanNavigationDelay(): number {
        return this.randomNumber(10000, 20000)
    }

    // Random distraction pause (5-15 seconds occasionally)
    humanDistractionPause(): number {
        return this.randomNumber(5000, 15000)
    }

    // Check if should take a distraction break (15% chance)
    shouldTakeDistractionBreak(): boolean {
        return this.cryptoRandom() < 0.15
    }

    // Human-like reading time based on content length
    humanReadingTime(contentLength: number): number {
        // Average reading speed: 200-300 words per minute
        // Assume ~5 characters per word
        const words = contentLength / 5
        const readingTimeMs = (words / 250) * 60 * 1000 // 250 wpm average
        return this.randomNumber(Math.max(2000, readingTimeMs * 0.8), readingTimeMs * 1.2)
    }

    // Human-like search query delay (varies by query length)
    humanSearchQueryDelay(queryLength: number): number {
        // Longer queries take more time to "think" about
        const baseDelay = Math.min(queryLength * 30, 500)
        return this.randomNumber(baseDelay, baseDelay + 500)
    }

    // Natural typing with variable speed
    async typeHumanLike(page: any, selector: string, text: string): Promise<void> {
        const element = await page.locator(selector)
        await element.click()
        
        for (const char of text) {
            await page.keyboard.type(char, { delay: this.humanTypingDelay() })
        }
    }
}
