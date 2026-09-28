// The runs that still count: those started after the cutoff. Shared by QuotaService and IpQuotaService, which both
// count a document's runs within a rolling window using the same aggregation shape.
export const countedRuns = (cutoff: Date) => ({
    $filter: { input: { $ifNull: ['$runs', []] }, cond: { $gt: ['$$this.startedAt', cutoff] } },
})
