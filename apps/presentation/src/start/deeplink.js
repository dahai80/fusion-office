// Deep-link hand-off (issue #6): another Fusion module, such as fusion-design,
// opens the library with the describe-your-presentation box already filled:
//
//   #/home?prompt=<urlencoded>&source=<module>
//
// The prompt is prepared, not run: writing the deck stays a user action,
// because it spends model calls. `source` is for the log only.

/** { prompt, source } for a #/home deep link carrying a prompt, else null. */
export function parseHomePrompt(hash = window.location.hash) {
    const m = /^#\/home\?(.*)$/.exec(String(hash || ""));
    if (!m) return null;
    const params = new URLSearchParams(m[1]);
    const prompt = (params.get("prompt") || "").slice(0, 4000);
    if (!prompt) return null;
    return { prompt, source: (params.get("source") || "").slice(0, 200) };
}
