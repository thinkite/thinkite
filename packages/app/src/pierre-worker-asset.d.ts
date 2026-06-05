// `.pwt` = Pierre worker-portable.js vendored as a Metro asset (see
// metro.config.js + scripts/sync-pierre-worker.mjs). Importing it yields an
// asset module ref suitable for `Asset.fromModule(...)`.
declare module "*.pwt" {
  const asset: number;
  export default asset;
}
