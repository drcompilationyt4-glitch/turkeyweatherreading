import axios from 'axios'

// OpenRouter retires or paywalls ':free' slugs without notice (they answer HTTP 404), so a hard-coded
// list silently stops producing queries. Resolve the configured list against what is free *right now*.

interface OpenRouterModel {
    id: string
    context_length?: number
    pricing?: { prompt?: string; completion?: string }
    architecture?: { input_modalities?: string[]; output_modalities?: string[] }
}

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_CANDIDATES = 8
const MIN_CONTEXT = 8000

// Families that reliably follow a "return a JSON list" prompt; used only to order unfamiliar free models
const PREFERRED_FAMILIES = /llama-[34]|gemma-\d|qwen-?\d|deepseek|mistral|gpt-oss|nemotron|glm|kimi|hermes/i
// Classifiers and non-chat models answer with labels, not queries
const UNSUITABLE = /embed|guard|safety|moderat|classif|rerank|whisper|tts|audio|image|vision|-vl\b|-vl:/i

let cache: { at: number; ids: string[] } | null = null
let inFlight: Promise<string[]> | null = null

const isZero = (value?: string) => value !== undefined && Number(value) === 0

async function fetchFreeModelIds(): Promise<string[]> {
    const response = await axios.get<{ data: OpenRouterModel[] }>(MODELS_URL, { timeout: 15000, proxy: false })
    const models = Array.isArray(response.data?.data) ? response.data.data : []

    return models
        .filter(
            model =>
                typeof model.id === 'string' &&
                model.id.endsWith(':free') &&
                isZero(model.pricing?.prompt) &&
                isZero(model.pricing?.completion) &&
                (model.context_length ?? 0) >= MIN_CONTEXT &&
                !UNSUITABLE.test(model.id) &&
                (!model.architecture?.output_modalities || model.architecture.output_modalities.includes('text')) &&
                (!model.architecture?.input_modalities || model.architecture.input_modalities.includes('text'))
        )
        .sort((a, b) => {
            const family = Number(PREFERRED_FAMILIES.test(b.id)) - Number(PREFERRED_FAMILIES.test(a.id))
            return family || (b.context_length ?? 0) - (a.context_length ?? 0)
        })
        .map(model => model.id)
}

/**
 * Returns model ids to try, in order: configured models that are still free, then other currently-free
 * models. Falls back to the configured list unchanged if OpenRouter's catalogue can't be reached.
 */
export async function resolveFreeModels(configured: string[], log?: (message: string) => void): Promise<string[]> {
    let freeIds: string[] | null = null

    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
        freeIds = cache.ids
    } else {
        try {
            inFlight ??= fetchFreeModelIds()
            freeIds = await inFlight
            if (freeIds.length) cache = { at: Date.now(), ids: freeIds }
        } catch (error) {
            log?.(`Could not load OpenRouter model list, using configured models | ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            inFlight = null
        }
    }

    if (!freeIds || freeIds.length === 0) return configured

    const free = new Set(freeIds)
    const stillFree = configured.filter(id => free.has(id))
    const dropped = configured.filter(id => !free.has(id))
    if (dropped.length) log?.(`Configured models no longer free, skipping: ${dropped.join(', ')}`)

    const ordered = [...stillFree, ...freeIds.filter(id => !stillFree.includes(id))].slice(0, MAX_CANDIDATES)
    log?.(`Free models to try: ${ordered.join(', ')}`)
    return ordered
}

/** Weighted pick among configured models that are still available; otherwise a random top candidate. */
export function pickModel(available: string[], weighted: Array<{ name: string; weight: number }>): string {
    const usable = weighted.filter(model => available.includes(model.name))
    const total = usable.reduce((sum, model) => sum + model.weight, 0)

    if (usable.length && total > 0) {
        let roll = Math.random() * total
        for (const model of usable) {
            roll -= model.weight
            if (roll <= 0) return model.name
        }
        return usable[usable.length - 1]!.name
    }

    const top = available.slice(0, 3)
    return top[Math.floor(Math.random() * top.length)] ?? available[0] ?? weighted[0]?.name ?? ''
}
