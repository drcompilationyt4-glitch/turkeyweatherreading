import axios from 'axios'
import { XMLParser } from 'fast-xml-parser'

// Google's public trending RSS feed - far more stable than the internal batchexecute endpoint.
// Each <item> is one trend; its <ht:news_item_title> headlines become related queries.

export interface TrendTopic {
    topic: string
    related: string[]
}

const toArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])

const text = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
    if (value && typeof value === 'object' && '#text' in value) return String((value as { '#text': unknown })['#text']).trim()
    return ''
}

export async function fetchGoogleTrendsRss(geo: string): Promise<TrendTopic[]> {
    // "auto" or anything that isn't a 2-letter country code would return an empty feed
    const country = /^[a-z]{2}$/i.test(geo ?? '') ? geo.toUpperCase() : 'US'
    const response = await axios.get<string>(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(country)}`, {
        timeout: 15000,
        proxy: false,
        responseType: 'text',
        headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' }
    })

    const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false, htmlEntities: true }).parse(
        String(response.data ?? '')
    )
    const items = toArray(doc?.rss?.channel?.item)

    return items
        .map(item => {
            const record = item as Record<string, unknown>
            const related = toArray(record['ht:news_item'] as Record<string, unknown> | Record<string, unknown>[])
                .map(news => text(news?.['ht:news_item_title']))
                .filter(Boolean)
                .slice(0, 3)
            return { topic: text(record.title), related }
        })
        .filter(trend => trend.topic.length > 0)
}
