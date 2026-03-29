import ms, { StringValue } from 'ms'

export default class Util {
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
            const j = Math.floor(Math.random() * (i + 1))

            const a = array[i]
            const b = array[j]

            if (a === undefined || b === undefined) continue

            array[i] = b
            array[j] = a
        }

        return array
    }

    randomNumber(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min
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

    // Human-like typing delay (50-150ms per keystroke with occasional pauses)
    humanTypingDelay(): number {
        // 10% chance of a longer pause (simulating thinking)
        if (Math.random() < 0.1) {
            return this.randomNumber(200, 400)
        }
        return this.randomNumber(50, 150)
    }

    // Human-like page load delay (1.5-3 seconds)
    humanPageLoadDelay(): number {
        return this.randomNumber(1500, 3000)
    }

    // Human-like form input delay (800-1500ms before/after inputs)
    humanFormInputDelay(): number {
        return this.randomNumber(800, 1500)
    }

    // Human-like scroll delay (500-1000ms between scrolls)
    humanScrollDelay(): number {
        return this.randomNumber(500, 1000)
    }

    // Human-like click delay (200-500ms before clicking)
    humanClickDelay(): number {
        return this.randomNumber(200, 500)
    }

    // Human-like hover delay (300-600ms before hovering)
    humanHoverDelay(): number {
        return this.randomNumber(300, 600)
    }

    // Human-like activity delay (2-4 seconds between activities)
    humanActivityDelay(): number {
        return this.randomNumber(2000, 4000)
    }

    // Human-like navigation delay (1-2 seconds after navigation)
    humanNavigationDelay(): number {
        return this.randomNumber(1000, 2000)
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
