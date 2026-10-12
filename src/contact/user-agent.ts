// The browser and system in a User-Agent header, in the order a reader names them ("Chrome 154 · Android 10"). The
// first match wins, so the browsers that also say "Chrome" or "Safari" come first.
const BROWSERS: [RegExp, string][] = [
    [/EdgA?\/(\d+)/, 'Edge'],
    [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/OPR\/(\d+)/, 'Opera'],
    [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
    [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
    [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, 'Safari'],
]

const SYSTEMS: [RegExp, (match: RegExpExecArray) => string][] = [
    [/Android (\d+(?:\.\d+)?)/, (match) => `Android ${match[1]}`],
    [/(?:iPhone|CPU) OS (\d+)/, (match) => `iOS ${match[1]}`],
    [/Windows NT/, () => 'Windows'],
    [/CrOS/, () => 'ChromeOS'],
    [/Mac OS X/, () => 'macOS'],
    [/Linux/, () => 'Linux'],
]

// Long enough for any real header; a longer one is shown cut.
const RAW_MAX_LENGTH = 160

const findBrowser = (userAgent: string): string | null => {
    for (const [pattern, name] of BROWSERS) {
        const match = pattern.exec(userAgent)

        if (match) {
            return `${name} ${match[1]}`
        }
    }

    return null
}

const findSystem = (userAgent: string): string | null => {
    for (const [pattern, describe] of SYSTEMS) {
        const match = pattern.exec(userAgent)

        if (match) {
            return describe(match)
        }
    }

    return null
}

// "Chrome 154 · Android 10"; the header itself when neither part is recognised, and null without one.
export const describeUserAgent = (userAgent: string | undefined): string | null => {
    if (!userAgent) {
        return null
    }

    const parts = [findBrowser(userAgent), findSystem(userAgent)].filter((part) => part !== null)

    return parts.length ? parts.join(' · ') : userAgent.slice(0, RAW_MAX_LENGTH)
}
