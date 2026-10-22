export const countedRuns = (cutoff: Date) => ({
    $filter: { input: { $ifNull: ['$runs', []] }, cond: { $gt: ['$$this.startedAt', cutoff] } },
})
