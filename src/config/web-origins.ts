// A local dev server that finds its port taken (Next.js, the analysis lab) starts on the next free one, so a local web
// origin also allows the next few ports. Production allows exactly WEB_ORIGIN.
const LOCAL_EXTRA_PORTS = 5

export const allowedWebOrigins = (webOrigin: string): string[] => {
    const url = new URL(webOrigin)

    if (url.hostname !== 'localhost') {
        return [webOrigin]
    }

    const firstPort = Number(url.port)

    return Array.from(
        { length: LOCAL_EXTRA_PORTS + 1 },
        (_, offset) => `${url.protocol}//${url.hostname}:${firstPort + offset}`,
    )
}
