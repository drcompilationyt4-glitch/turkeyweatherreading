import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const srcRoot = path.join(root, 'src')
const outRoot = path.join(root, 'dist')

// Assets copied verbatim from src (single source of truth) into dist.
// accounts.json + config.json are deliberately included so a rebuild always
// propagates the developer's settings rather than drifting from stale dist copies.
const assets = [
    { from: path.join(srcRoot, 'accounts.json'), to: path.join(outRoot, 'accounts.json') },
    { from: path.join(srcRoot, 'config.json'), to: path.join(outRoot, 'config.json') },
    {
        from: path.join(srcRoot, 'functions', 'search-queries.json'),
        to: path.join(outRoot, 'functions', 'search-queries.json')
    },
    {
        from: path.join(srcRoot, 'functions', 'bing-search-activity-queries.json'),
        to: path.join(outRoot, 'functions', 'bing-search-activity-queries.json')
    }
]

for (const { from, to } of assets) {
    if (!fs.existsSync(from)) {
        throw new Error(`Required build asset is missing: ${from}`)
    }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    console.log(`[info] Copied ${path.relative(root, from)} -> dist/`)
}
