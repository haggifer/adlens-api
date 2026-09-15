// ffprobe-static ships no types; it default-exports the bundled binary's path.
declare module 'ffprobe-static' {
    const ffprobe: { path: string }
    export default ffprobe
}
