// The model the person picked for this app, kept across sessions. Empty means
// "follow the shell preference, or the default". Each app is its own origin
// (its own dev port or shell path), so the choice is per app, which is what a
// person expects.

import { shellModel } from './shell-model.js'
import { applyPolicyToModels } from './model-policy.js'

const STORAGE_KEY = 'fusion-office.ai-model'

export function getSelectedModel() {
    try {
        return localStorage.getItem(STORAGE_KEY) || ''
    } catch (err) {
        return ''
    }
}

export function setSelectedModel(id) {
    try {
        if (id) localStorage.setItem(STORAGE_KEY, id)
        else localStorage.removeItem(STORAGE_KEY)
    } catch (err) {
        // A blocked localStorage just means the choice does not survive a reload.
    }
}

function options(models, selected, fallback) {
    const ids = new Set(models.map(m => m.id))
    const list = [...models]
    if (selected && !ids.has(selected)) list.unshift({ id: selected, loaded: false })
    if (!list.some(m => m.id === fallback)) list.unshift({ id: fallback, loaded: false })
    return list
}

function fill(select, models, fallback, policy) {
    // The policy allowlist (and privacy_mode local_only) constrains what the
    // picker offers; with no stored choice the shell preference wins, then
    // the policy-resolved model, then a loaded model.
    const allowed = applyPolicyToModels(models, policy)
    const loaded = allowed.find(m => m.loaded)
    const selected = getSelectedModel() || shellModel() || (policy && policy.resolvedModel) || loaded?.id || fallback
    const list = options(allowed, selected, fallback)
    const sorted = [...list].sort((a, b) => (b.loaded ? 1 : 0) - (a.loaded ? 1 : 0) || a.id.localeCompare(b.id))
    select.replaceChildren(...sorted.map(m => {
        const option = document.createElement('option')
        option.value = m.id
        option.textContent = m.id + (m.loaded ? ' ✓' : '')
        return option
    }))
    select.value = selected
    select.title = selected
}

/**
 * A small select that lists the gateway's models and remembers the choice.
 * Returns null when AI is not configured, so callers can skip it entirely.
 */
export function createModelPicker({ onChange } = {}, deps = {}) {
    const { isConfigured, listModels, getConfig, logError, fetchPolicy } = deps
    if (!isConfigured || !isConfigured()) return null
    const select = document.createElement('select')
    select.className = 'ai-model-picker'
    select.setAttribute('aria-label', 'AI model')
    select.style.maxWidth = '150px'
    select.style.fontSize = '12px'
    select.style.textOverflow = 'ellipsis'
    fill(select, [], getConfig().defaultModel)
    Promise.all([listModels(), fetchPolicy ? fetchPolicy() : Promise.resolve(null)])
        .then(([models, policy]) => fill(select, models, getConfig().defaultModel, policy))
        .catch(err => logError?.('ai', 'model list unavailable', String(err).slice(0, 120)))
    select.addEventListener('change', () => {
        setSelectedModel(select.value)
        select.title = select.value
        onChange?.(select.value)
    })
    return select
}
